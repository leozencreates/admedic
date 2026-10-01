# Masaüstü ve iOS kabuğu (Tauri v2)

ADR-0025: uygulama, sunucudaki web panelini kendi penceresinde açan ince bir istemcidir. `desktop/ui` yalnızca
bağlantı ekranıdır (sunucu adresini sorar, `GET /api/health` ile yoklar, paneli açar). İş mantığı ve veri sunucuda
kalır; Rust tarafında yalnızca pencere başlığı, "Bağlantı" menüsü (`src-tauri/src/lib.rs`) ve Windows'ta mikrofon
izin işleyicisi (`src-tauri/src/mic_permission.rs`) vardır.

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

## Mikrofon (sesli asistan)

Paneldeki sesli asistan (ADR-0028) mikrofonu `getUserMedia` ile ister. **Windows** kabuğu bu izni yalnızca bağlanılan
sunucuya verir. **macOS / iOS** paketlerinde mikrofon şimdilik kapalıdır (aşağıda); asistan orada yazıyla çalışır.

- **HTTPS şart:** `getUserMedia` yalnızca güvenli bağlamda (secure context) çalışır. Uzak sunucu `https://` olmalıdır;
  `http://` yalnızca `localhost`/`127.0.0.1`/`[::1]` için güvenli sayılır (bağlantı ekranının kuralıyla aynı).
  Sunucu ayrıca `Permissions-Policy: microphone=(self)` gönderir (`web/next.config.ts`).
- **Sunucu origin'i nereden gelir:** Bağlantı ekranı paneli açmadan hemen önce origin'i `set_server_origin` komutuyla
  kabuğa bildirir (`ui/index.js`). Rust adresi aynı kurallarla yeniden doğrular ve bellekte tutar; her açılışta
  bağlantı ekranı önce çalıştığı için yeniden bildirilir. Komut yalnızca gömülü yerel sayfaya izinlidir
  (`allow-set-server-origin`, `capabilities/default.json`); uzak panel ve Meta sayfaları çağıramaz. Bunun için kabuk
  CSP'sinin `connect-src` listesine Tauri IPC adresi (`ipc: http://ipc.localhost`) eklendi.
- **Windows (WebView2):** `PermissionRequested` olayı karşılanır (`src-tauri/src/mic_permission.rs`):

  | İzin | Karar |
  | --- | --- |
  | Mikrofon, istek origin'i = sunucu origin'i (şema + ana makine + kapı) | İzin (sorulmaz) |
  | Mikrofon, başka her origin (Meta OAuth, iframe, yönlendirme sayfası) ya da adres henüz bildirilmemiş | Ret |
  | Kamera, konum, diğer sensörler | Ret (panel kullanmaz; sunucu da `camera=()`, `geolocation=()` gönderir) |
  | Diğerleri (bildirim, pano, otomatik oynatma…) | WebView2 varsayılanı (değişmedi) |

  Kararlar WebView2 profiline kaydedilmez (`SavesInProfile = false`): sunucu adresi değişince eski izin taşınmaz.
  İşletim sistemi düzeyinde Windows'un "Ayarlar → Gizlilik → Mikrofon → Masaüstü uygulamalarının mikrofona
  erişmesine izin ver" seçeneği açık olmalıdır; kapalıysa asistan yazıyla sürer.
- **macOS / iOS (WKWebView): mikrofon kapalı (bilinçli).** wry 0.55.1 medya yakalama isteğini origin, çerçeve ve
  türe bakmadan her sayfaya verir (kamera dahil); kabuk Apple'da origin süzmez. İşletim sistemi izni bir kez
  verilince panelden gidilen her sayfa (Meta OAuth, yönlendirmeler, `allow="microphone"` taşıyan yabancı iframe'ler)
  mikrofonu sessizce açabilirdi. Bu yüzden pakete mikrofon yetkisi ve kullanım metni eklenmez:
  `bundle.macOS.entitlements` tanımlı değil, `src-tauri/Info.plist` yok. Hazır dosyalar
  `src-tauri/apple-mic-disabled/` altında bekler (`Entitlements.plist`: `com.apple.security.device.audio-input`;
  `Info.plist`: `NSMicrophoneUsageDescription`). Bağlamadan önce WKWebView temsilcisinde `decide()` ile aynı origin
  denetimi (mikrofon yalnızca sunucu origin'i, kamera her yerde ret) yapılmalıdır. Kullanım metni olmayan iOS
  uygulamasında WKWebView'in isteği çökmeden reddettiği ve panelin yazıya geçtiği varsayılır: **DOĞRULANMADI**
  (Mac/iPhone'da denenmedi).

### Elle deneme (Windows)

1. `pnpm web:dev` ve `pnpm desktop:dev`; bağlantı ekranına `localhost:3000` yazın, panelde oturum açın.
2. Asistan düğmesine basın: Windows izin istemi çıkmadan konuşma başlamalı; görev çubuğunda mikrofon simgesi görünür.
3. Bağlantı → Sunucu adresini değiştir… ile başka (geçerli) bir sunucuya bağlanın; o sunucuda da çalışmalı, eski
   adres için verilen izin yeni adrese taşınmamalı.
4. Geliştirici araçları konsolunda (yalnızca `dev`) `location.href = "https://example.com"` ile başka bir origin'e
   gidin ve `await navigator.mediaDevices.getUserMedia({ audio: true })` çalıştırın: istem çıkmadan
   `NotAllowedError` beklenir. Menüden bağlantı ekranına dönüp yeniden bağlanın.
5. Windows mikrofon gizlilik ayarını kapatıp asistanı açın: panel "mikrofon kullanılamıyor" uyarısıyla yazıya geçmeli.
6. Eski bir derlemede mikrofon istemine "Engelle" denmişse ve izin hâlâ reddediliyorsa WebView2 profilini silin:
   `%LOCALAPPDATA%\com.admedic.desktop\EBWebView` (oturum ve kayıtlı adres de silinir).

## Güvenlik

- Yetenekler: yalnızca `core:default` ile `allow-set-server-origin` ve yalnızca gömülü bağlantı ekranı için
  (`src-tauri/capabilities/default.json`). `remote` tanımlı değildir: sunucudan açılan panel Tauri komutlarına erişemez.
- Kabuk CSP'si (`tauri.conf.json`) yalnızca bağlantı ekranını kapsar; panelin güvenlik başlıkları sunucudan gelir.
- Windows'ta mikrofon yalnızca bağlanılan sunucunun origin'ine verilir; kamera ve konum reddedilir. macOS/iOS
  paketlerinde mikrofon yetkisi yoktur (wry origin süzmediği için; yukarıda "Mikrofon").
- Bağlantı ekranı kullanıcı girdisini ve sunucu yanıtını `innerHTML` ile yazmaz.

## Doğrulama

```sh
pnpm --filter @admedic/desktop test:ui         # sunucu adresi doğrulama (Rust gerektirmez)
pnpm --filter @admedic/desktop test:encoding   # ürün adı aktarımı (Rust gerektirmez)
pnpm --filter @admedic/desktop typecheck       # cargo check
pnpm --filter @admedic/desktop lint            # cargo clippy -D warnings
pnpm --filter @admedic/desktop test            # cargo test (mikrofon izin kararı dahil)
```

Rust toolchain olmayan makinelerde `cargo` komutları çalışmaz; kök `turbo` komutlarında
`--filter='!@admedic/desktop'` ile dışarıda bırakılır.
