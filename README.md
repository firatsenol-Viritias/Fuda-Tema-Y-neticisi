# Fuda - Shopify Tema Yonetimi

`uy2rpe-ni.myshopify.com` magazasinin tema dosyalarini surum kontrolu altinda
tutmak ve Admin GraphQL API uzerinden senkronize etmek icin kullanilir.

## Kurulum

Token Shopify Admin'den alinir: Settings > Apps and sales channels
> Develop apps > [app] > API credentials > Admin API access token
(`shpat_` ile baslar). Gerekli scope'lar: `read_themes`, `write_themes`.

Token'i saklamanin iki yolu var.

### Yol 1 (tercih edilen): environment API credentials

Token cloud environment'in **API credentials** bolumunde durur. Agent proxy
header'i istek VM'den ciktiktan sonra ekler; token session icinde hicbir yerde
bulunmaz, ajan onu goremez.

claude.ai/code > mesaj kutusunun ustundeki bulut ikonu > environment'in dislisi
> **API credentials** > **Add credential**:

    Name             : Shopify Admin API
    Allowed websites : uy2rpe-ni.myshopify.com
    Custom header    : X-Shopify-Access-Token   (prefix alanini BOS birak)
    Value            : shpat_...

Sonra:

```bash
cp .env.example .env
# .env icinde SHOPIFY_PROXY_AUTH=1 satirini ac, SHOPIFY_ADMIN_TOKEN'i sil
```

Pro ve Max planlarinda mevcut; Team/Enterprise'da bu bolum gorunmez.

### Yol 2: .env dosyasi

```bash
cp .env.example .env
# .env icine SHOPIFY_ADMIN_TOKEN degerini yaz
```

`.env` gitignore'dadir, ama container icinde acik durur. Yol 1 mumkunse onu sec.
Token'i hicbir zaman commit etme.

## Kullanim

```bash
node scripts/shopify-theme.mjs themes                      # temalari listele
node scripts/shopify-theme.mjs duplicate --theme main \
     --name "Calisma kopyasi"                              # canli temanin kopyasini al
node scripts/shopify-theme.mjs pull --theme <id>           # dosyalari theme/ altina indir
node scripts/shopify-theme.mjs status --theme <id>         # yerel/uzak farki
node scripts/shopify-theme.mjs push --theme <id> --dry-run # ne gonderilecek, gostermeden once
node scripts/shopify-theme.mjs push --theme <id>           # degisiklikleri gonder
```

`push` yalnizca MD5'i degismis dosyalari gonderir. Dosya adi verirsen sadece
onlari gonderir.

## Calisma akisi

1. Canli temanin kopyasini al (`duplicate`)
2. Kopyayi indir (`pull`), degisiklikleri yap, commit et
3. `status` ile farki dogrula, `push --dry-run` ile ne gidecegini gor
4. `push` ile gonder, Shopify Admin'de preview linkinden kontrol et
5. Yayina alma (publish) **Admin panelinden elle** yapilir

## Bilerek konulan kisitlar

- **Canli temaya (MAIN) push engellidir.** Gecmek icin `--allow-live` gerekir.
  Varsayilan olarak kopya uzerinde calisilir.
- **Publish komutu yoktur.** Yayina alma karari ve sorumlulugu insanda kalir.

## Ag gereksinimi

Bu depo Claude Code web ortaminda calistiriliyorsa, environment'in ag
politikasinin su domainlere cikisa izin vermesi gerekir:

```
uy2rpe-ni.myshopify.com   # Admin API
cdn.shopify.com           # binary asset'ler (gorsel, font) buradan iner
```

Ayar yeri: claude.ai/code > mesaj kutusunun ustundeki bulut ikonu >
environment'in dislisi > **Network access** > **Custom**. "Also include default
list of common package managers" isaretli kalsin, yoksa npm erisimi de kapanir.

Degisiklik container ayaga kalkarken uygulanir; kaydettikten sonra **yeni bir
session** acmak gerekir.

Aksi halde istekler Shopify'a ulasmadan proxy seviyesinde 403 alir. Script bu
durumu Shopify kaynakli 403'ten ayirt edip acikca soyler.

## GraphQL sema dogrulamasi

Script'teki alan adlari 15 Eylul 2026'da Admin GraphQL API dokumantasyonuna
(shopify.dev, `latest`) karsi tek tek dogrulandi.

Dogru cikanlar:

| Kullanim | Durum |
|---|---|
| `themes(first:)` -> `nodes { id name role updatedAt }` | dogru |
| `theme(id: ID!)` -> `files(first:, after:)` | dogru |
| `OnlineStoreThemeFile`: `filename size checksumMd5 contentType body` | dogru |
| `OnlineStoreThemeFileBodyText.content` | dogru |
| `OnlineStoreThemeFileBodyBase64.contentBase64` | dogru |
| `OnlineStoreThemeFileBodyUrl.url` | dogru |
| `themeFilesUpsert(themeId:, files:)` -> `upsertedThemeFiles { filename }` | dogru |
| `userErrors { field filename message }` (`OnlineStoreThemeFilesUserErrors`) | dogru |
| `OnlineStoreThemeFilesUpsertFileInput`: `{ filename, body: { type, value } }` | dogru |
| `themeDuplicate(id: ID!, name: String)` argumanlari | dogru |

Duzeltilen iki nokta:

1. **`themeDuplicate` payload alani `theme` degil `newTheme`.** Eski haliyle
   `duplicate` komutu her calistirmada GraphQL hatasi verirdi.
2. **Varsayilan API surumu `2025-07` idi; 16 Temmuz 2026'da destek disi kaldi.**
   Desteksiz surum isteginde Shopify hata vermez, sessizce varsayilan surume
   "ileri duser" - yani hangi sema uzerinde calistigin belirsiz olur. Varsayilan
   `2026-07` (son kararli surum) yapildi ve yanittaki `X-Shopify-Api-Version`
   header'i istenen surumle karsilastirilip uyusmazlikta uyari basiliyor.

Canli semaya karsi calistirma (`node scripts/shopify-theme.mjs themes`) henuz
yapilamadi; asagidaki kimlik dogrulama sorunu cozulunce ilk is o olmali.

## Acik sorun: Admin API kimlik dogrulamasi

Durum (15 Eylul 2026):

- Ag politikasi **calisiyor**. Istekler `uy2rpe-ni.myshopify.com` adresine
  ulasiyor; yanitlar Shopify'dan geliyor (`x-request-id`, Cloudflare header'lari,
  Shopify'a ozgu hata govdesi).
- Kimlik dogrulama **calismiyor**. Her istek `401` ve
  `[API] Invalid API key or access token` donuyor. Denenen tum API surumlerinde
  (2025-07, 2026-01, 2026-07, unstable) ayni sonuc - yani sorun surum degil.
- Session icinde `SHOPIFY_ADMIN_TOKEN` ya da baska bir Shopify ortam degiskeni
  **yok**; agent proxy de `X-Shopify-Access-Token` header'ini eklemiyor gorunuyor.

Kontrol edilecekler (environment ayarlarinda, claude.ai/code > bulut ikonu >
dislice > **API credentials**):

1. Credential gercekten kaydedildi mi?
2. `Custom header` adi tam olarak `X-Shopify-Access-Token` mi? (prefix alani BOS)
3. `Allowed websites` icinde `uy2rpe-ni.myshopify.com` var mi?
4. Token hala gecerli mi - Admin > Apps > Develop apps > [app] > API credentials.
   Token iptal edilmis veya baska bir magazaya ait olabilir.
5. App'e `read_themes` ve `write_themes` scope'lari verilip **kaydedildi** mi?

Ayar degisikligi container ayaga kalkarken uygulanir: kaydettikten sonra **yeni
bir session** acmak gerekir.
