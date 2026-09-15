# Fuda - Shopify Tema Yonetimi

`uy2rpe-ni.myshopify.com` magazasinin tema dosyalarini surum kontrolu altinda
tutmak ve Admin GraphQL API uzerinden senkronize etmek icin kullanilir.

## Kurulum

Kimlik dogrulama **client credentials grant** ile yapilir: app'in kendi kimlik
bilgileri (client id + client secret) 24 saatlik bir Admin API access token'a
cevrilir, merchant etkilesimi gerekmez. Script token'i kendi alir, diske
onbellekler ve suresi dolunca yeniler.

Shopify Admin panelinden olusturulan eski tip custom app'ler artik yeni kayit
kabul etmiyor; kalici `shpat_` token uretilmiyor. Guncel yol budur.

Kimlik bilgileri: Shopify Admin > Settings > Apps and sales channels
> Develop apps > [app] > **API credentials**. Gerekli scope'lar:
`read_themes`, `write_themes`.

```bash
cp .env.example .env
```

`.env` icine:

```
SHOPIFY_STORE=uy2rpe-ni.myshopify.com
SHOPIFY_CLIENT_ID=<API key>
SHOPIFY_CLIENT_SECRET=shpss_...
```

`.env` ve token onbellegi (`.shopify-token.json`) gitignore'dadir. Ikisini de
asla commit etme.

### Kimlik dogrulama modlari

Script su siraya gore secer:

| Oncelik | Ortam degiskenleri | Davranis |
|---|---|---|
| 1 | `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | client_credentials grant ile 24 saatlik token alir, onbellekler, kendini yeniler |
| 2 | `SHOPIFY_ADMIN_TOKEN` (`shpat_...`) | elde hazir token varsa dogrudan kullanir |
| 3 | `SHOPIFY_PROXY_AUTH=1` | header'i agent proxy ekler, token session icinde hic bulunmaz |

Token 401 alirsa (secret rotasyonu, app'in yeniden kurulmasi) script bir kez
taze token alip istegi tekrarlar.

`shpss_` ile baslayan deger **API secret key**'dir; `X-Shopify-Access-Token`
olarak dogrudan kullanilamaz - yalnizca `SHOPIFY_CLIENT_SECRET` olarak, client
id ile birlikte anlamlidir. `shpat_` prefix'i olmayan bir degeri
`SHOPIFY_ADMIN_TOKEN`'a yazarsan script bunu baslangicta yakalar.

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

Alan adlari once shopify.dev dokumantasyonuna, sonra **canli semaya** karsi
dogrulandi (15 Eylul 2026, API 2026-07).

| Kullanim | Durum |
|---|---|
| `themes(first:)` -> `nodes { id name role updatedAt }` | canli sema ile dogrulandi |
| `theme(id: ID!)` -> `files(first:, after:)` | canli sema ile dogrulandi |
| `OnlineStoreThemeFile`: `filename size checksumMd5 contentType body` | canli sema ile dogrulandi |
| `OnlineStoreThemeFileBodyText.content` | canli sema ile dogrulandi |
| `OnlineStoreThemeFileBodyBase64.contentBase64` | dokumantasyondan |
| `OnlineStoreThemeFileBodyUrl.url` | dokumantasyondan |
| `themeFilesUpsert` -> `upsertedThemeFiles { filename }` | dokumantasyondan |
| `userErrors { field filename message }` | dokumantasyondan |
| `themeDuplicate(id:, name:)` -> `newTheme` | canli sema ile dogrulandi |

Duzeltilen uyusmazliklar:

1. **`themeDuplicate` payload alani `theme` degil `newTheme`.** Canli sema eski
   haliyle `Field 'theme' doesn't exist on type 'ThemeDuplicatePayload'` doner.
   `duplicate` komutu - is akisinin ilk adimi - hic calismazdi.
2. **Varsayilan API surumu `2025-07` idi, 16 Temmuz 2026'da destek disi kaldi.**
   Shopify desteksiz surumde hata vermez, sessizce baska bir surume duser
   (olcumde 2025-10'a dustu). Varsayilan `2026-07` yapildi; yanittaki
   `X-Shopify-Api-Version` istenen surumle karsilastirilip uyusmazlikta uyari
   basiliyor.

Not: `OnlineStoreThemeFile.size` alani `Int` degil `String` doner. Script bu
alani kullanmiyor, ama uzerine kod yazacaksan dikkat.

## Otomatik uretilen JSON dosyalari

Shopify, otomatik uretilen JSON dosyalarini (`config/settings_data.json`,
`templates/*.json`, `locales/*.json`) API'den dondururken iki sey yapiyor:

1. Basina "contents of this file are auto-generated" uyari yorumu ekliyor.
2. Icerigi yeniden bicimlendiriyor - depoda minified, donen halde girintili.
   (`templates/product.json`: depoda 17182 bayt, donen govde 32499 bayt.)

`checksumMd5` ise **depodaki** hale ait. Yani bu dosyalarda
`md5(donen govde) != checksumMd5` olur, dosya hic degismemis olsa bile.

Bu duzeltilmeden once: taze bir `pull`'dan hemen sonra `status` 430 dosyanin
59'unu "degismis" gosteriyordu ve yerele yazilan JSON dosyalari - basindaki
yorum yuzunden - gecersizdi.

Script simdi:

- `pull` sirasinda yalnizca bu otomatik banner'i ayikliyor (bazi dosyalarda
  banner'dan sonra satir sonu yok, `*/{` seklinde dogrudan icerik geliyor).
- Karsilastirmada once md5'e bakiyor; JSON'da tutmazsa iki tarafi da kanonik
  forma indirip karsilastiriyor. Anahtar sirasi korunuyor, boylece gercek bir
  yeniden siralama gizlenmiyor.
- Karsilastirma icin JSON yorumlarini tolere ediyor (`locales/*.schema.json`
  mesru `//` yorumlari iceriyor). Dize icindeki `//` dizilerine dokunulmuyor.

Olculen sonuc: taze pull sonrasi `status` -> **fark yok**, 72 JSON dosyasinin
tamami gecerli. Sadece bicimlendirmesi degistirilen dosya "degismis"
gorunmuyor, icerigi degistirilen dosya goruluyor.

## Dogrulama durumu

15 Eylul 2026 itibariyla canli magazaya karsi calistirildi:

- `themes` - 18 tema listelendi
- `pull` - 430 dosya indi (sayfalama dahil), 0 atlandi
- `status` - taze pull sonrasi fark yok; gercek degisiklikler goruluyor
- `push --dry-run` - gonderilecek bir sey yok; MAIN korumasi calisiyor
- `duplicate` - alan adi canli semaya karsi dogrulandi (gecersiz ID ile,
  magazada tema olusturmadan). Gercek bir kopya alma islemi henuz
  calistirilmadi.
