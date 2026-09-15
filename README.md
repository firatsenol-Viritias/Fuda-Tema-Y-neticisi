# Fuda - Shopify Tema Yonetimi

`uy2rpe-ni.myshopify.com` magazasinin tema dosyalarini surum kontrolu altinda
tutmak ve Admin GraphQL API uzerinden senkronize etmek icin kullanilir.

## Kurulum

```bash
cp .env.example .env
# .env icine SHOPIFY_ADMIN_TOKEN degerini yaz (shpat_ ile baslar)
```

Token Shopify Admin'den alinir:
Settings > Apps and sales channels > Develop apps > [app] > API credentials
> Admin API access token. Gerekli scope'lar: `read_themes`, `write_themes`.

`.env` gitignore'dadir. Token'i hicbir zaman commit etme.

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

Aksi halde istekler Shopify'a ulasmadan proxy seviyesinde 403 alir.

## Dogrulanmamis nokta

Script'teki GraphQL alan adlari (`themes`, `theme.files`, `themeFilesUpsert`,
`themeDuplicate` ve govde union tipleri) baglanti olmadan yazildi, canli
sema uzerinde henuz dogrulanmadi. Ilk basarili baglantida `themes` komutunu
calistirip alan adlarini teyit et; bir uyusmazlik varsa GraphQL hatasi
alanin adini acikca soyler.
