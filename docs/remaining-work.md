# Kalan İşler ve Bilinen Riskler

Son güncelleme: 2026-09-28 (kampanya sayfası ve performans toplama, ADR-0020; lead gelen kutusu ve devralma yetkisi, ADR-0019; "Bugün", Onaylar kutusu ve aşama şeridi, ADR-0018; tasarım temeli ve kabuk, ADR-0017; Faz 1 ve aydınlatma / açık
rıza ayrımı, ADR-0016).
Önceki: 2026-09-27 (ADR-0014, ADR-0015). Bu dosya `docs/spec.md` ile kod
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
4. **2026-09-27 turu için:** `pnpm db:generate && pnpm --filter @admedic/database build && pnpm db:deploy`
   (yeni migration `20260927090000_full_publish_and_spend_authority`, toplam 22). Ardından:
   - Klinik ve marka → Çalışma alanı ayarları'nda **aydınlatma metni bağlantısı** (https) — Instant Form yayını için zorunlu.
   - Kampanya Planlayıcı → **Harcama yetkisi** kartından, etkinleştirme/bütçe artışı yapacak ADMIN/MEDIA_BUYER
     üyelere Owner yetki verir (ADMIN rolü artık tek başına yetkili değil).
   - Meta bağlantısını yeniden yetkilendirin: OAuth kapsamına `pages_manage_ads` eklendi (Instant Form).
   - Birden fazla Facebook Sayfası bağlıysa reklam hesabı bağlantısına yayın sayfasının kimliği (Sayfa ID) girilmeli.
5. **2026-09-27 ikinci tur:** yeni migration `20260927150000_lead_consent_and_ad_review` (toplam 23) —
   `pnpm db:generate && pnpm --filter @admedic/database build && pnpm db:deploy` (veya `scripts\dev-up.cmd`).
   Meta uygulama panelinde **Require App Secret** açılabilir (tüm sunucu çağrıları artık `appsecret_proof` gönderir);
   açtıktan sonra bağlantı yenileme, insights senkronu, yayın ve lead çekimi canlı denenmeli. Bu turdan önce
   yayınlanmış Instant Form'lar için `LeadForm` kaydı yoktur: o formlardan gelen lead'lere rıza kaydı yazılmaz
   (formu yeniden yayınlamak gerekir).
6. **Güvenlik:** web testlerindeki sabit `ENCRYPTION_KEY` fixture'ı yerel `.env` anahtarıyla aynıydı ve git
   geçmişinde herkese açık. Testler artık rastgele anahtar üretiyor; yerel `ENCRYPTION_KEY` yenilenmeli
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) — şifreli token/iletişim alanları
   eski anahtarla okunamayacağı için `pnpm db:seed` ile yeniden tohumlayın ve Meta bağlantısını yeniden kurun.

7. **2026-09-28 (ADR-0016):** yeni migration `20260928180000_privacy_notice_text` (toplam 24) —
   `scripts\dev-up.cmd` veya `pnpm db:generate && pnpm --filter @admedic/database build && pnpm db:deploy`.
   Uygulanmadan `/clinic` ayarları yüklenmez (503). Ardından Klinik ve marka → Çalışma alanı ayarları'nda
   aydınlatma metni ve açık rıza metni ayrı ayrı girilmeli; taslak metinler hukuki onaydan geçmeli (ADR-0016 §4).

8. **2026-09-28 Faz 2 (ADR-0017):** yeni paketler (`@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-sans-arabic`,
   `lucide-react`) için depo kökünde `pnpm install` çalıştırın; migration yok.

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
- **Tam yayın canlı doğrulanmadı** (ADR-0014): ad set/lead formu/kreatif/reklam gövdeleri resmi belgelerle
  kuruldu ve mock'ta uçtan uca test edildi; gerçek hesapta ODAX (`OUTCOME_LEADS` + ON_AD, WhatsApp + CONVERSATIONS,
  Sales + WEBSITE + LINK_CLICKS / piksel gereksinimi), lead formu locale değerleri, adlocale adları ve Meta'nın
  ad set başına asgari günlük bütçesi doğrulanmalı (`docs/meta-constraints.md`, 2026-09-27). `appsecret_proof`
  artık tüm sunucu çağrılarında (ortam düzeyi WhatsApp token'ı hariç); "Require App Secret" açıkken canlı
  doğrulanmalı (ADR-0015).
- Yalnızca tek görselli reklam: video, carousel ve format uyarlama (1:1/4:5/9:16) yok; görsel başına tek kreatif.
- Sayfa seçimi arayüzü yok: birden fazla sayfada reklam hesabı bağlantısına Sayfa ID elle girilir. WhatsApp
  reklamında sayfanın WhatsApp numarasına bağlı olduğu denetlenmiyor (Meta hatası yayın adımında görünür).
- Yayınlanan içerik değiştirilemez: yeni metin/görsel için kampanya arşivlenip yeniden oluşturulur (Meta'da
  kreatif güncelleme akışı yok); reddedilen reklam için "düzelt ve yeniden gönder" akışı da yok.
- Reklam incelemesi yalnızca Admedic'in yayınladığı (yerelde `Ad.metaAdId` olan) reklamlarda senkronlanır; Ads
  Manager'da kurulup senkronlanan kampanyaların reklamları yerele alınmadığı için incelenmez. WITH_ISSUES için
  uyarı üretilmez (panelde görünür); ad set düzeyi sorunlar (`issues_info`) okunmuyor.
- Aylık üst sınır kur çevrimi yapmaz (yalnızca aynı para birimli hesaplar toplanır); Meta'dan senkronlanan
  ABO kampanyanın bütçesi yalnızca ilk içe aktarmada ad set toplamından yazılır (sonraki değişiklikler için
  ad set senkronu gerekir).
- Harcama yetkisi devrinde süre sınırı yok (Owner geri alana kadar geçerli); üye/rol yönetimi arayüzü yok
  (rol değişimi veritabanından; etkin yetki rol değişince kendiliğinden düşer).
- `StudioStatus`'ta ARCHIVED yok; kampanya ARCHIVE yalnızca yayındaki veya yayını yarım kalmış kampanyadan.
- 3 ondalıklı para birimleri (KWD/BHD): worker `toMinorUnits` ile doğru; kampanya/bütçe rotaları hâlâ
  `×100` varsayar (`AdAccount.currency` ölçeği rotalara taşınmalı).

## 5. Kreatif ve politika (spec 3.4, 3.5) — P1

- Görsel brief ve format uyarlama (1:1, 4:5, 9:16) mock (`/api/creative/adapt` gerçek üretim/yükleme yok).
- Yerelleştirme dil bazlı; spec "pazar bazlı ayrı prompt" ister (DE için Almanya vs Avusturya ayrımı yok).
- Veri modeli: `CreativeVariant`, `PolicyCheck`, `Approval` tabloları yok (JSON sütunlarında). Onaylı
  stüdyo taslakları artık kampanyaya değişmez kopya olarak bağlanıyor (`Campaign.content`, `Ad.creative.key`
  = taslak:varyant); `/api/creative` ile üretilen `Creative` kayıtları ise kampanyaya bağlanamıyor (`Ad.creativeId` boş).
- Meta red gerekçeleri reklam düzeyinde (`Ad.metaReviewFeedback`) ve append-only `META_AD_DISAPPROVED` denetim
  kayıtlarında tutuluyor (ADR-0015); bunlardan kural iyileştirme raporu (hangi politika anahtarı hangi ifadeyle
  reddedildi → `policy_rules` önerisi) üretilmiyor.
- Politika motoru matcher kimlikleri V1 (şema enum'u); Unicode kelime sınırı değişikliği motor sürümüyle
  (`studio-policy-4`) izleniyor — ADR-0008'e not düşülmeli.

## 6. Lead CRM ve asistan (spec 3.7, 3.8) — P0/P1

- **Pazarlama/ölçüm rızası formda yok:** Instant Form kutusu yalnızca "talebe yanıt ve iletişim için veri işleme"
  onayıdır ve `DATA_PROCESSING` olarak kaydedilir (ADR-0015); CAPI için gereken pazarlama rızası hâlâ yalnızca
  panelden ("Açık rızayı kaydet", kanıt zorunlu — ADR-0016). Öneri: formda ayrı, isteğe bağlı ikinci kutu (metni
  hukuki onaydan geçmeli) → `MARKETING`. Zorunlu kutunun İlke Kararı 2026/347 ile uyumu açık soru (ADR-0016 §4).
  Bot akışında açık rıza kaydı yok. Rıza metni Türkçe dışı formlarda genel yerel metindir; dil başına kuruluş rıza
  metni ayarı yok. Zorunlu kutunun Meta yanıtında dönüp dönmediği canlı doğrulanmalı (`docs/meta-constraints.md`).
- WhatsApp şablon kaydı (registry) ve pencere dışı gönderimde opt-in kontrolü yok; şablon adı elle girilir.
- `Lead.channel` serbest metin (enum değil).
- Messenger `HUMAN_AGENT` etiketi ve Instagram mesajlaşma izinleri App Review gerektirir; canlı doğrulanmadı.
- Lead Ads `GET /{leadgen_id}` çekimi `leads_retrieval` izni ister; çekilemeyen lead `pendingFetch` ile saklanır ve
  OAuth dönüşünde, aynı kuruluşa sorunsuz yeni lead geldiğinde ve panelden yeniden denenir (ADR-0015). Zamanlanmış
  (worker) yeniden deneme yok: hiç yeni lead gelmeyen ve bağlantısı yenilenmeyen kuruluşta lead panelden çekilmeli
  (çekim mantığı web'de; worker'a taşımak için normalizasyon paylaşılan pakete alınmalı).
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
