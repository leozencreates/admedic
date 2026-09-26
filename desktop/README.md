# Masaüstü kabuğu (Tauri v2)

ADR-0003 (rev. 2): yerel olarak üretilen, kurulabilir masaüstü uygulaması. Kabuk yalnızca `desktop/ui`
altındaki statik paneli host eder ve tüm veriyi salt okunur Fastify REST'inden (`apps/api`,
varsayılan `http://127.0.0.1:3001`) alır. Rust tarafında iş mantığı yoktur (`src-tauri/src/lib.rs`).

## Gereksinimler

- Rust toolchain (`rustup`, stable) ve platform bağımlılıkları — bkz. Tauri v2 "Prerequisites".
- Windows: WebView2 çalışma zamanı (Windows 10/11'de yerleşik), NSIS/WiX için Tauri'nin indirdiği araçlar.
- macOS: Xcode Command Line Tools.

## Çalıştırma

```sh
# 1) Veritabanı + API (kök .env; API_TOKEN ayarlı değilse yalnızca META_MOCK_MODE=true iken cevap verir)
pnpm api:dev

# 2) Kabuk (geliştirme; sistem webview'inde açılır)
pnpm desktop:dev
```

Panel açılışta `GET /v1/overview` çağırır. API `API_TOKEN` istiyorsa (401/503) başlıkta bir belirteç
alanı görünür; girilen değer tarayıcı `localStorage`'ında (`api-token`) tutulur. Alternatif olarak
`globalThis.__API_BASE__` / `globalThis.__API_TOKEN__` sayfa yüklenmeden tanımlanabilir.

## Üretim paketi

```sh
APP_NAME="Klinik Reklam Stüdyosu" pnpm --filter @admedic/desktop build:ci
```

`build:ci` ürün adını `APP_NAME` ortam değişkeninden geçirir (`--config '{"productName": …}'`);
`tauri.conf.json` içinde ad sabit yazılmaz. Hedefler: `nsis`/`msi` (Windows), `app`/`dmg` (macOS);
Tauri, çalışılan platformda desteklenmeyen hedefleri atlar. Çıktı: `src-tauri/target/release/bundle/`.

## Güvenlik

- CSP: `default-src 'self'; connect-src http://127.0.0.1:3001` (bkz. `tauri.conf.json`). API adresi
  değişirse `connect-src` de güncellenmelidir.
- Panel API dizgilerini `innerHTML` ile yazmaz; tüm çıktı DOM API/`textContent` ile üretilir.
- Yetenekler: yalnızca `core:default` (`src-tauri/capabilities/default.json`); dosya/ağ eklentisi yok.

## Doğrulama

```sh
pnpm --filter @admedic/desktop typecheck   # cargo check
pnpm --filter @admedic/desktop lint        # cargo clippy -D warnings
pnpm --filter @admedic/desktop test        # cargo test
```

Rust toolchain olmayan makinelerde bu komutlar çalışmaz; kök `turbo` komutlarında
`--filter='!@admedic/desktop'` ile dışarıda bırakılır.
