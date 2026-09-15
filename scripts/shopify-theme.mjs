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
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'

// Node 22'nin global fetch'i HTTPS_PROXY'yi yalnizca NODE_USE_ENV_PROXY=1 ile,
// o da process baslangicinda okur - calisma aninda ayarlamak ise yaramaz.
// Proxy arkasindaki ortamlarda (Claude Code cloud session gibi) proxy'siz giden
// istek Shopify'a hic ulasmadan 403 alir ve bu "token gecersiz" gibi gorunur.
// Bu yuzden proxy tanimliysa kendimizi bir kez o degiskenle yeniden calistiriyoruz.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=UNDICI-EHPA', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } },
  )
  process.exit(r.status ?? 1)
}

// --- yapilandirma -----------------------------------------------------------

// Shopify her ceyrekte yeni surum yayinlar, her surum ~12 ay desteklenir.
// Desteksiz bir surum istenirse Shopify sessizce varsayilana "ileri duser" -
// istek calisir ama hangi sema uzerinde calistigi belirsiz kalir. Bu yuzden
// asagida bilinen son kararli surum tutulur ve yanitin surumu ile karsilastirilir.
// Guncel liste: https://shopify.dev/docs/api/usage/versioning
const API_VERSION = '2026-07'

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
  const version = process.env.SHOPIFY_API_VERSION || API_VERSION
  const token = process.env.SHOPIFY_ADMIN_TOKEN
  const clientId = process.env.SHOPIFY_CLIENT_ID
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET

  if (!store) fail('SHOPIFY_STORE tanimli degil. Ornek: uy2rpe-ni.myshopify.com')

  // Kimlik dogrulama modu. Oncelik sirasi bilerek boyle:
  //
  // 1. client_credentials - app'in kendi kimlik bilgileriyle (client id + secret)
  //    24 saatlik bir access token alinir. Kendini yeniledigi icin tercih edilen
  //    yoldur. Admin panelinden olusturulan custom app'ler artik yeni kayit
  //    kabul etmiyor; "kendiliginden uretilen" token bu grant'tan geliyor.
  // 2. token - elde hazir bir shpat_ token varsa dogrudan kullanilir (eski
  //    admin-created custom app'ler icin).
  // 3. proxy - token session icinde hic tutulmaz, agent proxy header'i ekler.
  let mode
  if (clientId && clientSecret) mode = 'client_credentials'
  else if (token) mode = 'token'
  else mode = 'proxy'

  if (mode === 'token' && !token.startsWith('shpat_')) {
    fail(
      `SHOPIFY_ADMIN_TOKEN "shpat_" ile baslamiyor (verilen prefix: ${token.slice(0, 6)}...).\n` +
      '  "shpss_" app secret key\'dir; Admin API\'ye dogrudan giris yapmaz ama\n' +
      '  SHOPIFY_CLIENT_SECRET olarak SHOPIFY_CLIENT_ID ile birlikte kullanilabilir -\n' +
      '  script o ikisinden kendisi token uretir.'
    )
  }

  if (mode === 'proxy' && process.env.SHOPIFY_PROXY_AUTH !== '1') {
    console.error(
      'not: kimlik bilgisi bulunamadi, header agent proxy\'den bekleniyor.\n' +
      '  .env icine SHOPIFY_CLIENT_ID ve SHOPIFY_CLIENT_SECRET yazmak en saglam yol.'
    )
  }

  return {
    endpoint: `https://${store}/admin/api/${version}/graphql.json`,
    tokenEndpoint: `https://${store}/admin/oauth/access_token`,
    token: mode === 'token' ? token : null,
    mode,
    proxyAuth: mode === 'proxy',
    clientId,
    clientSecret,
    store,
    version,
    versionWarned: false,
  }
}

// --- client_credentials grant ------------------------------------------------
//
// POST /admin/oauth/access_token ile app'in kendi kimlik bilgileri 24 saatlik
// bir access token'a cevrilir (merchant etkilesimi gerekmez). Token disk'e
// onbelleklenir; her komut yeni token istemez, suresi dolunca kendini yeniler.
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens

const TOKEN_CACHE = new URL('../.shopify-token.json', import.meta.url)
const TOKEN_SKEW_MS = 120_000  // suresi dolmadan 2 dk once yenile

// Onbellegi hangi app + magaza icin aldigimizi isaretler. Secret'in kendisi
// hicbir zaman diske yazilmaz, sadece parmak izi.
const fingerprint = cfg =>
  createHash('sha256').update(`${cfg.store}|${cfg.clientId}`).digest('hex').slice(0, 16)

async function readCachedToken(cfg) {
  try {
    const c = JSON.parse(await readFile(TOKEN_CACHE, 'utf8'))
    if (c.fingerprint !== fingerprint(cfg)) return null
    if (Date.now() + TOKEN_SKEW_MS >= c.expiresAt) return null
    return c
  } catch {
    return null
  }
}

async function requestToken(cfg) {
  let res
  try {
    res = await fetch(cfg.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: 'client_credentials',
      }),
    })
  } catch (err) {
    fail(
      `${cfg.store} token ucundan token alinamadi: ${err.message}\n` +
      '  Bu ortamin ag politikasi disariya cikisi engelliyor olabilir.'
    )
  }

  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.access_token) {
    fail(
      `token alinamadi (HTTP ${res.status}): ${json?.error_description || json?.error || 'bilinmeyen hata'}\n` +
      '  SHOPIFY_CLIENT_ID ve SHOPIFY_CLIENT_SECRET degerlerini kontrol et.\n' +
      '  Ikisi de Shopify Admin > Settings > Apps > [app] > API credentials altinda.\n' +
      '  App\'in bu magazaya kurulu ve read_themes/write_themes scope\'larina sahip olmasi gerekir.'
    )
  }

  const cache = {
    fingerprint: fingerprint(cfg),
    accessToken: json.access_token,
    scope: json.scope,
    expiresAt: Date.now() + (json.expires_in ?? 86399) * 1000,
  }
  // 0600: token yalnizca bu kullanici tarafindan okunabilsin.
  await writeFile(TOKEN_CACHE, JSON.stringify(cache, null, 2), { mode: 0o600 })
  return cache
}

async function resolveToken(cfg) {
  if (cfg.mode !== 'client_credentials') return
  const cached = await readCachedToken(cfg)
  const c = cached || await requestToken(cfg)
  cfg.token = c.accessToken
  cfg.scope = c.scope
  if (!cached) {
    const mins = Math.round((c.expiresAt - Date.now()) / 60000)
    console.error(`not: yeni token alindi (scope: ${c.scope}; ${mins} dk gecerli).`)
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
    // Onbellekteki token erken iptal edilmis olabilir (secret rotasyonu,
    // app'in yeniden kurulmasi). Bir kez taze token alip tekrar dene.
    if (cfg.mode === 'client_credentials' && !cfg.tokenRetried) {
      cfg.tokenRetried = true
      console.error('  token reddedildi, yenisi aliniyor...')
      const c = await requestToken(cfg)
      cfg.token = c.accessToken
      cfg.scope = c.scope
      return gql(cfg, query, variables, attempt)
    }

    fail(
      `API ${res.status} dondu - token gecersiz veya gerekli scope yok (read_themes / write_themes).` +
      (cfg.mode === 'client_credentials'
        ? `\n  Taze token da reddedildi. App bu magazaya kurulu mu ve scope'lari` +
          `\n  kaydedilmis mi kontrol et. Token'in scope'u: ${cfg.scope || '(bilinmiyor)'}`
        : '') +
      (cfg.proxyAuth
        ? '\n  Proxy modu aktif: proxy header\'i ekleyemedi olabilir.\n' +
          '  environment > API credentials altinda header adinin X-Shopify-Access-Token\n' +
          '  oldugunu, prefix alaninin bos oldugunu ve host listesinde bu magazanin\n' +
          '  bulundugunu kontrol et.\n' +
          '  Alternatif: .env icine SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET yaz.'
        : '')
    )
  }

  // Shopify kullanilan surumu yanit header'inda bildirir. Istedigimizden
  // farkliysa hedefledigimiz surum artik erisilebilir degil demektir.
  const served = res.headers.get('x-shopify-api-version')
  if (served && served !== cfg.version && !cfg.versionWarned) {
    cfg.versionWarned = true
    console.error(
      `not: ${cfg.version} surumu istendi ama Shopify ${served} ile yanitladi.\n` +
      `  Hedeflenen surum artik desteklenmiyor olabilir. SHOPIFY_API_VERSION=${served} ayarla\n` +
      '  veya scripts/shopify-theme.mjs icindeki API_VERSION sabitini guncelle.'
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
      newTheme { id name role }
      userErrors { field message }
    }
  }`

// --- yardimcilar ------------------------------------------------------------

const TEXT_EXT = new Set([
  '.liquid', '.json', '.js', '.mjs', '.css', '.scss', '.svg', '.txt', '.md', '.html', '.map',
])

const isText = f => TEXT_EXT.has(path.extname(f).toLowerCase())
const isJson = f => path.extname(f).toLowerCase() === '.json'
const md5 = buf => createHash('md5').update(buf).digest('hex')

// Shopify, otomatik uretilen JSON dosyalarini (config/settings_data.json,
// templates/*.json, locales/*.json) API'den dondururken iki sey yapar:
//   1. Basina "contents of this file are auto-generated" uyari yorumu ekler.
//   2. Icerigi yeniden bicimlendirir (depoda minified, donen halde girintili).
// checksumMd5 ise DEPODAKI hale aittir. Yani bu dosyalarda
// md5(donen govde) != checksumMd5 olur - dosya hic degismemis olsa bile.
//
// Yorumu ayiklamazsak yerele gecersiz JSON yazariz (JSON yorum kabul etmez).
// Bicimlendirme farkini da yok saymak gerekir, yoksa `status` taze bir
// pull'dan hemen sonra bile onlarca dosyayi "degismis" gosterir ve gercek
// degisiklikler bu gurultunun icinde kaybolur.
// Bazi dosyalarda banner'dan sonra satir sonu var, bazilarinda yok
// (".../ */{" seklinde dogrudan icerik gelir) - bu yuzden sondaki bosluk
// zorunlu degil.
const JSON_BANNER = /^\uFEFF?\s*\/\*[\s\S]*?\*\/\s*/

const stripJsonBanner = text => text.replace(JSON_BANNER, '')

// Tema JSON'lari yorum icerebilir - ozellikle locales/*.schema.json icinde
// "// Category for ..." satirlari vardir. JSON.parse bunlari kabul etmez.
// Dize icindeki // ve /* dizilerine (orn. "https://...") dokunmamak icin
// karakter karakter taranir. Sadece karsilastirma icin kullanilir; diske
// yazdigimiz icerige dokunmaz.
function stripJsonComments(text) {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length;) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') { out += c + (text[i + 1] ?? ''); i += 2; continue }
      if (c === '"') inStr = false
      out += c; i++; continue
    }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c; i++
  }
  return out
}

// Bicimlendirmeden bagimsiz karsilastirma icin JSON'i tek bir kanonik forma
// indirger. Anahtar sirasi korunur - gercek bir yeniden siralamayi gizlememek
// icin bilerek siralanmiyor. Ayristirilamiyorsa null doner ve cagiran taraf
// dosyayi "degismis" sayar (temkinli taraf).
function canonicalJson(text) {
  try {
    return JSON.stringify(JSON.parse(stripJsonComments(text)))
  } catch {
    return null
  }
}

// Yerel dosya uzaktakiyle ayni mi? Once ucuz yol (md5), JSON'da gerekirse
// kanonik karsilastirma.
function remoteMatches(rel, buf, r) {
  if (!r.checksumMd5) return true          // karsilastiracak sey yok
  if (r.checksumMd5 === md5(buf)) return true
  if (!isJson(rel)) return false
  if (r.body?.__typename !== 'OnlineStoreThemeFileBodyText') return false
  const a = canonicalJson(buf.toString('utf8'))
  return a !== null && a === canonicalJson(r.body.content)
}

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
      case 'OnlineStoreThemeFileBodyText': {
        const text = isJson(f.filename) ? stripJsonBanner(f.body.content) : f.body.content
        buf = Buffer.from(text, 'utf8'); break
      }
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
    if (!remoteMatches(rel, buf, r)) changed.push(rel)
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
    if (!only.length && r && remoteMatches(rel, buf, r)) continue  // degismemis, atla
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

  const t = data.themeDuplicate.newTheme
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
  Kimlik (oncelik sirasiyla):
    SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET  client_credentials grant,
                                               24 saatlik token, kendini yeniler
    SHOPIFY_ADMIN_TOKEN (shpat_...)            hazir token varsa
    SHOPIFY_PROXY_AUTH=1                       header'i agent proxy ekler
`

async function main() {
  await loadDotEnv()
  const [cmd, ...argv] = process.argv.slice(2)
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(USAGE); return }

  const { opts, rest } = parseArgs(argv)
  const cfg = config()
  await resolveToken(cfg)

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
