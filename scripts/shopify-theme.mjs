#!/usr/bin/env node
/**
 * Shopify tema senkronizasyonu - Admin GraphQL API.
 *
 * Kullanim:
 *   node scripts/shopify-theme.mjs themes
 *   node scripts/shopify-theme.mjs pull   [--theme <id|main>] [--dir theme]
 *   node scripts/shopify-theme.mjs status [--theme <id|main>] [--dir theme]
 *   node scripts/shopify-theme.mjs push   [--theme <id>] [--dir theme] [--dry-run] [dosya...]
 *   node scripts/shopify-theme.mjs duplicate --theme <id|main> --name "Calisma kopyasi"
 *
 * Kimlik bilgileri ortam degiskenlerinden okunur (.env dosyasi da desteklenir).
 * Token asla arguman olarak gecirilmez, loglanmaz.
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

// --- yapilandirma -----------------------------------------------------------

async function loadDotEnv() {
  try {
    const raw = await readFile(new URL('../.env', import.meta.url), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // .env yoksa sorun degil, ortam degiskenlerine bakariz
  }
}

function config() {
  const store = process.env.SHOPIFY_STORE
  const token = process.env.SHOPIFY_ADMIN_TOKEN
  const version = process.env.SHOPIFY_API_VERSION || '2025-07'

  // SHOPIFY_PROXY_AUTH=1: token environment'in "API credentials" bolumunde tutulur
  // ve agent proxy tarafindan istek VM'den ciktiktan sonra eklenir. Bu modda token
  // session icinde hic bulunmaz - tercih edilen yol.
  const proxyAuth = process.env.SHOPIFY_PROXY_AUTH === '1'

  if (!store) fail('SHOPIFY_STORE tanimli degil. Ornek: uy2rpe-ni.myshopify.com')

  if (!proxyAuth) {
    if (!token) {
      fail(
        'SHOPIFY_ADMIN_TOKEN tanimli degil.\n' +
        '  Token\'i environment\'in "API credentials" bolumunde tutuyorsan\n' +
        '  SHOPIFY_PROXY_AUTH=1 ayarla; header\'i proxy ekler.'
      )
    }
    if (!token.startsWith('shpat_')) {
      fail(
        `SHOPIFY_ADMIN_TOKEN "shpat_" ile baslamiyor (verilen prefix: ${token.slice(0, 6)}...).\n` +
        '  "shpss_" bir app secret key\'dir, Admin API kimlik dogrulamasi icin kullanilamaz.\n' +
        '  Admin > Settings > Apps > Develop apps > [app] > API credentials > Admin API access token'
      )
    }
  }

  return {
    endpoint: `https://${store}/admin/api/${version}/graphql.json`,
    token: proxyAuth ? null : token,
    proxyAuth,
    store,
  }
}

function fail(msg) {
  console.error(`hata: ${msg}`)
  process.exit(1)
}

// --- API katmani ------------------------------------------------------------

async function gql(cfg, query, variables = {}, attempt = 0) {
  let res
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // proxyAuth modunda header'i agent proxy ekler
        ...(cfg.token ? { 'X-Shopify-Access-Token': cfg.token } : {}),
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch (err) {
    fail(
      `${cfg.store} adresine baglanilamadi: ${err.message}\n` +
      '  Bu ortamin ag politikasi disariya cikisi engelliyor olabilir.\n' +
      '  environment ayarlarindan bu domain\'e izin verilmesi gerekir.'
    )
  }

  if (res.status === 401 || res.status === 403) {
    // Shopify her yanita X-Request-Id koyar. Yoksa 403 Shopify'dan degil,
    // araya giren bir proxy / ag politikasindan geliyordur.
    if (!res.headers.get('x-request-id')) {
      fail(
        `${cfg.store} adresine giden istek ${res.status} ile reddedildi ve yanit Shopify'dan gelmedi.\n` +
        '  Muhtemel sebep: bu ortamin ag politikasi disariya cikisi engelliyor.\n' +
        `  environment ayarlarindan ${cfg.store} ve cdn.shopify.com domainlerine izin verilmesi gerekir.`
      )
    }
    fail(
      `API ${res.status} dondu - token gecersiz veya gerekli scope yok (read_themes / write_themes).` +
      (cfg.proxyAuth
        ? '\n  SHOPIFY_PROXY_AUTH=1 aktif: proxy header\'i ekleyemedi olabilir.\n' +
          '  environment > API credentials altinda header adinin X-Shopify-Access-Token\n' +
          '  oldugunu, prefix alaninin bos oldugunu ve host listesinde bu magazanin\n' +
          '  bulundugunu kontrol et.'
        : '')
    )
  }

  // Throttle: ustel geri cekilme ile en fazla 5 deneme
  if (res.status === 429 && attempt < 5) {
    const wait = 2 ** attempt * 1000
    console.error(`  throttled, ${wait}ms bekleniyor...`)
    await new Promise(r => setTimeout(r, wait))
    return gql(cfg, query, variables, attempt + 1)
  }

  const json = await res.json().catch(() => null)
  if (!json) fail(`API yanit govdesi ayristirilamadi (HTTP ${res.status}).`)

  if (json.errors?.length) {
    const throttled = json.errors.some(e => e.extensions?.code === 'THROTTLED')
    if (throttled && attempt < 5) {
      const wait = 2 ** attempt * 1000
      console.error(`  throttled, ${wait}ms bekleniyor...`)
      await new Promise(r => setTimeout(r, wait))
      return gql(cfg, query, variables, attempt + 1)
    }
    fail('GraphQL hatasi:\n  ' + json.errors.map(e => e.message).join('\n  '))
  }
  return json.data
}

const Q_THEMES = `
  query Themes {
    themes(first: 50) {
      nodes { id name role updatedAt }
    }
  }`

const Q_FILES = `
  query ThemeFiles($id: ID!, $after: String) {
    theme(id: $id) {
      id
      name
      role
      files(first: 250, after: $after) {
        nodes {
          filename
          size
          checksumMd5
          contentType
          body {
            __typename
            ... on OnlineStoreThemeFileBodyText { content }
            ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
            ... on OnlineStoreThemeFileBodyUrl { url }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`

const M_UPSERT = `
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { field filename message }
    }
  }`

const M_DUPLICATE = `
  mutation ThemeDuplicate($id: ID!, $name: String) {
    themeDuplicate(id: $id, name: $name) {
      theme { id name role }
      userErrors { field message }
    }
  }`

// --- yardimcilar ------------------------------------------------------------

const TEXT_EXT = new Set([
  '.liquid', '.json', '.js', '.mjs', '.css', '.scss', '.svg', '.txt', '.md', '.html', '.map',
])

const isText = f => TEXT_EXT.has(path.extname(f).toLowerCase())
const md5 = buf => createHash('md5').update(buf).digest('hex')

async function resolveTheme(cfg, ref) {
  const { themes } = await gql(cfg, Q_THEMES)
  if (!ref || ref === 'main' || ref === 'live') {
    const main = themes.nodes.find(t => t.role === 'MAIN')
    if (!main) fail('MAIN rolunde tema bulunamadi.')
    return main
  }
  const id = /^\d+$/.test(ref) ? `gid://shopify/OnlineStoreTheme/${ref}` : ref
  const found = themes.nodes.find(t => t.id === id)
  if (!found) {
    fail(`Tema bulunamadi: ${ref}\n  Mevcut olanlar:\n` +
      themes.nodes.map(t => `    ${t.id.split('/').pop()}  ${t.role.padEnd(12)} ${t.name}`).join('\n'))
  }
  return found
}

async function fetchAllFiles(cfg, themeId) {
  const files = []
  let after = null
  for (;;) {
    const data = await gql(cfg, Q_FILES, { id: themeId, after })
    if (!data.theme) fail('Tema okunamadi.')
    files.push(...data.theme.files.nodes)
    if (!data.theme.files.pageInfo.hasNextPage) break
    after = data.theme.files.pageInfo.endCursor
    process.stderr.write(`\r  ${files.length} dosya okundu...`)
  }
  if (files.length > 250) process.stderr.write('\n')
  return files
}

async function walkLocal(dir, base = dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await walkLocal(full, base))
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

// --- komutlar ---------------------------------------------------------------

async function cmdThemes(cfg) {
  const { themes } = await gql(cfg, Q_THEMES)
  console.log(`\n${cfg.store} - ${themes.nodes.length} tema\n`)
  for (const t of themes.nodes) {
    const id = t.id.split('/').pop()
    console.log(`  ${id.padEnd(14)} ${t.role.padEnd(12)} ${t.name}`)
  }
  console.log('\nMAIN = yayindaki tema. Canli temaya dogrudan yazma; once "duplicate" al.\n')
}

async function cmdPull(cfg, opts) {
  const theme = await resolveTheme(cfg, opts.theme)
  console.log(`indiriliyor: ${theme.name} (${theme.role}) -> ${opts.dir}/`)

  const files = await fetchAllFiles(cfg, theme.id)
  let written = 0, skipped = 0

  for (const f of files) {
    const dest = path.join(opts.dir, f.filename)
    await mkdir(path.dirname(dest), { recursive: true })

    let buf
    switch (f.body.__typename) {
      case 'OnlineStoreThemeFileBodyText':
        buf = Buffer.from(f.body.content, 'utf8'); break
      case 'OnlineStoreThemeFileBodyBase64':
        buf = Buffer.from(f.body.contentBase64, 'base64'); break
      case 'OnlineStoreThemeFileBodyUrl': {
        // Binary asset'ler CDN uzerinden gelir - cdn.shopify.com erisimi gerekir.
        const r = await fetch(f.body.url).catch(() => null)
        if (!r?.ok) { console.error(`  atlandi (CDN erisilemedi): ${f.filename}`); skipped++; continue }
        buf = Buffer.from(await r.arrayBuffer()); break
      }
      default:
        console.error(`  atlandi (bilinmeyen govde tipi): ${f.filename}`); skipped++; continue
    }
    await writeFile(dest, buf)
    written++
  }
  console.log(`tamam: ${written} dosya yazildi${skipped ? `, ${skipped} atlandi` : ''}.`)
}

async function cmdStatus(cfg, opts) {
  const theme = await resolveTheme(cfg, opts.theme)
  const remote = new Map((await fetchAllFiles(cfg, theme.id)).map(f => [f.filename, f]))
  const local = await walkLocal(opts.dir)

  const changed = [], added = []
  for (const rel of local) {
    const buf = await readFile(path.join(opts.dir, rel))
    const r = remote.get(rel)
    if (!r) { added.push(rel); continue }
    if (r.checksumMd5 && r.checksumMd5 !== md5(buf)) changed.push(rel)
  }
  const removed = [...remote.keys()].filter(f => !local.includes(f))

  console.log(`\n${theme.name} (${theme.role}) ile karsilastirma - ${opts.dir}/\n`)
  if (!changed.length && !added.length && !removed.length) {
    console.log('  fark yok.\n'); return
  }
  for (const f of changed) console.log(`  degisti  ${f}`)
  for (const f of added)   console.log(`  yeni     ${f}`)
  for (const f of removed) console.log(`  sadece uzakta  ${f}`)
  console.log(`\n  ${changed.length} degisti, ${added.length} yeni, ${removed.length} sadece uzakta\n`)
}

async function cmdPush(cfg, opts, only) {
  const theme = await resolveTheme(cfg, opts.theme)

  if (theme.role === 'MAIN' && !opts.allowLive) {
    fail(
      `"${theme.name}" yayindaki tema (MAIN). Canli temaya dogrudan yazmayi engelliyorum.\n` +
      '  Once bir kopya al:  node scripts/shopify-theme.mjs duplicate --theme main --name "Calisma"\n' +
      '  Bilerek yapiyorsan: --allow-live'
    )
  }

  const remote = new Map((await fetchAllFiles(cfg, theme.id)).map(f => [f.filename, f]))
  const candidates = only.length ? only : await walkLocal(opts.dir)

  const payload = []
  for (const rel of candidates) {
    const abs = path.join(opts.dir, rel)
    if (!(await stat(abs).catch(() => null))?.isFile()) { console.error(`  yok: ${rel}`); continue }
    const buf = await readFile(abs)
    const r = remote.get(rel)
    if (!only.length && r?.checksumMd5 === md5(buf)) continue  // degismemis, atla
    payload.push({
      filename: rel,
      body: isText(rel)
        ? { type: 'TEXT', value: buf.toString('utf8') }
        : { type: 'BASE64', value: buf.toString('base64') },
    })
  }

  if (!payload.length) { console.log('gonderilecek degisiklik yok.'); return }

  console.log(`\n${theme.name} (${theme.role}) <- ${payload.length} dosya\n`)
  for (const f of payload) console.log(`  ${f.filename}`)

  if (opts.dryRun) { console.log('\n--dry-run: hicbir sey gonderilmedi.\n'); return }

  // Shopify tek mutation'da sinirli sayida dosya kabul eder; 20'lik gruplar halinde gonder.
  let ok = 0
  for (let i = 0; i < payload.length; i += 20) {
    const batch = payload.slice(i, i + 20)
    const data = await gql(cfg, M_UPSERT, { themeId: theme.id, files: batch })
    const errs = data.themeFilesUpsert.userErrors
    if (errs.length) {
      for (const e of errs) console.error(`  HATA ${e.filename || e.field?.join('.') || ''}: ${e.message}`)
    }
    ok += data.themeFilesUpsert.upsertedThemeFiles.length
  }
  console.log(`\ntamam: ${ok}/${payload.length} dosya yazildi.\n`)
}

async function cmdDuplicate(cfg, opts) {
  const theme = await resolveTheme(cfg, opts.theme)
  const name = opts.name || `${theme.name} - calisma kopyasi`
  console.log(`kopyalaniyor: ${theme.name} -> "${name}"`)

  const data = await gql(cfg, M_DUPLICATE, { id: theme.id, name })
  const errs = data.themeDuplicate.userErrors
  if (errs.length) fail(errs.map(e => e.message).join('\n  '))

  const t = data.themeDuplicate.theme
  console.log(`\ntamam. yeni tema: ${t.id.split('/').pop()}  ${t.role}  ${t.name}`)
  console.log('Kopyalama arka planda surer; hemen ardindan pull cekersen eksik dosya gorebilirsin.\n')
}

// --- arguman ayristirma -----------------------------------------------------

function parseArgs(argv) {
  const opts = { dir: 'theme', dryRun: false, allowLive: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--theme') opts.theme = argv[++i]
    else if (a === '--dir') opts.dir = argv[++i]
    else if (a === '--name') opts.name = argv[++i]
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--allow-live') opts.allowLive = true
    else rest.push(a)
  }
  return { opts, rest }
}

const USAGE = `
Shopify tema senkronizasyonu

  themes                                    temalari listele
  pull      [--theme <id|main>] [--dir D]   temayi yerele indir
  status    [--theme <id|main>] [--dir D]   yerel ile uzak arasindaki farki goster
  push      [--theme <id>] [--dir D]        degisiklikleri gonder
            [--dry-run] [dosya...]
  duplicate --theme <id|main> --name "X"    tema kopyasi olustur

Ortam degiskenleri: SHOPIFY_STORE, SHOPIFY_API_VERSION
  Kimlik: SHOPIFY_ADMIN_TOKEN (shpat_...) veya SHOPIFY_PROXY_AUTH=1
`

async function main() {
  await loadDotEnv()
  const [cmd, ...argv] = process.argv.slice(2)
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(USAGE); return }

  const { opts, rest } = parseArgs(argv)
  const cfg = config()

  switch (cmd) {
    case 'themes':    return cmdThemes(cfg)
    case 'pull':      return cmdPull(cfg, opts)
    case 'status':    return cmdStatus(cfg, opts)
    case 'push':      return cmdPush(cfg, opts, rest)
    case 'duplicate': return cmdDuplicate(cfg, opts)
    default: fail(`bilinmeyen komut: ${cmd}\n${USAGE}`)
  }
}

main()
