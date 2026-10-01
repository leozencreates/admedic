# 0025 — Windows ve iOS uygulamaları: web panelini saran ince istemci

- Tarih: 2026-10-01
- Durum: Kabul (ürün sahibi onayı: 2026-10-01 — "web panelini saran istemci", "PWA + Tauri iOS hazırlığı",
  Rust ve derleme araçlarının bu makineye kurulması)
- Önceki kararlar: ADR-0003 (Windows masaüstü / Tauri), ADR-0023 (sunucu merkezli mimari), ADR-0024 (ürün adı aktarımı)
- Değiştirdiği: ADR-0003 "client-side panel + Fastify REST" modeli (aşağıda §1)

## Bağlam

ADR-0023 ile ürünün merkezi Türkiye'deki tek sunucu oldu; masaüstü programı "bu sunucuya bağlanan istemci" olarak
tanımlandı. Kod ise eski modelde kalmıştı:

- `desktop/ui` yalnızca salt okunur bir özet gösteriyordu (kampanya, harcama, uyarı). Giriş, onay, lead ve stüdyo yoktu.
- Kabuk sabit olarak `http://127.0.0.1:3001` adresindeki `apps/api`'ye bağlanıyordu; uzak sunucuya bağlanamıyordu.
- Paket hiç derlenmemişti (ADR-0024 "Doğrulanmayan").

Ürün sahibi Windows ve iOS uygulamalarını istedi. iOS, `docs/spec.md` içinde geçmez; bu karar o kapsamı ekler.

## Karar

### 1. İki platformda da ince istemci
Uygulama, sunucudaki web panelinin tamamını kendi penceresinde açar. İş mantığı, veri ve yetki denetimi sunucuda
kalır; kabukta çoğaltılmaz. Panelin her özelliği (giriş, onaylar, lead'ler, kampanyalar) iki platformda da aynıdır.

Değerlendirilen diğer yollar:

| Seçenek | Sonuç |
| --- | --- |
| Salt okunur özeti genişletmek | Yazma işlemleri (onay, lead yanıtı) uygulamada olmaz; seçilmedi. |
| İki platforma tam yerel arayüz | `apps/api` oturumlu ve yazma yetkili tam bir API'ye dönüşmeli; onay ve harcama mantığı ikinci bir katmanda yeniden yazılır. Seçilmedi. |

`apps/api` (ADR-0001) kabuğun veri kaynağı olmaktan çıktı; kod yerinde duruyor, kaldırılması ayrı karardır.

### 2. Bağlantı ekranı (`desktop/ui`)
- İlk açılışta sunucu adresi sorulur. Adres `localStorage`'da (`server-url`) saklanır; sonraki açılışlarda panel
  doğrudan açılır.
- Uzak adres `https://` olmak zorundadır. `http://` yalnızca bu bilgisayardaki sunucu (`localhost`, `127.0.0.1`,
  `[::1]`) için kabul edilir. Kullanıcı adı/parola içeren ya da web dışı şemalı adres reddedilir
  (`ui/server-url.js`, `scripts/server-url.test.mjs`).
- Panel açılmadan önce `GET /api/health` yoklanır; yanıt `ok` ya da `degraded` değilse panel açılmaz ve neden gösterilir.
  Bunun için sağlık ucu `Access-Control-Allow-Origin: *` döner. Uç oturumsuzdur ve yalnızca sayı içerir.
- Adres değiştirme: masaüstünde "Bağlantı → Sunucu adresini değiştir…" menüsü. Telefonda menü çubuğu olmadığı için
  bağlantı ekranı 1,5 saniye görünür ve aynı düğmeyi gösterir.

### 3. Güvenlik sınırı
- Yetenek dosyasında `remote` tanımlanmaz: sunucudan açılan panel Tauri komutlarına erişemez.
- Kabuk CSP'si yalnızca gömülü bağlantı ekranını kapsar: `connect-src https: http://localhost:* http://127.0.0.1:*
  http://[::1]:*`. Panelin kendi güvenlik başlıkları sunucudan gelir (ADR-0023 §5).
- Pencere içi gezinme kısıtlanmaz: Meta ile bağlantı (OAuth) tam sayfa yönlendirmeyle Meta'ya gidip geri döner.

### 4. Ürün adı
Kural değişmedi: ad koda yazılmaz. `scripts/build-ci.mjs` artık her Tauri komutunu (`build`, `dev`, `ios …`) aynı
yoldan çalıştırır; pencere başlığı da yapılandırmadaki ürün adından alınır.

### 5. iOS
- **Bugün kullanılabilen yol — ana ekrana ekleme:** Panel zaten telefon düzenine ve web uygulaması bildirimine
  sahipti (ADR-0017). Apple'a özgü etiketler eklendi (`appleWebApp`): Safari'de "Ana Ekrana Ekle" ile panel, ürün
  adıyla ve Safari çubukları olmadan açılır. Mac, Xcode ya da Apple Developer hesabı gerekmez.
- **Mağaza paketi için hazırlık:** Aynı Tauri projesi iOS hedefini destekler (`ios:init`, `ios:dev`, `ios:build`;
  `desktop/README.md` "iOS"). Menü ve pencere başlığı kodu yalnızca masaüstünde derlenir.
- `viewport-fit=cover` bilinçli olarak eklenmedi: çentikli telefonlarda üst çubuğun yerleşimini değiştirir ve bu
  ortamda gerçek cihazda denenemez.

## Sonuçlar

- **Doğrulama (bu ortam, Windows 11):**
  - Rust 1.98.1 ve Visual Studio 2022 C++ derleme araçları kuruldu; `cargo clippy -D warnings` temiz.
  - `pnpm --filter @admedic/desktop build:ci` iki paket üretti: NSIS kurulum dosyası (2,2 MB) ve MSI (3,2 MB).
    Dosya adı ve pencere başlığı ürün adını Türkçe harfleriyle doğru taşıyor (ADR-0024'ün açık kalan doğrulaması).
  - Derlenen uygulama yerel panele karşı denendi: bağlantı ekranı, `http://` uzak adresin reddi, ulaşılamayan
    sunucu iletisi, panelin açılması, panelde oturum açma, menüden bağlantı ekranına dönüş, yeniden açılışta
    doğrudan panel.
  - Uzak panel sayfasından Tauri komutu çağrısı reddedildi: `Command plugin:app|version not allowed by ACL`.
  - Birim testleri: adres doğrulama 5, ad aktarımı 12.
  - Panelde Apple etiketleri ve bildirim dosyası sunucu yanıtında görüldü.
- **Doğrulanmayan:**
  - **iOS'un tamamı.** Tauri CLI Windows'ta `ios` alt komutunu tanımıyor; proje üretimi, derleme ve cihazda çalışma
    Mac'te yapılmalı. Ana ekrana ekleme de gerçek iPhone'da denenmedi; yalnızca sunucunun doğru etiketleri döndürdüğü
    görüldü.
  - Kurulum dosyasının temiz bir Windows makinesine kurulması ve kaldırılması (yalnızca derlenen `.exe` çalıştırıldı).
  - macOS masaüstü paketi (`app`/`dmg`).
- **Riskler:**
  - App Store, yalnızca bir web sitesini saran uygulamaları "asgari işlevsellik" kuralıyla reddedebilir. Mağaza
    yayını hedefse yerel özellik (ör. bildirim) eklenmesi gerekebilir; ana ekrana ekleme bu riskten etkilenmez.
  - Kurulum dosyaları imzasız: Windows SmartScreen uyarı gösterir. Kod imzalama sertifikası ürün sahibi kararı.
  - iOS'ta yeni pencere açan bağlantılar (`target="_blank"`) uygulama içinde açılmayabilir; Mac'te denenecek.
  - Sunucu adresini kullanıcı yazar; yanlış ama geçerli bir panele bağlanmayı kabuk ayırt edemez. Adres yöneticiden
    alınmalıdır.
- **Negatif:** Uygulama çevrimdışı çalışmaz; sunucuya ulaşılamazsa yalnızca bağlantı ekranı görünür.
