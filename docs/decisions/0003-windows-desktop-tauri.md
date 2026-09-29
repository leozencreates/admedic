# ADR-0003 — Windows Masaüstü Dağıtımı (Tauri)

- **Durum:** Kabul edildi (2026-09-17)
- **Karar veren:** Ürün sahibi + mühendislik
- **İlgili:** [ADR-0001](0001-api-runtime-fastify.md), [ADR-0002](0002-approval-gated-executor.md), `docs/spec.md` §1.7 "Masaüstü (Windows/PC)"

## Bağlam

Müşteri/klinik seviyesinde "çift tıkla çalışan, kurulabilir Windows programı" isteniyor
(`docs/meta-constraints.md` ile uyumlu: veri lokasyonu PC). Spesifikasyon panel için
web/Next.js'i öngörüyor (spec §1.7 "Web"), ancak ürün sahibi dağıtım ortamı olarak
**Windows PC + `.exe`**'yi tercih etti.

İki gerçek (tahmin değil, doğrulanabilir):

1. Bu geliştirme makinesi macOS; `rustc`/`cargo` kurulu değil. Tauri (Rust) Windows
   `.exe`'sini macOS'tan **üretemez ve doğrulayamaz** — Windows hedefi için Windows-Rust
   toolchain (VEYA Windows'ta build eden CI) şart.
2. Tauri, Next.js App Router sunucu bileşenlerini (Prisma/DB erişimi) doğrudan
   "kabuk" içinde çalıştıramaz. Doğru mimari: **istemsiz/statik SPA panel + Fastify REST API**.

## Karar

- **Motor/veri katmanı Değişmez:** `@admedic/database` (PostgreSQL), `@admedic/bayesian-engine`,
  `@admedic/agent-engine`, `@admedic/meta-api` aynen kalır — bunlar platformdan bağımsız TypeScript.
- **Windows masaüstü (= ürünün dağıtım hedefi):** Tauri (v2) kabuk + **client-side React paneli**.
  Panel, tüm veriyi Fastify **REST API** üzerinden alır (`apps/api` — ADR-0001 ile zaten kararlaştırılmıştı;
  bu karar onu **zorunlu** kılar: masaüstü SPA, DB'ye doğrudan bağlanamaz).
- **`web/` Next.js dashboard:** geliştirme/operatör arayüzü olarak KALIR ve Fastify API'yi tüketmeye
  uyarlanır (spesifikasyonun web fazı; aynı REST endpoint'leri paylaşır). Bu sayede mevcut
  çalışan, test edilmiş panel çöpe gitmez — masaüstü ile aynı veri sözleşmesi üzerinde yaşar.
- **`.exe` üretimi:** GitHub Actions **Windows runner**'ında Tauri build + NSIS bundle yapılır
  (`desktop/app-build` workflow), çıktı release asset olarak sunulur. Yerel macOS geliştirmede
  yalnızca Rust+Tailwind vs. çalıştırılarak `tauri dev` ile sistem webview'inde doğrulanır.

## Sonuçlar

- **Pozitif:** Tek kaynaklı doğruluk (tek DB + tek API), masaüstü ve web aynı endpoint'leri kullanır;
  Meta/politika/onay mantığı iki yerde çoğaltılmaz. Kurulum `pnpm install` ile monorepo'ya tam uyar.
- **Negatif:** Panel katmanı (web/Next) REST'e uyarlanır, yani "sunucu bileşen doğrudan Prisma okuma"
  modelinden SPA+API modeline geçiş gerekir. `.exe`'nin gerçek build ve smoke'u ancak Windows CI'da.
- **Riskler/Tedbirler:** Tauri Toolchain Windows'ta yok → CI baslar; her Windows patch/build
  `pnpm lint && typecheck && test && build` kök kontrolünden geçmeden release'e girmez.

## Alternatifler (değerlendirildi)

| Seçenek | Sonuç |
| --- | --- |
| Electron (JS, yerel Rust yok) | Aynı SPA+API mimarisi, ancak ekstra Chromium payload; Tauri (sistem WebView2) daha küçük ve proje diliyle uyumlu. Tauri seçildi. |
| Mac'te "yerel" .exe denemek | Windows cross-build Rust olmadan üretilemez/doğrulanamaz → **yapılmadı** (spek: doğrulanamayan kod yazma). |
| Sadece web tarayıcı | Klinik PC'de çalışır ancak "kurulabilir program" beklentisini karşılamaz. Masaüstü istenince ikisi de yürütülür. |
## Revizyon 2 (2026-09-20): GitHub BIRAKILDI — yalnız yerel

- .github/workflows/desktop.yml GitHub hoparlörüne itilmez; Draft Release / windows CI ifadesi GEÇERSİZ sayılır.
- Yerel üretim: ./desktop + `pnpm build:ci` (APP_NAME env) — kullanıcının makinesinde `.app` (macOS) üretir; hiçbir hosta kod götürülmez.
- Uygulama adı kuralı DEĞİŞMEDİ: sıfır satırda sabit; yalnız APP_NAME.
- Dağıtım adresi: kullanıcının Masaüstü (yerel).

Kararı özetleyen tek cümle: "GitHub yok = repo yerel kalır; ad kuralı değişmez."

## Durum notu (2026-09-26)

- Rev. 2 geçerlidir: GitHub Actions/Windows CI yoktur; paket **yerel** üretilir
  (`APP_NAME="…" pnpm --filter @admedic/desktop build:ci`, ürün adı `--config` ile APP_NAME'den).
- `tauri.conf.json` hedefleri `nsis`/`msi` (Windows) **korunur**; yerel macOS üretimi için `app`/`dmg` eklendi.
  Tauri, çalışılan platformda desteklenmeyen hedefleri atlar. `identifier` (`com.admedic.desktop`) uygulama
  veri dizinleri için sabit kalır; ürün adı kuralı değişmez.
- CSP açık: `default-src 'self'; connect-src http://127.0.0.1:3001` (stil dosyası ayrı, inline yok).
- Kabuk `apps/api` salt okunur REST'ini `API_TOKEN` Bearer belirteciyle tüketir; `web/` Next.js paneli
  SPA+API modeline **taşınmadı** (ADR-0001 durum notu) — masaüstü ile web aynı veritabanını, farklı HTTP
  katmanlarını kullanır. Kurulum: `desktop/README.md`.

## Revizyon 3 (2026-09-29): Sunucu merkezli mimari — ADR-0023
- "Veri lokasyonu PC" kuralı kaldırıldı: canlıda Meta webhook'ları 7/24 erişilebilen bir HTTPS sunucusu gerektirir.
- Ürünün merkezi Türkiye'de barındırılan tek sunucudur (panel, işçi, PostgreSQL). Masaüstü programı bu sunucuya bağlanan
  bir istemci olarak kalır.

