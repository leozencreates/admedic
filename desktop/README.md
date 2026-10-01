# Masaüstü ve iOS kabuğu (Tauri v2)

ADR-0025: uygulama, sunucudaki web panelini kendi penceresinde açan ince bir istemcidir. `desktop/ui` yalnızca
bağlantı ekranıdır (sunucu adresini sorar, `GET /api/health` ile yoklar, paneli açar). İş mantığı ve veri sunucuda
kalır; Rust tarafında yalnızca pencere başlığı ve "Bağlantı" menüsü vardır (`src-tauri/src/lib.rs`).

## Gereksinimler

- Rust toolchain (`rustup`, stable).
- Windows: Visual Studio C++ derleme araçları ("Desktop development with C++") ve WebView2 çalışma zamanı
  (Windows 10/11'de yerleşik). Kurulum:
  ```powershell
  winget install Rustlang.Rustup
  winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```
- macOS: Xcode Command Line Tools (masaüstü); iOS için tam Xcode (aşağıda).

## Çalıştırma

```sh
pnpm web:dev          # panel: http://localhost:3000
pnpm desktop:dev      # kabuk (geliştirme)
```

İlk açılışta sunucu adresi sorulur; geliştirmede `localhost:3000` yazın. Adres saklanır ve sonraki açılışlarda panel
doğrudan açılır. Değiştirmek için: **Bağlantı → Sunucu adresini değiştir…**

Adres kuralları: uzak sunucu `https://` olmalıdır; `http://` yalnızca bu bilgisayar (`localhost`, `127.0.0.1`) için
kabul edilir.

## Üretim paketi (Windows)

Kök `.env` dosyasında `APP_NAME` tanımlıysa ek bir atama gerekmez:

```sh
pnpm --filter @admedic/desktop build:ci
```

Çıktı: `src-tauri/target/release/bundle/nsis/<ürün adı>_<sürüm>_x64-setup.exe` ve `bundle/msi/….msi`.
Hedefler: `nsis`/`msi` (Windows), `app`/`dmg` (macOS); Tauri, çalışılan platformda desteklenmeyen hedefleri atlar.

Kurulum dosyaları imzasızdır; Windows SmartScreen "bilinmeyen yayıncı" uyarısı gösterir.

### Ürün adı

`scripts/build-ci.mjs` ürün adını süreç ortamındaki `APP_NAME`'den, yoksa kök `.env` dosyasından okur, UTF-8 bir JSON
dosyasına yazar ve Tauri'ye `--config` ile dosya yolu olarak geçirir (ADR-0024). Ad kabuk üzerinden geçmediği için
Türkçe karakterler bozulmaz. `dev` ve `ios:*` komutları da aynı betikten geçer. Tek derleme için adı değiştirmek:

```powershell
# PowerShell
$env:APP_NAME = "Klinik Reklam Stüdyosu"
pnpm --filter @admedic/desktop build:ci
```

```sh
# bash / zsh
APP_NAME="Klinik Reklam Stüdyosu" pnpm --filter @admedic/desktop build:ci
```

> Uyarı: `APP_NAME="…" pnpm …` ön eki yalnızca bash/zsh'te geçerlidir; cmd.exe ve PowerShell'de çalışmaz.

## iOS

> Bu bölümdeki adımlar **doğrulanmadı**: iOS yalnızca macOS + Xcode ile derlenir ve bu depo şimdiye kadar yalnızca
> Windows'ta derlendi (ADR-0025). İlk Mac derlemesinde aşağıdaki denetim listesi uygulanmalıdır.

### Mağaza gerektirmeyen yol: ana ekrana ekleme

Panel bir web uygulaması olarak kurulabilir; Mac, Xcode ya da Apple Developer hesabı gerekmez:

1. iPhone/iPad'de Safari ile panel adresini (`https://…`) açın.
2. Paylaş → **Ana Ekrana Ekle**.
3. Ana ekrandaki simge paneli Safari çubukları olmadan, ürün adıyla açar.

### Mağaza paketi (Tauri iOS)

Gereksinimler (Mac'te): tam Xcode, `rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim`,
`brew install cocoapods`, Apple Developer hesabı.

```sh
export APPLE_DEVELOPMENT_TEAM=<Takım Kimliği>
pnpm --filter @admedic/desktop ios:init     # src-tauri/gen/apple altında Xcode projesini üretir
pnpm --filter @admedic/desktop ios:dev      # simülatör ya da bağlı cihaz
pnpm --filter @admedic/desktop ios:build    # .ipa
```

İlk Mac derlemesinde denetlenecekler:

- Bağlantı ekranı ve panel, çentik ve alt çizgi (home indicator) alanlarına taşmıyor mu?
- Kayıtlı adresle açılışta "Sunucu adresini değiştir" düğmesi görünüyor mu (telefonda menü yoktur)?
- Meta ile bağlantı (tam sayfa yönlendirme) uygulama içinde gidip dönüyor mu?
- Yeni pencere açan bağlantılar (`target="_blank"`) ne yapıyor?
- Türkçe karakterli ürün adı Xcode proje adında sorun çıkarıyor mu?
- Uygulama kimliği `com.admedic.desktop` (`tauri.conf.json`); mağaza için farklı bir kimlik gerekiyorsa
  `src-tauri/tauri.ios.conf.json` ile yalnızca iOS'ta değiştirilebilir.

App Store, yalnızca bir web sitesini saran uygulamaları reddedebilir (ADR-0025 "Riskler").

## Güvenlik

- Yetenekler: yalnızca `core:default` ve yalnızca gömülü bağlantı ekranı için (`src-tauri/capabilities/default.json`).
  `remote` tanımlı değildir: sunucudan açılan panel Tauri komutlarına erişemez.
- Kabuk CSP'si (`tauri.conf.json`) yalnızca bağlantı ekranını kapsar; panelin güvenlik başlıkları sunucudan gelir.
- Bağlantı ekranı kullanıcı girdisini ve sunucu yanıtını `innerHTML` ile yazmaz.

## Doğrulama

```sh
pnpm --filter @admedic/desktop test:ui         # sunucu adresi doğrulama (Rust gerektirmez)
pnpm --filter @admedic/desktop test:encoding   # ürün adı aktarımı (Rust gerektirmez)
pnpm --filter @admedic/desktop typecheck       # cargo check
pnpm --filter @admedic/desktop lint            # cargo clippy -D warnings
pnpm --filter @admedic/desktop test            # cargo test
```

Rust toolchain olmayan makinelerde `cargo` komutları çalışmaz; kök `turbo` komutlarında
`--filter='!@admedic/desktop'` ile dışarıda bırakılır.
