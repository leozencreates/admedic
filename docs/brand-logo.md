# ADM logo

- Tarih: 2026-10-01.
- Tasarım: Kullanıcının istediği A, D ve M harflerini bu sırayla birleştiren mor monogram.
- Üretim: Yerleşik Imagegen aracı; şeffaf PNG.
- Ana dosya: `web/public/brand-mark-adm.png`.
- Masaüstü paneli: `desktop/ui/brand-mark-adm.png`.
- Masaüstü ikon kaynağı: `desktop/src-tauri/icons/app-icon-source-v2.png`.
- İkon paketi: `desktop/src-tauri/icons/logo-v2/`; Tauri CLI ile kaynak PNG'den üretilir.
- Sekme ikonu: `web/app/icon.png`.
- Favicon: `web/app/favicon.ico`.
- iPhone/iPad ana ekranı: `web/app/apple-icon.png` (180 × 180).
- Android/ana ekran ikonları: `web/public/icons/adm-192.png`, `adm-512.png`.
- Web manifesti: `web/app/manifest.ts`; uygulama adı çalışma zamanında `APP_NAME` değerinden gelir.
- Masaüstü HTML ikonları: `desktop/ui/favicon.ico`, `apple-touch-icon.png`.

Simge yalnız ADM monogramını içerir. Görünür uygulama adı `APP_NAME` değerinden gelmeye devam eder.
Kullanıcının son tercihi doğrultusunda AM monogramı ADM olarak güncellendi.
ADM ikon paketi `logo-v2` dizinindedir. Standart masaüstü ikon dosyaları ve eski `brand-mark.png`
kopyaları da onaylanan ADM görseliyle eşitlendi; eski AM/boş ikon kalmadı.

Önceki AM entegrasyonunun doğrulaması: web tip denetimi ve lint geçti. Chromium'da giriş ekranının 48 px simgesi,
masaüstü statik panelinin 40 px simgesi, dinamik Türkçe uygulama adı ve sekme ikonunun yüklenmesi
kontrol edildi. PNG'nin alfa kanalı ve masaüstü yapılandırmasındaki tüm ikon dosyaları doğrulandı.

2026-10-01 tüm marka alanları: giriş ekranı, masaüstü yan menü, mobil üst çubuk ve mobil menü ADM
simgesini kullanır. Favicon, sekme ikonu, Apple ikonu ve web manifestinin gerçek HTTP yanıtları
200 olarak doğrulandı. Chromium'da oturum açılarak masaüstü ve 390 px mobil görünüm, menü açılışı
ve yatay taşma kontrol edildi. Kaynak görseller SHA-256 ile karşılaştırıldı; hepsi aynı ADM
görselinden geliyor. Tip denetimi ve lint geçti. Docker standalone imajı artık `web/public`
dosyalarını da içerir; logo ve ana ekran ikonları üretimde erişilebilir kalır.

## Üretim prompt'u

```text
Edit this logo to read ADM instead of AM. Insert a clearly recognizable uppercase D between the A and M, combining all three into one elegant cohesive ADM monogram. Preserve the same violet color, bold smooth strokes, rounded corners, geometric proportions and refined style. Keep A, D and M readable in that order. Center the complete mark on a square genuinely transparent canvas with even margins. No other text, symbols, background, shadow or mockup. Change only the monogram letters.
```

## Önceki AM üretim prompt'u

```text
Use case: logo-brand.
Asset type: finished AM monogram logo for a premium health advertising software product, Admedic. This is a revised design direction specifically requested by the owner: the initials A and M must be combined in one symbol.
Primary request: Design ONE exceptionally elegant original AM monogram. Both uppercase letters A and M must be recognizable simultaneously. Fuse them through a shared central diagonal or shared vertical stroke into one cohesive geometric mark. The A should be visibly an A, with a well-proportioned open counter and a tasteful crossbar. The M should have two clear shoulders and a descending central valley, visibly an M, not an N. Find a clever balanced interlocking construction, rather than two separate letters casually set side by side. Smooth slightly rounded corners, bold enough for a 32px application icon, premium modern medical technology identity, confident and restrained. The two letters are the whole visual idea; no extra medical cross or other symbol.
Style: precise polished vector-like monogram rendered in high-resolution PNG, solid violet #5B45D0 with consistent thick geometry, calm balanced negative spaces. Single flat color, smooth clean edges. Avoid gradients, shadows, 3D, bevels, tiny details and hairline strokes.
Composition: square canvas, single centered AM symbol, about 70 percent of the frame width, generous even transparent padding, full uncropped silhouette.
Background: genuinely transparent, all negative spaces transparent.
Text: the designed AM monogram ONLY. No separate brand name, no tagline, no explanatory labels, no comparison sheet.
Constraints: original design, no established trademark imitation, no watermark, no background square, no decorative clinical illustrations. Ensure excellent legibility on both white and deep navy #0F1426.
```

## İkonları yeniden üretme

```sh
pnpm --filter @admedic/desktop exec tauri icon src-tauri/icons/app-icon-source-v2.png --output src-tauri/icons/logo-v2
```
