# Kalan İşler ve Bilinen Riskler

Son güncelleme: 2026-09-26 (spec denetimi + düzeltme turu). Bu dosya `docs/spec.md` ile kod
arasında **hâlâ açık** olan maddeleri tutar; kapatılan maddeler buraya yazılmaz (git geçmişi ve
ADR'ler yeterli). Her maddede öncelik (P0/P1/P2), ilgili spec bölümü ve önerilen yaklaşım vardır.

## 0. Operatör adımları

2026-09-26 tarihinde yerelde tamamlananlar: `pnpm install`, `db:generate` + `@admedic/database` build,
`db:deploy` (21/21 migration uygulandı; `20260926090000_webhook_idempotency_and_routing` ve
`20260926100000_spec_gap_followups` dahil), `.env` → `.env.example` ile eşitlendi (`META_WEBHOOK_VERIFY_TOKEN`
ve `API_TOKEN` yerel geliştirme için rastgele üretildi, `ENCRYPTION_KEY` 64 hex), artık dosyalar silindi,
`pnpm db:seed` (kuruş birimli demo veri), `STUDIO_DB_TEST=1 pnpm verify` (46/46 görev yeşil).

Bu sırada bulunan ve düzeltilen iki hata: `EnvSchema` varsayılanlı alanlarda (`NODE_ENV`, `LOG_LEVEL`,
`APP_NAME`, `AUTH_SECRET`, `AUTH_URL`) `.env.example`'ın izin verdiği boş string'i reddediyordu;
`resolveVerifyToken` process.env'de açıkça boş bırakılan belirteç için `.env` önbelleğine düşüyordu.

**Hâlâ açık:**

1. Meta uygulama panelinde webhook URL'si `https://<host>/api/webhooks/meta` ve doğrulama belirteci
   (`META_WEBHOOK_VERIFY_TOKEN`); Stripe panelinde webhook imza gizli anahtarı (`STRIPE_WEBHOOK_SECRET`).
2. Canlı veritabanında API ile oluşturulmuş eski kampanya bütçeleri major birimde kalmış olabilir; ADR-0011'deki
   tek seferlik `UPDATE` operatör kararıyla uygulanır (yerel demo veritabanı seed ile yenilendiği için gerekmedi).
3. Yerel `.env` içinde `AUTH_SECRET` yenilendi; çalışan `next dev` oturumları yeniden giriş ister.

## 1. Mimari (spec §4) — P1

- **Kuyruk yok (Redis + BullMQ):** webhook işleme, karşılama/LLM çağrısı ve WhatsApp gönderimi istek içinde
  çalışır (`web/app/_lib/webhook-ingest.ts`, `maxDuration=60`); insights/anomali/asistan işleri 5 dk'lık
  `setInterval` ile (`workers/meta-sync`). Öneri: `REDIS_URL` + BullMQ kuyrukları (`webhook-ingest`,
  `insights-sync`, `assistant-reply`, `capi-events`), yeniden deneme + ölü mektup; webhook yalnızca
  imzayı doğrulayıp ham olayı kuyruğa atar.
- **Gözlemlenebilirlik:** web tarafında pino/Sentry yok; `respond()` yalnızca PII içermeyen kısa bir
  `console.error` satırı yazar. Öneri: `pino` + `redact` (apps/api'de var) web route handler'larına da,
  Sentry DSN env ile.
- **CI yok (Faz 0):** ADR-0003 rev.2 ile GitHub bırakıldı; yerelde `pnpm verify` tek kapı. Öneri: en
  azından pre-push hook veya yerel bir `verify` zorunluluğu; GitHub'a dönülürse Windows runner'da Tauri build.
- **Playwright:** yalnızca stüdyo akışı (`web/e2e/studio.pw.ts`). Lead CRM, kampanya yayınlama, Meta
  bağlantı ekranları için E2E yok.
- **ESLint:** `react-hooks` eklentisi kurulu değil (pnpm add bu turda yapılmadı); `no-console` kapalı.
- **Paket bağımlılıkları:** `packages/stripe` `stripe@^16` (web `^22`) ve `@admedic/config`'e bağlı
  değil (tsconfig `paths` ile derleniyor); `packages/database` kullanılmayan `stripe` bağımlılığı;
  `packages/platforms` kullanılmayan `@admedic/shared`. `web` plan tablosunu `packages/stripe/src/plans.ts`'ten
  göreli import eder — `@admedic/stripe` workspace bağımlılığı eklenip import düzeltilmeli.

## 2. Meta bağlantısı (spec 3.1) — P0/P1

- WhatsApp Business Account / `phone_number_id` **otomatik keşfi yok**; `PATCH /api/meta/connections/[id]`
  ile elle girilir (Meta Bağlantılar sayfası). `whatsapp_business_management` izni App Review ister.
- Facebook Login for Business `config_id` gerekliliği canlı doğrulanmadı (`docs/meta-constraints.md`);
  gerekiyorsa `META_LOGIN_CONFIG_ID` EnvSchema'ya eklenip `GET /api/meta/oauth` URL'sine yazılmalı.
- `auth_type=rerequest` (reddedilen izinleri yeniden isteme) dialog'a eklenmedi.
- Canlı doğrulama: OAuth uçları, `/me/permissions`, sayfa token'ları, `debug_token` App Review ile gerçek
  hesapta uçtan uca test edilmedi (mock modda test edildi).
- `web/app/api/meta/connections/[id]/refresh/route.ts` bu turda değiştirilemedi (derinlik kısıtı); mantık
  `meta-connection.ts`'te olduğundan davranış güncel, ancak dosya gözden geçirilmeli.

## 3. Klinik profili (spec 3.2) — P1

- `ServiceCategory` enum'u spec işlemlerini (saç ekimi, diş, estetik, göz, bariatrik, check-up) ifade
  etmiyor → enum genişletmesi + migration.
- Yetki belgesi yalnızca `licenseNumber`; veriliş/bitiş tarihi ve belge dosyası yok.
- `MarketTarget` ülke başına tek dil (`@@unique([clinicId, country])`); "Almanya → DE/TR" için çoklu dil
  gerekiyor. Planlayıcı bu sınırı ülke→dil haritasıyla aşıyor (`campaign-plan.ts`).
- Profil bağlamı üretimde kısmen kullanılıyor (ton, diller, hizmet adları, yasaklı ifadeler);
  akreditasyon, paket içeriği, "başlangıç fiyatı göster" bilgisi prompta girmiyor.
- `web/app/api/clinics/[id]/targets/[country]/route.ts` değiştirilemedi (derinlik); dil enum kopyası
  `@admedic/llm` `BriefLanguageEnum` ile senkron tutulmalı.

## 4. Kampanya planlama ve yayın (spec 3.3, 3.6) — P0/P1

- **Planlayıcı deterministik**, LLM ajanı değil: doğal dil `brief` plana yazılıyor ama işlenmiyor.
  Öneri: `packages/agents/campaign-planner` (Zod girdi/çıktı, `lead-assistant` ile aynı `callWithLog`),
  deterministik plan = güvenlik zemini, LLM = gerekçe ve öneri katmanı.
- **Meta'ya yalnızca kampanya yazılır**; ad set/ad/hedefleme (`geo_locations`, sayısal `locales`
  kimlikleri, yaş) Meta'ya gönderilmiyor. `plan.adSets` üretiliyor; `createAdSet` istemci fonksiyonu +
  yayın adımı gerekiyor. ODAX objective eşlemesi (`OUTCOME_*`) canlı doğrulanmadı.
- Aylık üst sınır **taslak bazında** (`günlük×30`); diğer aktif kampanyaların toplamı eklenmiyor.
- Spec 3.6 "yalnızca Tenant Owner": ACTIVATE ve bütçe artışı OWNER **ve ADMIN** tarafından yapılabiliyor;
  yetki devri kaydı (delegation) yok.
- `StudioStatus`'ta ARCHIVED yok; kampanya ARCHIVE yalnızca ACTIVE/PUBLISHED_PAUSED'dan.
- 3 ondalıklı para birimleri (KWD/BHD): worker `toMinorUnits` ile doğru; kampanya/bütçe rotaları hâlâ
  `×100` varsayar (`AdAccount.currency` ölçeği rotalara taşınmalı).

## 5. Kreatif ve politika (spec 3.4, 3.5) — P1

- Görsel brief ve format uyarlama (1:1, 4:5, 9:16) mock (`/api/creative/adapt` gerçek üretim/yükleme yok).
- Yerelleştirme dil bazlı; spec "pazar bazlı ayrı prompt" ister (DE için Almanya vs Avusturya ayrımı yok).
- Veri modeli: `CreativeVariant`, `PolicyCheck`, `Approval` tabloları yok (JSON sütunlarında).
  Kreatif → Kampanya/Ad bağlantısı (`creativeId`) yazılmıyor; onaylı kopya kampanya onay akışına girmiyor.
- Meta red gerekçeleri tek `Campaign.metaRejectionReason` alanında; append-only tablo + kural
  iyileştirme raporu ve worker'da zamanlanmış `review-sync` (ad bazlı) yok.
- Politika motoru matcher kimlikleri V1 (şema enum'u); Unicode kelime sınırı değişikliği motor sürümüyle
  (`studio-policy-4`) izleniyor — ADR-0008'e not düşülmeli.

## 6. Lead CRM ve asistan (spec 3.7, 3.8) — P0/P1

- **Rıza lead'den alınmıyor:** Instant Form rıza alanı / bot akışında açık rıza kaydı yok; yalnızca panelden
  "Rıza Ver/Geri Çek". Öneri: form `field_data` içindeki rıza sorusunu ConsentRecord'a yazmak, bot ilk
  mesajında rıza metni + onay yanıtını kaydetmek.
- WhatsApp şablon kaydı (registry) ve pencere dışı gönderimde opt-in kontrolü yok; şablon adı elle girilir.
- `Lead.channel` serbest metin (enum değil).
- Messenger `HUMAN_AGENT` etiketi ve Instagram mesajlaşma izinleri App Review gerektirir; canlı doğrulanmadı.
- Lead Ads `GET /{leadgen_id}` çekimi `leads_retrieval` izni ister; token yoksa lead `pendingFetch` ile
  saklanır ve alanlar boş kalır (yeniden deneme işi yok).
- Asistan worker'ı ilk mesaj senaryosunu kapsamaz (karşılama webhook'ta); WhatsApp dışı kanallarda
  gönderim `messenger.ts` ile; SMS yok.
- Asistan gönderimi başarısız olursa (kanal hatası) OUTGOING kayıt son mesaj olduğu için yeniden deneme
  yapılmaz ve uyarı üretilmez (yalnızca LLM hatalarında uyarı var) → teslim hatası için retry + Alert.
- Çok kiracılı WhatsApp: giden mesajlar tenant'ın `MetaConnection.whatsappPhoneNumberId` + token'ı ile
  gider; eşleme yoksa ortam düzeyi tek numara (WHATSAPP_API_URL/TOKEN) kullanılır — çok kiracılı
  kurulumda her tenant için eşleme zorunlu tutulmalı (şu an sessizce ortak numaraya düşer).
- LLM asistan yanıtları serbest metin (Zod JSON değil); `packages/agents` paketi yok (mantık
  `packages/llm/src/assistant.ts` + `web/app/_lib/lead-assistant.ts`).

## 7. Ölçüm, öneri, rapor (spec 3.9, 3.10) — P1

- Insights günlük iş değil: 5 dk'da bir `last_7d` kampanya seviyesi; ad set/ad/ülke/dil kırılımı Meta'dan
  çekilmiyor (`byCountry/byLanguage` lead tablosundan). Throttle başlıkları (`X-FB-Ads-Insights-Throttle`)
  okunmuyor, yalnızca hata kodlarıyla atlama.
- CAPI: sağlık kategorisi için izinli olay listesi canlı Pixel ile doğrulanmadı; gönderim başarısızlığında
  yeniden deneme yok (`ConversionEvent` FAILED kaydı).
- Öneriler: `BUDGET_REALLOCATION` kampanya bütçesini kazanan payına ölçekler; varyant→reklam seti eşleşmesi
  olmadan gerçek dağıtım yapılamaz. Stüdyo deneyleri manuel ölçüm (`/api/experiments/[id]/sync` 409).
- Haftalık rapor: pazar/dil/kreatif kırılımı ve konsültasyon/tedavi dönüşüm oranı raporda yok.

## 8. Uyum ve güvenlik (spec 3.11) — P1

- Şema borçları: `Invoice.stripeInvoiceId` (+ `StripeEvent` tablosu; şimdilik AuditLog tabanlı eşleme ve
  dedupe), `Alert.ackedAt` (ACK sonrası 24 saat dedup `createdAt` üzerinden), `Conversation.metadata`
  (`pendingGreeting` `Lead.metadata`'da), `LlmCallLog.status` sütunu `LlmCallLogStatus` enum'una
  bağlanmalı (kod enum değerlerini yazıyor).
- `lookupHash` anahtarsız SHA-256 (pepper yok); GET yanıtlarından çıkarıldı ama DB'de brute-force
  riski sürer → HMAC(pepper) + telefon E.164 normalizasyonu (libphonenumber).
- Testlerde sabit `ENCRYPTION_KEY` fixture'ları (spec §6 "gizli anahtarları teste yazma") —
  `randomBytes` ile üretilmeli.
- Üretimde `META_MOCK_MODE` açıkça `false` yapılmalı (aksi halde başlatma reddedilir; demo sunucusu için
  `ALLOW_MOCK_IN_PRODUCTION=true`).
- Fastify API (`apps/api`) yalnızca `API_TOKEN` ile korunuyor; kiracı seçimi "ilk workspace"
  (masaüstü tek kiracı varsayımı, ADR-0003). Çok kiracılı kullanım için oturum/tenant seçimi gerekir.

## 9. Faturalandırma (spec 3.12) — P2

- Gerçek modda abonelik iptali / Stripe müşteri portalı ucu yok (FREE'ye geçiş açık Stripe
  aboneliğinde 409).
- Stripe API sürümü `2026-08-26.dahlia` tek yerde (`packages/stripe/src/plans.ts`); `stripe` paket
  sürümleri hizalanmalı.

## 10. Masaüstü (ADR-0003)

- Tauri `.exe` üretimi Windows'ta Rust toolchain ister; bu turda yalnızca kabuk kodu (XSS, CSP, belirteç)
  düzeltildi; build doğrulanmadı. `tauri.conf.json` hedefleri nsis/msi/app/dmg (platform dışı hedefler
  atlanır); `identifier` sabit `com.admedic.desktop`.

## 11. i18n (spec §4)

- Nav/layout/login/hesap TR–EN; sayfa içerikleri ve API hata mesajları hâlâ yalnızca Türkçe.
  `t()` altyapısı hazır (`web/app/_lib/i18n.ts`, çerez `ui-lang`).
