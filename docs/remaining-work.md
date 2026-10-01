# Kalan İşler ve Bilinen Riskler

Son güncelleme: 2026-10-01 (Windows/iOS ince istemci, ADR-0025; sesli arama hazırlığı, ADR-0026; asistana üslup
örnekleri, ADR-0027; lead takımı, ADR-0029). Önceki: 2026-09-29 (Faz 7-A canlıya hazırlık: sunucu paketi, webhook kuyruğu, günlük, sayfa aboneliği,
Canlıya geçiş sayfası, ADR-0023; altı fazın genel incelemesi ve düzeltmeleri, ADR-0022; 2026-09-28: içerik taraması ve otomatik erişilebilirlik kapısı, ADR-0021; kampanya sayfası ve performans toplama, ADR-0020; lead gelen kutusu ve devralma yetkisi, ADR-0019; "Bugün", Onaylar kutusu ve aşama şeridi, ADR-0018; tasarım temeli ve kabuk, ADR-0017; Faz 1 ve aydınlatma / açık
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

9. **2026-09-28 Faz 6 (ADR-0021):** yeni geliştirme bağımlılığı `axe-core` (erişilebilirlik kapısı) için depo kökünde
   `pnpm install`. Kapı: `STUDIO_E2E=1 pnpm --filter web test:e2e` (veritabanı gerekir).

10. **2026-09-29 genel inceleme (ADR-0022):** migration yok. Demo uyarı metinleri tohum verisinde Türkçeleştirildi;
    yerel demo veritabanında eski metinlerin ("ROAS -52%", "ad_1_1_2") yenilenmesi için `pnpm db:seed` gerekir.

11. **2026-09-29 Faz 7-A (ADR-0023):** yeni migration `20260929090000_webhook_delivery_queue` (toplam 25) ve yeni
    bağımlılıklar (`@prisma/adapter-pg`, `pg`, `pino`, işçide `tsx`) — depo kökünde `pnpm install` ve
    `scripts\dev-up.cmd` (PostgreSQL yoksa önce `scripts\setup-postgres.cmd`: kurar, veritabanını ve `.env`'yi hazırlar). Prisma artık Rust'sız istemci kullanır (sorgu motoru indirilmez). Canlıya geçiş için sırayla:
    - **Ürün sahibi:** Türkiye'de barındırma sağlayıcısı ve sunucu, alan adı, Meta işletme doğrulaması, uygulamanın
      bağlı olacağı Business Manager, pilot klinik reklam hesabı (`docs/app-review.md`).
    - **Kurulum:** `docs/runbook.md` (Docker Compose; imaj derlemesi bu ortamda denenemedi, ilk kurulumda doğrulanacak).
    - **Denetim:** panelde Ayarlar → Canlıya geçiş; engel kalmayınca uçtan uca deneme ve App Review.
    - Mevcut Meta bağlantıları yeniden kurulmalı: sayfa webhook aboneliği ve `pages_read_engagement` izni bağlanırken alınır.

12. **2026-10-01 (ADR-0025, 0026, 0027, 0029):** iki yeni göç — `20261001090000_voice_calls_and_assistant_examples` ve
    `20261001100000_lead_team` (toplam 27) — ve yeni paketler (`@admedic/voice`, `@admedic/lead-team`). Depo kökünde
    `pnpm install`, ardından `scripts\dev-up.cmd` (ya da `pnpm db:generate && pnpm --filter @admedic/database build &&
    pnpm db:deploy`). Göçten sonra çalışan `pnpm web:dev` yeniden başlatılmalı (eski Prisma istemcisiyle ayarlar
    sayfası 503 verir).
    - Yerel `.env` içinde `ENCRYPTION_KEY` boştu; telefonlu ya da e-postalı lead kaydı oluşturulamıyordu. 2026-10-01'de
      rastgele bir anahtar üretildi (veritabanında şifreli veri yoktu).
    - Windows paketini derlemek için Rust ve Visual Studio C++ derleme araçları kuruldu; komutlar `desktop/README.md`.
    - **Ürün sahibi (canlı aramadan önce):** ElevenLabs ile sağlık verisi için yazılı anlaşma, aydınlatma metninin
      yurt dışı aktarımı ve sesli aramayı kapsaması, arama saatlerinin ülke bazında hukuki doğrulaması (ADR-0026).
    - **Ürün sahibi:** Windows kurulum dosyası için kod imzalama sertifikası; iOS mağaza yayını isteniyorsa Mac,
      Apple Developer hesabı ve "yalnızca web sitesi saran uygulama" reddi riskine karşı karar (ADR-0025).

13. **2026-10-01 — saklama süresi işi artık gerçekten siliyor (ADR-0006 güncellemesi):** `anonymizeExpiredLeads`
    daha önce hiçbir normal lead'i seçmiyordu; düzeltildi. Göç yok. Lead'i olan bir veritabanında işçiyi (`worker`)
    başlatmadan ya da güncellemeden önce kaç lead'in etkileneceğine bakın:
    `DRY_RUN=1 pnpm --filter @admedic/web retention:run`. İşlem geri alınamaz. Süre son etkinlikten sayılır (lead
    güncellemesi, mesaj ya da sesli arama) ve `Organization.retentionDays` ile ayarlanır (varsayılan 365 gün).
    - **Ürün kararı açık:** tedavi görmüş (`TREATED`) hastalar da aynı süreyle anonimleştirilir. Sağlık kayıtları için
      ayrı bir saklama süresi gerekiyorsa aşamaya göre kural eklenmeli (hukuki inceleme).

## 1. Mimari (spec §4) — P1

- **Kuyruk kısmi (ADR-0023):** Meta webhook teslimleri PostgreSQL kuyruğunda kalıcı ve yeniden denenir
  (`webhook-queue.ts`). İşleme hâlâ istekte başlar (karşılama/LLM dahil, `maxDuration=60`). Giden WhatsApp gönderimi,
  CAPI olayları ve asistan teslim hatası için yeniden deneme yok. insights/anomali/asistan işleri 5 dk'lık
  `setInterval` ile (`workers/meta-sync`). Hacim büyürse BullMQ'ya geçiş ayrı karar.
- **Gözlemlenebilirlik (ADR-0023):** web ve işçi pino ile tek satırlık JSON yazar (maskeli); `onRequestError` sunucu
  hatalarını kaydeder; `/api/health` dış izleme içindir. Hata kayıt hizmeti (Sentry vb.) bağlanmadı: sağlayıcı ve veri
  konumu ürün sahibi kararı. Uyarı kanalı yok (sağlık ucu `degraded` olunca kimseye bildirim gitmez).
- **CSP dar:** Güvenlik başlıkları var; betik/stil kaynakları için nonce'lu içerik güvenliği politikası yok.
- **CI yok (Faz 0):** ADR-0003 rev.2 ile GitHub bırakıldı; yerelde `pnpm verify` tek kapı. Öneri: en
  azından pre-push hook veya yerel bir `verify` zorunluluğu; GitHub'a dönülürse Windows runner'da Tauri build.
- **Playwright:** stüdyo akışı (`web/e2e/studio.pw.ts`) ve 24 sayfalık erişilebilirlik kapısı (`web/e2e/a11y.pw.ts`,
  ADR-0021). Lead yanıtlama, kampanya yayınlama ve Meta bağlantısı için uçtan uca akış testi yok; rol başına
  gezinme de otomatik değil (ADR-0022'de elle yapıldı).
- **Kabuk yoklaması ağır:** `/api/shell` sekme başına dakikada bir çalışır ve her seferinde kapanmamış lead'lerin en
  yeni 500'ünü konuşmalarıyla okur (`inbox.ts` `needsReplySummary`). Öneri: konuşmaya "yanıt bekliyor" alanı
  (denormalize) ya da sayaç önbelleği; çok lead'li kuruluşta ölçülmeli.
- **Gün sınırı UTC:** `sinceDays`, "Bu ayın harcaması" ve performans sekmesi UTC gününe göre hesaplar; İstanbul'da
  00:00–03:00 arası "bugün" önceki gün sayılır. Öneri: tek bir `istanbulDayStart` yardımcısı (insight satırları Meta
  hesabının saat dilimiyle yazıldığı için hesap saat dilimiyle birlikte ele alınmalı).
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
- **Gelen kutusu listesi:** en yeni 100 lead + daha eski ama yanıt bekleyen lead'ler (rozetle aynı küme, ADR-0022);
  daha eski lead'lere sayfalama ve sunucu tarafı arama yok. "Yanıt bekliyor" kümesi kapanmamış lead'lerin en yeni
  500'ü üzerinden hesaplanır.
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
- **Okuma API'lerinde rol ayrımı kısmi (ADR-0022):** hasta mesajları yalnızca bakım rollerine, lead kayıtları izleyici
  dışındaki rollere, uyarılar menüyle aynı kapsamda açık. Analist lead adlarını ve ilgilendiği hizmeti görür (menüde
  Lead'ler var; iletişim bilgileri maskeli). Ad maskeleme ya da analiste yalnızca toplu görünüm ürün kararıdır.
  Kampanya, politika ve ayar okuma uçları (ör. `GET /api/campaigns`, `GET /api/policies`) her role açık; sayfalar
  menüde olmayan role açıklama gösterir ama API okuması engellenmez.
- 3 ondalıklı (KWD, BHD…) ve ondalıksız (JPY…) para birimleri arayüzde (`format.ts`) hâlâ /100 ile gösterilir;
  worker `minorUnitFactor` ile doğru yazar (ADR-0011 sınırı). Körfez pazarında KWD hesabı açılmadan önce düzeltilmeli.
- Fastify API (`apps/api`) yalnızca `API_TOKEN` ile korunuyor; kiracı seçimi "ilk workspace"
  (masaüstü tek kiracı varsayımı, ADR-0003). Çok kiracılı kullanım için oturum/tenant seçimi gerekir.

## 9. Faturalandırma (spec 3.12) — P2

- Gerçek modda abonelik iptali / Stripe müşteri portalı ucu yok (FREE'ye geçiş açık Stripe
  aboneliğinde 409).
- Stripe API sürümü `2026-08-26.dahlia` tek yerde (`packages/stripe/src/plans.ts`); `stripe` paket
  sürümleri hizalanmalı.

## 10. Masaüstü ve iOS (ADR-0003, ADR-0025)

- Windows paketi derlendi ve yerel panele karşı denendi (2026-10-01). Açık kalanlar: kurulum dosyasının temiz bir
  makinede kurulup kaldırılması, kod imzalama (imzasız dosyada SmartScreen uyarısı), macOS paketi.
- **iOS hiç derlenmedi ve denenmedi:** Tauri iOS yalnızca macOS + Xcode ile derlenir. Adımlar ve ilk derleme denetim
  listesi `desktop/README.md` "iOS". Ana ekrana ekleme (PWA) de gerçek iPhone'da denenmedi.
- `viewport-fit=cover` eklenmedi: çentikli telefonda üst çubuk yerleşimi gerçek cihazda görülmeden değiştirilmedi.
  Alt sekme çubuğundaki `env(safe-area-inset-bottom)` bu yüzden şimdilik 0 döner.
- `apps/api` artık kabuğun veri kaynağı değil (ADR-0025 §1); kaldırılması ayrı karar.

## 10.1 Sesli arama (ADR-0026)

- Gerçek ElevenLabs hesabıyla hiçbir şey denenmedi: giden arama, geçersiz kılmalar, dil kodları, webhook imzası
  (`docs/elevenlabs-constraints.md` "Doğrulanamayanlar"). İlk kurulumda `docs/runbook.md` "Deneme" adımı zorunlu.
- Telefonla aranma rızası yalnızca panelden kaydediliyor; Anında Form'a ayrı bir rıza kutusu eklenmedi.
- Arama saatleri tablosu (`packages/voice/src/eligibility.ts`) 24 ülke kodu içerir; listede olmayan ülke aranmaz.
- Arama sonucuna göre koordinatöre uyarı açılmıyor; toplu arama (batch) API'si kullanılmıyor.
- Sesli ajana konuşma örneği verilmiyor (ADR-0027 §5).

## 10.2 Lead takımı (ADR-0029)

- Gerçek LLM ile çalıştırılmadı; öneri kalitesi, süre ve token maliyeti ölçülmedi.
- Onaylanan öneriden kampanya taslağı üretilmiyor; kullanıcı Yeni kampanya sayfasında yeniden giriyor.
- `/lead-team` erişilebilirlik kapısına (`web/e2e/a11y.pw.ts`) eklenmedi; sayfa metinleri yalnızca Türkçe.
- Çalıştırma web sürecinde yürür; sunucu yeniden başlarsa yarıda kalır (20 dakika sonra başarısız işaretlenir).

## 11. i18n (spec §4)

- Kabuk, menü, sayfa başlıkları ve oturum açma TR–EN; sayfa içerikleri ve API hata mesajları hâlâ yalnızca
  Türkçe. Altyapı ve geçiş taslağı: `docs/i18n-sayfa-metinleri.md` (ADR-0021).
