# 0023 — Sunucu merkezli mimari ve canlıya hazırlık (Faz 7-A)

- Tarih: 2026-09-29
- Durum: Kabul (ürün sahibi onayı: 2026-09-29, Faz 7 planı; veri konumu: Türkiye)
- Önceki kararlar: ADR-0001 (Fastify API), ADR-0003 (Windows masaüstü), ADR-0011 (para birimi ve şifreleme)
- Kısmen değiştirdiği: ADR-0003 (aşağıda §1)

## Bağlam
Canlıda Meta, yeni lead'leri (Anında Form) ve WhatsApp, Messenger ve Instagram mesajlarını internetten erişilebilen bir
HTTPS adresine (webhook) gönderir. ADR-0003 ürünü yalnızca Windows bilgisayarda çalışan bir masaüstü programı olarak
tanımlamıştı; bu hâliyle ürün 7/24 lead alamaz. Kodda ayrıca üç eksik vardı:
- Kuyruk yoktu: webhook işlemesi hata verirse teslim kaybolurdu.
- Web tarafında yapılandırılmış günlük yoktu.
- Sunucu paketi yoktu.

Genel incelemede ek olarak şu bulundu: Meta sayfaları uygulamaya abone edilmiyordu, dolayısıyla canlıda lead
bildirimi hiç gelmeyecekti.

## Karar

### 1. Sunucu merkezli mimari; veri Türkiye'de
- **Merkez sunucu:** Ürünün merkezi tek bir Linux sunucudur. Üzerinde panel (Next.js), arka plan işçisi (meta-sync),
  PostgreSQL ve HTTPS vekili (Caddy) çalışır.
- **Masaüstü:** Masaüstü programı (ADR-0003) bu sunucuya bağlanan bir istemci olarak kalır. Verinin kullanıcı
  bilgisayarında durması kuralı bu kararla kaldırılır.
- **Veri konumu:** Hasta verisi ve yedekler Türkiye'deki bir veri merkezinde tutulur (ürün sahibi kararı, KVKK).
  Sağlayıcı seçimi ürün sahibindedir.

### 2. Paketleme
- **İmajlar:** Kök `Dockerfile` üç hedef üretir: `web` (Next.js standalone çıktı), `worker` ve `tools` (göç ve ilk
  kullanıcı).
- **Kurulum dosyaları:** `deploy/docker-compose.prod.yml` ve `deploy/Caddyfile` (otomatik Let's Encrypt).
  Ayrıca `deploy/.env.production.example`, `deploy/backup.sh` (günlük `pg_dump`, 14 gün) ve `deploy/restore.sh`.
- **Kılavuz:** `docs/runbook.md`.
- **Rust'sız Prisma istemcisi:** `engineType = "client"` + `@prisma/adapter-pg`. İmaja sorgu motoru ikili dosyası
  girmez; geliştirme, test ve üretim aynı istemciyi kullanır. Daha önce testler yalnızca geçici bir yönlendirme
  kancasıyla bu istemciyi kullanıyordu. Sürücü bağdaştırıcısı benzersizlik ihlalinde sütunları `meta.target` yerine
  `driverAdapterError` içinde verdiği için okuma `uniqueViolationFields` yardımcısında birleştirildi.
- **Sağlık ucu:** `GET /api/health` (oturumsuz, yalnızca sayılar) döner:
  - `ok`;
  - `degraded`: 15 dakikadan eski bekleyen ya da kalıcı başarısız teslim;
  - `down`: veritabanına ulaşılamıyor.

### 3. Webhook kuyruğu: PostgreSQL (Redis/BullMQ yerine)
- **İşleyiş:** İmzası doğrulanan Meta gövdesi işlenmeden önce `WebhookDelivery` tablosuna şifreli yazılır, sonra aynı
  istekte işlenir.
- **Hata olursa:**
  - Meta'ya yine 200 `{ queued: true }` döner.
  - Web sürecindeki süpürücü (`instrumentation.ts`, dakikada bir) 1, 5, 30, 120 ve 360 dakika sonra yeniden dener.
    Ardından teslim `FAILED` olur.
  - Sahiplenme `FOR UPDATE SKIP LOCKED` ile yapılır; birden çok sunucu örneğinde güvenlidir.
- **Saklama:** İşlenen gövde hemen silinir. DONE satırlar 7, FAILED satırlar 30 gün sonra temizlenir.
- **Neden Redis değil:** Spec §4 Redis + BullMQ öneriyor. Tek sunuculu pilotta PostgreSQL tabanlı kuyruk şunları sağlar:
  - teslim, veriyle aynı veritabanında kalıcıdır; Redis kapanınca teslim kaybolmaz;
  - işletilecek bir hizmet daha eklenmez;
  - işleme zaten idempotenttir (mesaj ve leadgen kimliği benzersiz).

  Hacim büyür ya da iş türü çoğalırsa BullMQ'ya geçiş ayrı bir karardır.
- **Kapsam dışı:** Giden WhatsApp gönderiminin yeniden denenmesi bu turda yok (remaining-work §6).

### 4. Günlük ve hata kaydı
- **Web:** pino, tek satırlık JSON. `console` çağrılarının hepsi günlüğe taşındı. `onRequestError` sunucu hatalarını
  yol ve hata özetiyle yazar; sorgu dizesi yazılmaz.
- **Maskeleme:** Kişisel veri ve gizli alan adları her derinlikte `[gizli]` olur.
- **İşçi:** Her turun özetini ve hatayı günlüğe yazar. Önceden tur hataları sessizce yutuluyordu.
- **Sentry bağlanmadı:** Bunun için hata kayıt hizmetinin (ve veri konumunun) seçilmesi gerekir. Günlükler kapsayıcı
  günlük sürücüsünden okunur.

### 5. Güvenlik sıkılaştırması
- **Güvenlik başlıkları:** Çerçeveleme yasağı, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS ve dar bir CSP
  (`frame-ancestors`, `base-uri`, `object-src`, `form-action`). Betik kaynakları için nonce'lu CSP ayrı bir iştir.
  `X-Powered-By` kapalı.
- **Üretim yapılandırma denetimi genişletildi:** Canlı Meta ile çalışırken şunlar olmadan sunucu başlamaz:
  - `META_APP_SECRET`;
  - `https://` ile başlayan `AUTH_URL`;
  - varsayılan olmayan `DATABASE_URL`.

### 6. Meta sayfa aboneliği
- **Abonelik:** OAuth dönüşünde, erişim anahtarı olan her sayfa `POST /{page-id}/subscribed_apps` ile abone edilir.
  Alanlar `leadgen`; Messenger izni varsa `messages` da. Başarısızlık sayfa bağlantısının `lastError` alanına yazılır.
- **İzin:** `pages_read_engagement` OAuth izinlerine eklendi. Kaynak ve doğrulanmamış nokta: `docs/meta-constraints.md`
  (2026-09-29).

### 7. Canlıya geçiş sayfası (`/go-live`, yalnızca hesap sahibi)
- **Sunucu ayarları:** Değerler gösterilmez; yalnızca varlık ve biçim denetlenir.
- **Meta bağlantısı (canlı, salt okunur, saatte 10 kez):** Anahtar geçerliliği ve süresi, zorunlu izinler, okunabilen
  reklam hesapları, sayfa aboneliği, piksel ve WhatsApp eşlemesi. Her çalıştırma denetim kaydına yazılır.
- **Uçtan uca kanıtlar:** Kapalı yayın, webhook ile gelen lead, WhatsApp mesajı alma ve gönderme. Deneme modunda
  sayılmaz.
- **Test kampanyası:** Ayrı bir test kampanyası aracı yazılmadı. Kapalı yayın, gerçek onay akışıyla yapılır; kampanya
  PAUSED yüklenir ve etkinleştirilmedikçe harcama olmaz.

## Sonuçlar
- **Doğrulama (bu ortam):**
  - Kod doğrulaması: tip denetimi, lint, tüm test takımları (Rust'sız istemci, yönlendirme kancası olmadan).
  - Üretim derlemesi.
  - Standalone sunucunun gerçek veritabanıyla açılması: sağlık ucu, güvenlik başlıkları, imzalı webhook'un kuyruğa
    yazılıp işlenmesi, imzasız webhook'a 401.
  - İşçinin bir tur çalışması.
  - Compose dosyasının doğrulanması (`docker compose config`).
- **Doğrulanmayan:** Docker imajlarının derlenmesi (bu ortamdan Docker Hub'a erişim kapalı). İlk kurulumda sunucuda
  denenmeli.
- **Açık işler ve ürün sahibi kararları** (`docs/remaining-work.md` §0 ve §1, `docs/app-review.md`):
  - barındırma sağlayıcısı ve alan adı;
  - Meta işletme doğrulaması ve App Review;
  - Business Manager seçimi;
  - pilot klinik reklam hesabı;
  - hata kayıt hizmeti.
- **Yeni göç:** `20260929090000_webhook_delivery_queue`.
- **Yeni bağımlılıklar:** `@prisma/adapter-pg`, `pg`, `pino`.
