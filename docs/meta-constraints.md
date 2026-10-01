# Meta API Kısıtları / Constraint Kaydı

Bu dosya, Meta Marketing API entegrasyonunda karşılaşılan davranış hakkında **tarihli** notları barındırır.
Kural (spec §6): emin olmadığın her konuda güncel resmi dokümantasyona bak, tahminle entegrasyon yazma.

---

## 2026-09-16 — İlk entegrasyon notları

### Sürüm ve zaman çizelgesi
- Güncel Graph API sürümü: **v26.0** (28 Temmuz 2026 itibarıyla publish edildi). Varsayılan olarak v26.0 hedefleniyor.
- **Otomatik yükseltme:** Meta, "Marketing API auto-upgrade" sürecinde eski sürümlere de yeni davranış/alanları uygulayabilir. v26 değişikliklerinin tüm desteklenen sürümlere uygulanacağı tarih ~27 Ekim 2026 olarak duyuruldu; bu tarihten önce entegrasyon davranışı veya rate limit kuralları değişebilir.
- Kaynak: https://developers.facebook.com/docs/marketing-api/reference (sürüm takvimi).

### Insights — rate limiting (RESMİ, "ad account seviyesi")
- Ads Insights tüketimi **ad account + app** kombinasyonunda hesaplanır (uygulama başına değil, reklam hesabı başına).
- Hesaplama: `ads_insights` = **(190.000** Full access **| 600** Dev tier**) + 400 × aktif reklam sayısı**, reklam hesabı başına **saatlik**.
- Sync + async `/…/insights` çağrıları **birlikte** sayılır.
- Tüketime yakınlık **yoklanmaz; yanıt başlıklarından** okunur: `X-FB-Ads-Insights-Throttle` (`app_id_util_pct`, `acc_id_util_pct`, `ads_api_access_tier`) ve `X-Ad-Account-Usage`.
- Rate limit aşım hataları: `error_code 613` (Calls to this api have exceeded the rate limit) ve `80004` (Application request limit reached). Bu hatalar `MetaGraphError` ile üst katmana taşınır.
- Uygulama: job'ları toplu `level=<campaign|adset|ad>` + `time_range` ile çekmek; senkron çağrıları dakika başına dağıtmak (resmi "pace with wait time" yönergesi); yanıt başlığına göre back-off.
- ❗ **DOĞRULANMADI:** Bazı üçüncü taraf kaynaklar "ad account başına 5 istek/dk" der. Bunun resmi bir sabit **olduğu doğrulanmadı**; resmi formül yukarıdaki saatlik kotadır. Koda sabit yazılmadı.

### Bütçe (daily_budget) birimi
- `daily_budget` alanı hesabın para biriminin **minimum denomination** birimindedir (USD için cent, 2 ondalık para birimleri için örn. EUR için cent). Yani değer senkronize edilirken **cents** cinsinden gönderilmelidir (DB schema'da `*Cents` alanlarıyla uyumlu).
- Ad set `/budget` güncellemesi `POST /{adset-id}` ile `daily_budget` form parametresi olarak gider.

### Ad set bütçe değişim limitleri (öğrenme fazı)
- Bir ad set'in bütçesi **saatte en fazla 4 kez** değiştirilebilir (aşım genellikle `error_subcode 1487225` - "maximum of 4 times every hour per ad set"). Bu yüzden tek loop'ta aynı ad set'e birden fazla güncelleme basmadan, `cooldown`'ı karar öncesinde engellemek güvenli.
- Bütçe değişiminin önceki değerden **büyük oranda sapması (>%50 civarı)** öğrenme fazını sıfırlayabilir → agent-engine'de `maxChangePer24hPct` (varsayılan %50) ve tek adım `maxIncreasePct/maxDecreasePct` (varsayılan %20/%25) guardrail'i bu yüzden koruyucu değerdir.

### Kimlik doğrulama / izinler
- Okuma (accounts/campaigns/adsets/ads/insights): `ads_read`.
- Yazma (bütçe, status): `ads_management`.
- `/insights` için `access_token`, `fields`, `level`, `date_preset`/`time_range`, `time_increment` parametreleri; `time_increment=all_days` toplam satır üretir, `1` günlük satır üretir (mock bu semantiği izler).

### Sağlık/wellness reklamverenleri
- Meta sağlık kategorisine yönelik veri paylaşımı/dönüşüm optimizasyonu kuralları zaman içinde değişiyor; entegrasyon sırasında güncel doküman yeniden kontrol edilecek (spec §3.5/3.9). CAPI yalnızca sağlık kategorisi için izin verilen olay/alanlarla sınırlı.

---

## 2026-09-23 — OAuth / webhook uçları (uygulama notu)

### Meta Business Login (web route kapatması)
- Başlatma: `https://www.facebook.com/{META_API_VERSION}/dialog/oauth` (client_id, redirect_uri, state, scope) — `META_API_VERSION` ortam değişkeninden okunur (`packages/config` `EnvSchema`).
- Token değişimi: `GET https://graph.facebook.com/{META_API_VERSION}/oauth/access_token?client_id&redirect_uri&client_secret&code`.
- Kullanıcı kimliği: `GET /me?fields=id,name`; Business Manager keşfi: `GET /me/businesses?fields=id,name`.
- ❗ **DOĞRULANMADI (canlı):** Uç adreslerinin güncel (v26+) davranışı, App Review ile gerçek bir test hesabı bağlanarak doğrulanmalı. Kod, sürümü `META_API_VERSION`'dan okuyor; sabit `v26.0` yok.
- İzin seti: `business_management, ads_management, ads_read, pages_manage_metadata, pages_show_list`. Her izin için Meta App Review/Business Login onayı gerekir; eksik izinler `missingPermissions` alanına işlenmeli (henüz doldurulmuyor).

### Webhook
- `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(payload, META_WEBHOOK_SECRET); karşılaştırma sabit zamanlı. Secret boşsa/belirtilmezse **fail-closed** (401).
- Tenant ayrımı `entry[].id` (page_id/insta_id) → `MetaConnection.pageId/instaId` üzerinden yapılır; eşleşme yoksa hiçbir lead yazılmaz.
- İdempotency: leadgen için `leadgen_id`, mesaj için `message.mid` `metadata`'da tutulur ve tekrar gelen aynı olay işlenmez.

### Rastgele değişen sağlık/wellness
- Meta'nın sağlık reklamverenlerine yönelik veri paylaşımı kısıtları zaman içinde değişiyor; CAPI/offline dönüşüm entegrasyonundan önce güncel doküman kural olarak yeniden kontrol edilecek (spec §3.5/3.9).

---

*Sonraki güncellemelerde tarih + kaynak URL ile ekleme yapılır; tahmin içeren satırlar "DOĞRULANMADI" ile işaretlenir.*

## 2026-09-25 — Ad review durumu (spec 3.5 red raporu)

> **2026-09-27 düzeltmesi:** Reklam alanının adı `ad_review_feedback`'tir (`review_feedback` değil); kampanya nesnesinde
> inceleme geri bildirimi yoktur ve `effective_status` enum'unda `IN_REVIEW`/`PENDING_IN_REVIEW` yok, `PENDING_REVIEW`
> ve `IN_PROCESS` var. Güncel bilgi aşağıdaki 2026-09-27 bölümündedir (ADR-0015).

- Ad seviyesi inceleme: `GET /{ad-id}?fields=id,effective_status,configured_status,review_feedback`.
  Kaynak: developers.facebook.com/docs/marketing-api/reference/adgroup-review-feedback + effective_status/configured_status (2026-09-24 websearch ile doğrulandı).
- `review_feedback.global`: `Record<policyKey, açıklama>` — platformlar arası genel red nedenleri.
- `review_feedback.placement_specific`: `Record<placement, Record<policyKey, açıklama>>` — yalnızca belirli yerleşimlerdeki sorunlar (örn. Instagram Feed).
- `effective_status`: ACTIVE / DISAPPROVED / PENDING_IN_REVIEW / IN_REVIEW ve diğer birleşik durumlar; `configured_status` operatörce set edilen (PAUSED/ACTIVE) hedeftir.
- ❗ **DOĞRULANMADI (canlı):** Platformda kampanya/ad oluşturup gerçek review_feedback alınarak uçtan uca doğrulanmalı. Mock client `getAdReview` deterministik (ad `ad_mock_rejected` → DISAPPROVED) verir.
- Kampanya tablosuna `metaReviewStatus` (String?) + `metaRejectionReason` (Json?) eklendi; red şartı DISAPPROVED başta olmak üzere global+placement gerekçeleri saklanır.

## 2026-09-25 — LLM politika katmanı (spec 3.5 katman 2)

- `classifyRisk(adCopy,key,model)` Meta Advertising Standards'a göre risk skorlar (prompt `policy-risk-v1`); uluslararası garantili/öncelik klişelerini ve "garanti sonuç/üstünlük" vaatlerini bayraklar.
- Katmanlar birleşik: kural motoru risk'i korunur; LLM bulunursa `policy.llm` olarak eklenir (`risk` alanı katman 1'den gelir). LLM anahtarı yoksa/hata olursa sessizce `llm: null` — yayın engellenmez.

## 2026-09-26 — T9: Rıza, Stripe ve CAPI güncellemesi

### 3.11 — KVKK/GDPR uyumu ve rıza yönetimi

- **CAPI rıza kapısı**: `web/app/api/capi/lead/route.ts` artık `lead.consentGiven` kontrolü yapmadan PII (hashed email/phone) içeren CAPI dönüşümü göndermez. `consentGiven=false` (veya `WITHDRAWN` status) lead'e CAPI olayı → **409** hata + audit log. Bu, KVKK/GDPR'a uyum sağlar; rıza verilmemiş lead'lere dönüşüm kaydı oluşturulmaz.

- **Stripe `stripeSubscriptionId`**: `Subscription` modeline `stripeSubscriptionId String? @unique` eklendi (migration 07). Checkout rotası: `STRIPE_SECRET_KEY` yoksa **mock mod** (Stripe SDK çağrısı yapmadan yerel ACTIVE + `mock:true` dönüşü, metadata'ya `plan` eklenir). Webhook: `checkout.session.completed` → local `subscription` upsert ile `stripeSubscriptionId` kaydedilir; `invoice.payment_succeeded/failed`, `customer.subscription.deleted/updated` → `stripeSubscriptionId` ile eşleştirilip local abonelik senkronize edilir; `customer.subscription.updated` → dönem sonu ve `cancelAtPeriodEnd` senkronizasyonu. İmza doğrulaması `STRIPE_WEBHOOK_SECRET` ile; yoksa payload parse edilir (dev ortamı uyumluluğu).

### 3.12 — Faturalandırma ve checkout

- **Checkout mock modu**: `STRIPE_SECRET_KEY` ortam değişkeni tanımlı değilse, `getStripe()` `new Stripe("")` yerine yerel işlem yapar; `subscription` `ACTIVE` olarak işaretlenir; `checkoutUrl` boş döner; `mock: true` flagü yanıtta gönderilir. Bu sayede `STRIPE_SECRET_KEY` tanımlanmayan geliştirme ortamlarında test edilebilir.
- **Faturanın yükseltme/güncelleme senkronu**: `invoice.payment_succeeded` → yerel `invoice` `PAID` + `paidAt` ayarlanır; `invoice.payment_failed` → `PAST_DUE`; `customer.subscription.deleted` → `CANCELED`; `customer.subscription.updated` → dönem sonu ve `cancelAtPeriodEnd` senkronizasyonu.


## 2026-09-26 — Webhook payload biçimleri (Lead Ads / Messenger / Instagram / WhatsApp)

Kaynaklar (2026-09-26 kontrol edildi): developers.facebook.com/docs/graph-api/webhooks/getting-started,
/docs/messenger-platform/webhooks ve /docs/messenger-platform/reference/webhook-events/messages,
/docs/whatsapp/cloud-api/webhooks/payload-examples (429 nedeniyle 360dialog'un birebir aynasından doğrulandı),
/docs/marketing-api/guides/lead-ads/retrieving. Uygulama: `web/app/_lib/webhook-ingest.ts`, kanonik uç `api/webhooks/meta`
(eski `api/leads/[id]/webhook` yeniden dışa aktarım).

### Abonelik doğrulaması ve teslimat
- GET `?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` → token eşleşirse `hub.challenge` düz metin 200; aksi 403; `META_WEBHOOK_VERIFY_TOKEN` yoksa 503.
- POST: `X-Hub-Signature-256: sha256=<HMAC-SHA256(ham gövde, App Secret)>`; secret `META_WEBHOOK_SECRET ?? META_APP_SECRET`; boşsa fail-closed 401.
- Meta 200 dışı yanıtta **36 saat boyunca azalan sıklıkla yeniden dener** (Messenger için "5 sn içinde 200" beklenir). Bu yüzden imzası geçerli ama biçimi bilinmeyen gövdeye 200 `{ ignored: true }` dönülür; yalnızca imza hatası 401, geçici DB/Graph hataları 5xx (tekrar istenir).
- Bir teslimat `entry[]` içinde birden fazla olay taşıyabilir (1000'e kadar). Örnek JSON'larda `entry.id`, `leadgen_id`, `page_id`, `form_id`, `ad_id` **sayı** olarak gösterilir; gerçek teslimatlarda string gelir → şema ikisini de kabul edip string'e çevirir.

### Lead Ads (`object:"page"`, `changes[].field:"leadgen"`)
- `value: { leadgen_id, page_id, form_id, ad_id, adgroup_id, created_time }` — **form yanıtları webhook'ta yoktur.** `adgroup_id` eski adlandırmadır (örnekte `ad_id` ile aynı değer); ad set/kampanya kimliği Graph'tan gelir.
- Alanlar `GET /{leadgen_id}?fields=id,created_time,field_data,ad_id,adset_id,campaign_id,form_id` ile (Page access token, `leads_retrieval` + `pages_manage_ads`/`pages_show_list`) okunur → `getLeadgenData` (`packages/meta-api/src/leadgen.ts`, token Authorization başlığında). `META_MOCK_MODE` → `getLeadgenDataMock` deterministik veri. Webhook gövdesinde `field_data` varsa (test/geliştirme) Graph çağrısı yapılmaz.
- Kalıcı token hataları (190/102/104/10/200/100) → lead `pendingFetch: true, fetchError` ile stub olarak yazılır (kayıp olmaz); geçici hatalar 5xx ile Meta'ya bırakılır.
- ❗ **DOĞRULANMADI (canlı):** `field_data` özel soru adlarının (`which_treatment_are_you_interested_in?` gibi) tam biçimi ve `platform`/`is_organic` alanlarının v26'da dönüp dönmediği gerçek hesapla doğrulanmalı.

### Messenger (`object:"page"`, `entry[].messaging[]`) ve Instagram (`object:"instagram"`, `entry.id` = IG profesyonel hesap kimliği)
- `messaging[]: { sender:{id:<PSID>}, recipient:{id:<PAGE_ID>}, timestamp(ms), message:{ mid, text?, attachments?[{type,payload}], quick_reply?, reply_to?, referral? } }`.
- Click-to-Messenger reklamı: `message.referral { ref?, ad_id, source:"ADS", type:"OPEN_THREAD", ads_context_data{ad_title, post_id, …} }`; `messaging_referrals` olayında aynı nesne olay seviyesinde (`messaging[].referral`) gelir — ikisi de okunur.
- `message.is_echo:true` (kendi gönderimlerimizin yankısı), `read`, `delivery`, `postback`, salt `referral` olayları kaydedilmez. Messenger webhook'unda telefon/e-posta **yoktur**; lead PSID ile eşleştirilir (`lookupHash = psid:` / `ig:`), ad "Konuk".
- Tenant: `entry.id` → `MetaConnection.pageId` (Messenger) / `instaId` (Instagram); CONNECTED veya DEGRADED bağlantı; eşleşmezse hiçbir yazma yapılmaz (`ignoredPages`).

### WhatsApp Cloud API (`object:"whatsapp_business_account"`, `entry.id` = WABA id, `changes[].field:"messages"`)
- `value: { messaging_product:"whatsapp", metadata:{ display_phone_number, phone_number_id }, contacts:[{ profile:{name}, wa_id }], messages:[{ from, id:<wamid>, timestamp(s), type, text:{body} | interactive | button | image… , referral? }] }`.
- Aynı `field:"messages"` altında `statuses:[{ id, status: sent|delivered|read|failed, timestamp, recipient_id, conversation, pricing }]` gelir → kayıt yok, 200.
- Click-to-WhatsApp: `messages[].referral { source_url, source_type:"ad"|"post", source_id:<ad id>, headline, body, media_type, image_url|video_url, ctwa_clid }`.
- Tenant: `metadata.phone_number_id` → `MetaConnection.whatsappPhoneNumberId`; bulunamazsa `entry.id` → `whatsappBusinessId`. `wa_id` (telefon) yalnızca şifreli `Lead.phone`'a yazılır; ülke/dil telefon önekinden (90→TR/tr, 49→DE/de, 44→GB/en, 7→RU, 76/77→KZ, 966→SA, 971→AE, 33→FR, 31→NL, 48→PL) türetilir.
- Gelen mesaj 24 saatlik müşteri hizmeti penceresini açar → ilk karşılama serbest metinle gönderilir; Lead Ads kaynaklı lead'lerde pencere yoktur → yalnızca onaylı şablon (`WHATSAPP_GREETING_TEMPLATE`), yoksa `pendingGreeting`.

### İdempotency
- Mesaj: `Message.externalId = mid | wamid` (`@unique`; P2002 → `{ duplicate: true }`); leadgen: `Lead.leadgenId` + `@@unique([organizationId, leadgenId])`. Karar bu sütunlardan verilir; `metadata.mid/leadgen_id` uyumluluk için yazılmaya devam eder.
- Aynı kişi (telefon/e-posta hash'i) ikinci kez form doldurursa yeni lead `duplicateOf: <ilk lead>` ve `lookupHash: null` ile yazılır (şemadaki `@@unique([organizationId, lookupHash])` ihlal edilmez); `LEAD_DUPLICATE_MARKED` audit'i düşülür.

## 2026-09-26 — Kampanya oluşturma (W3: yayın zinciri + para birimi, ADR-0011)

- `POST /act_{id}/campaigns` için `special_ad_categories` **zorunludur**; özel kategoriye girmeyen reklamverenler `NONE` veya **boş dizi** gönderir ("Even if the campaign does not contain ads that include market housing, employment, credit, or issues, elections, and politics, advertisers must still specify a category by choosing NONE or sending us an empty array." — developers.facebook.com/docs/marketing-api/audiences/special-ad-category/, 2026-09-26 kontrol edildi). Sağlık turizmi özel kategori değildir → istemci her zaman `special_ad_categories=[]` gönderir (`buildCreateCampaignBody`).
- Objective: yeni kampanyalarda yalnızca ODAX değerleri (`OUTCOME_AWARENESS | OUTCOME_TRAFFIC | OUTCOME_ENGAGEMENT | OUTCOME_LEADS | OUTCOME_SALES | OUTCOME_APP_PROMOTION`); eski `CONVERSIONS/LEAD_GENERATION/…` reddedilir. Ürün içi eşleme `toMetaObjective`: MAX_ROAS → OUTCOME_SALES, MAX_CONVERSIONS → OUTCOME_LEADS, MAX_IMPRESSIONS → OUTCOME_AWARENESS; bilinmeyen değer fail-closed hata. ❗ **DOĞRULANMADI (canlı):** resmi referans sayfası bu oturumda 429 verdi; ODAX listesi ikincil kaynaklardan ve önceki notlardan alındı, gerçek hesapla doğrulanmalı.
- `status` oluşturma anında yalnızca `PAUSED` (tip daraltıldı; spec 3.3 "önce PAUSED"). ACTIVE geçişi ayrı `POST /{campaign-id}` (`status=ACTIVE`) ile ve OWNER/ADMIN onayıyla.
- Bütçe: kampanya seviyesinde `daily_budget` **yalnızca CBO'da** gönderilir (Advantage+ kampanya bütçesi); ABO'da bütçe ad set'lerde kalır, kampanyaya bütçe gönderilmez. Değer minor unit (cent) ve DB'den dönüşümsüz (`dailyBudgetCents`, `×100` yok). `GET …/campaigns?fields=daily_budget,lifetime_budget` de minor döner → `MetaCampaign.dailyBudgetCents/lifetimeBudgetCents`.
- Uygulama sırası: yerel kontrol (durum, taze `policy_rules` anlık görüntüsü + klinik yasaklı ifadeleri, aylık üst sınır) → Meta `createCampaign` (transaction dışı) → kısa transaction (`FOR UPDATE` + beklenen durumla `updateMany`). Meta başarılı ama yerel yazım başarısızsa `CAMPAIGN_PUBLISH_ORPHANED` audit kaydı `metaCampaignId` ile düşülür (yetim kampanya elle eşleştirilir/silinir).
- Canlı modda `AdAccount.metaAccountId` yoksa yayın 400 ile durur; mock hesap kimliğine yalnızca `META_MOCK_MODE=true` iken düşülür.
- Planlayıcı ad set hedefleme taslağı `geo_locations.countries` (ISO alpha-2; Körfez = AE, SA, QA, KW, BH, OM), `locales` (uygulama dil kodları — Meta'nın sayısal locale kimliklerine çeviri ad set gönderiminde yapılacak, henüz yapılmıyor), `age_min/age_max` (alt sınır 18) alanlarını taşır.

## 2026-09-26 — Conversions API (spec 3.9; `packages/meta-api/src/capi.ts`, `web/app/_lib/capi-sync.ts`)

Kaynaklar (2026-09-26 kontrol edildi): developers.facebook.com/docs/marketing-api/conversions-api/using-the-api,
/docs/marketing-api/conversions-api/parameters (+ /parameters/server-event, /parameters/customer-information-parameters),
/docs/meta-pixel/reference (standart olay adları), developers.facebook.com/blog/post/2022/12/05/auth-tokens (Bearer başlığı).

### Uç ve kimlik doğrulama
- `POST https://graph.facebook.com/{version}/{PIXEL_ID}/events` — hedef **Pixel/Dataset kimliği**dir, reklam hesabı (`act_…`) DEĞİLDİR. Uygulamada hedef `MetaConnection.pixelId` (org'un CONNECTED bağlantısı, PIXEL türü öncelikli); yoksa route'lar 400 "Pixel/Dataset ID ayarlanmadı" döner, mock hesap kimliğine düşülmez.
- CAPI belgesi token'ı `access_token` sorgu parametresiyle gösterir; Graph API `Authorization: Bearer <token>` başlığını da kabul eder (resmi Meta blog yazısı: "For any request to the API, you must set the Authorization header to Bearer <YOUR ACCESS TOKEN>"). Uygulama token'ı **başlıkta** gönderir (URL/log sızıntısı yok).
- Tek istekte en fazla **1.000 olay** (`data[]`). `test_event_code` yalnızca testte; üretim yükünde gönderilmez.
- Yanıt gövdesi `{ events_received, messages, fbtrace_id }`; olay bazlı `is_event_duplicated` alanı belgede yoktur (varsa okunur). İdempotency bu yüzden **bizde**: `ConversionEvent.externalId` (`crm_<leadId>_<OLAY>_<YYYYMMDD>` veya `ce_<hash>`) Meta'ya göndermeden önce kontrol edilir; varsa 200 `{ duplicate: true }`.
- `META_MOCK_MODE=true` → gerçek istek yok; deterministik `fbtrace_id` (`mock_…`), `events_received = olay sayısı`.

### Sunucu olayı parametreleri
- `event_name`: Meta **standart adı** — `Lead`, `Schedule`, `CompleteRegistration`, `Contact`, `Purchase` (iç enum `LEAD/SCHEDULE/COMPLETE_REGISTRATION/CONTACT/PURCHASE` → `CONVERSION_EVENT_NAMES` eşlemesi). Sağlık turizmi huni akışında yalnızca bu beş olay gönderilir (`healthAllowedEvents()`); eski `CUSTOMIZE`, `CONTENT` gibi standart olmayan adlar kaldırıldı.
- `event_time`: **Unix saniye, tam sayı**; 7 günden eski olay reddedilir (Meta hata döner) → istemci tarafında da doğrulanır.
- `action_source` yalnızca Meta değerleri: `website | app | phone_call | chat | email | physical_store | system_generated | business_messaging | other`. `offline_conversion`/`WEB` gibi değerler geçersizdir; CRM durum geçişleri `system_generated` ile gider.
- `event_id` + `event_name` çifti Pixel/CAPI tekilleştirmesi içindir; `eventIdFor()` aynı lead+olay+gün için kararlı kimlik üretir.
- Lead durumu → olay: CONTACTED→`Contact`, QUALIFIED→`Lead`, CONSULTATION_BOOKED→`Schedule`, TRAVEL_PLANNED→`CompleteRegistration`, TREATED→`Purchase`; NEW/LOST için olay yok (`LEAD_STATUS_EVENT`).

### Müşteri bilgisi (`user_data`) normalizasyonu — SHA-256 zorunlu alanlar
- `em`: kırp + küçük harf → sha256. `ph`: yalnızca rakam (sembol/`+`/boşluk yok, ülke kodu dahil, `00` öneki atılır) → sha256. `fn`/`ln`: küçük harf, noktalama yok → sha256.
- `country`: ISO 3166-1 alpha-2 **küçük harf** → sha256. `ct` **şehir** alanıdır, ülke için kullanılmaz (eski kod `ct`'ye ülke yazıyordu — düzeltildi). 2 harf olmayan ülke değeri gönderilmez.
- `external_id`: hash önerilir (CRM `lookupHash` zaten tek yönlü hash → aynen); `client_ip_address`/`client_user_agent` **hash'lenmez**.
- Gönderilmeyen alanlar: `db`, `ge`, `st`, `zp`, `fbc/fbp` (uygulamada toplanmıyor).

### Veri minimizasyonu (`custom_data`)
- Yalnızca `value` (major birim) ve `currency` (ISO 4217, 3 harf) gönderilir; `service`, lead durumu, `leadId`, sağlık/işlem bilgisi **asla** gönderilmez (`sanitizeConversionInput` izin listesi).
- Rıza kapısı: `Lead.consentGiven=true` ve geri çekilmiş (`WITHDRAWN`) MARKETING rıza kaydı yoksa; genel `/api/capi` ucunda `consentGiven: true` zorunlu (aksi 409).
- ❗ **DOĞRULANMADI (canlı):** Meta'nın sağlık/wellness kategorili veri kaynakları için orta/alt huni olaylarını kısıtlaması (Events Manager "restricted events") gerçek Pixel/Dataset ile doğrulanmalı; kısıtlıysa yalnızca izin verilen olaylar `healthAllowedEvents()` listesinde bırakılır.

## 2026-09-26 — Meta Business Login: izinler, sayfa token'ları, appsecret_proof, config_id (W5)

Kaynaklar (2026-09-26 kontrol edildi): developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow,
/docs/facebook-login/guides/access-tokens/get-long-lived, /docs/graph-api/reference/user/permissions,
/docs/graph-api/reference/user/accounts, /docs/graph-api/guides/secure-requests, /docs/facebook-login/security,
/docs/facebook-login/facebook-login-for-business. Uygulama: `web/app/api/meta/oauth/callback/route.ts`,
`web/app/_lib/meta-connection.ts`, `web/app/_lib/meta-scopes.ts`, `packages/meta-api/src/token.ts`.

### Verilen izinler (`granted_scopes` kod değişiminde GELMEZ)
- Manuel akışta `granted_scopes` yalnızca dialog'a `return_scopes=true` verildiğinde ve **yönlendirme URL'sinde** döner; `GET oauth/access_token` (code → token) yanıtı yalnızca `access_token, token_type, expires_in` içerir.
- Bu yüzden eksik izin hesabı `GET /{version}/me/permissions` ile yapılır: `{ data: [{ permission, status: "granted" | "declined" | "expired" }] }` → `getGrantedPermissions()`; `status:"granted"` olanlar `MetaConnection.scopes`, zorunlu setten eksikler `missingPermissions`.
- Zorunlu set (`META_REQUIRED_SCOPES`): `ads_management, ads_read, business_management, pages_show_list, leads_retrieval`. Opsiyonel (`META_OPTIONAL_SCOPES`, UI'da ayrı listelenir): `pages_manage_metadata, pages_messaging, instagram_basic, instagram_manage_messages, whatsapp_business_messaging, whatsapp_business_management`. Reddedilen izin yeniden istenirken dialog'a `auth_type=rerequest` eklenmelidir (henüz eklenmedi; kullanıcı "Meta ile Bağlantı Kur"u tekrar çalıştırır). Her izin App Review gerektirir.

### Uzun ömürlü token ve sayfa token'ları
- Kod değişiminden sonra callback `fb_exchange_token` ile uzun ömürlü kullanıcı token'ı (~60 gün) üretir; başarısızsa kısa ömürlü token ile devam edilir (worker yeniler).
- `GET /me/accounts?fields=id,name,access_token,instagram_business_account` (`pages_show_list`; Instagram alanı için `instagram_basic`) → her sayfa için PAGE tipi `MetaConnection` (`pageId`, `instaId`, şifreli sayfa token'ı). Uzun ömürlü kullanıcı token'ı ile alınan sayfa token'larının son kullanma tarihi yoktur ("do not have an expiration date and only expire or are invalidated under certain conditions") → `expiresAt=null`; worker bu bağlantıları her turda `debug_token` ile doğrular.
- ❗ **DOĞRULANMADI (canlı):** `instagram_business_account` alanının Business Login ile alınan sayfa listesinde dönmesi ve WhatsApp (WABA/phone_number_id) keşfi için ayrı uç (`/{business-id}/owned_whatsapp_business_accounts`) gerçek hesapla doğrulanmalı; WhatsApp kimlikleri App Review tamamlanana kadar UI'dan elle eşlenir (`PATCH /api/meta/connections/[id]`: pixelId, whatsappPhoneNumberId, whatsappBusinessId, pageId, instaId).
- Mock modda (`META_MOCK_MODE=true`) izin listesi tam set, sayfa keşfi deterministik `page_mock_1`/`ig_mock_1`; kod değişimi ve `/me` çağrıları gerçek kalır.

### appsecret_proof ve token taşıma
- `appsecret_proof = HMAC-SHA256(access_token, app_secret)` hex (`appSecretProof()`), "Require App Secret" açık uygulamalarda tüm sunucu çağrılarında zorunlu; `META_APP_SECRET` varsa `/me`, `/me/businesses`, `/me/accounts`, `/me/permissions` çağrılarına eklenir. Login güvenlik belgesi ayrıca zaman damgalı varyantı (`HMAC(access_token|time)` + `appsecret_time`, 5 dk geçerli) anlatır; klasik varyant Graph API "secure requests" belgesindeki biçimdir ve kullanılan odur. ❗ **DOĞRULANMADI (canlı):** token `Authorization: Bearer` başlığındayken `appsecret_proof`'un kabul edildiği gerçek uygulamayla doğrulanmalı (uyumsuzlukta token'ı `access_token` parametresine düşürmek gerekir).
- Token'lar `Authorization: Bearer` başlığında gider (`debug_token`'da app token dahil). İstisnalar (uç tanımı gereği sorgu parametresi): `debug_token?input_token=` (incelenen token) ve `oauth/access_token?fb_exchange_token=` / `code=` + `client_secret=`.

### Facebook Login for Business — `config_id`
- "Business" tipi uygulamalar Facebook Login for Business kullanmak zorundadır; dialog'da `scope` yerine **`config_id=<CONFIG_ID>`** (App Dashboard'da oluşturulan yapılandırma; sistem kullanıcı token'ı için `response_type=code&override_default_response_type=true`) gerekir. Mevcut kod klasik `scope` parametresini kullanır. ❗ **DOĞRULANMADI:** uygulama tipimiz (Business mi?) ve `config_id` zorunluluğu App Dashboard'da doğrulanmalı; gerekiyorsa `META_LOGIN_CONFIG_ID` ortam değişkeni (`packages/config` EnvSchema) eklenip `GET /api/meta/oauth` `config_id` ile kurulmalı (bu turda EnvSchema değiştirilmedi).

### Bağlantı sağlığı / durum kalıcılığı
- Süresi dolan token → `status=EXPIRED` + `lastError`; `debug_token` `is_valid=false` veya `fb_exchange_token` 190 hatası → `REVOKED` + `lastError`. Her iki durumda bağlantıya bağlı `AdAccount`'lar `PAUSED` (kullanıcı "Bağlantıyı Kes" ile aynı). Süresi dolmuş token yenilenemez (Meta kuralı) → yeniden OAuth.
- Worker (`checkConnectionHealth`) bağlantı bazlı çalışır; `META_DISCONNECTED`/`TOKEN_EXPIRING` uyarıları aynı bağlantı için OPEN uyarı varken, ACK/RESOLVED sonrasında da 24 saat boyunca tekrar üretilmez (webhook tekrarı yok). Kullanıcı bağlantıyı kestiğinde web tarafı OPEN uyarıyı kendisi oluşturur.

## 2026-09-26 — Kreatif CTA türleri, LLM politika katmanı ve AI asistan (W7)

### Kreatif `call_to_action.type` (spec 3.4 CTA önerisi)
- Kaynak: developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data-call-to-action/ (2026-09-26; resmi sayfa bu turda 429 döndüğü için birebir liste
  /docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp/ örneği — `{"type":"WHATSAPP_MESSAGE","value":{"app_destination":"WHATSAPP"}}` — ve Meta listesini aktaran üçüncü taraf dokümanla çapraz doğrulandı).
- Üretimde kullanılan alt küme (`packages/llm/src/cta.ts` `META_CTA_TYPES`): `LEARN_MORE, SIGN_UP, CONTACT_US, WHATSAPP_MESSAGE, BOOK_NOW, GET_QUOTE, APPLY_NOW, MESSAGE_PAGE, SEND_MESSAGE`.
  LLM serbest metin döndürürse (`"Bilgi alın"`, `"Jetzt Termin buchen"` …) `normalizeCta` en yakın türe eşler; eşleşme yoksa `LEARN_MORE`. Serbest değerler Meta'da 100 hatasıyla reddedilir.
- ❗ **DOĞRULANMADI:** `SEND_MESSAGE` resmi listede görülmedi (Messenger tıklama reklamları için belgelenen tür `MESSAGE_PAGE`); yayın zincirine CTA bağlanırken `MESSAGE_PAGE` tercih edilmeli.
- Kaydedilen taslaklarda (`StudioDraft.content.variants[].cta`) eski serbest metinler korunur; stüdyo arayüzü yeni taslaklarda yalnızca enum değerlerini sunar.

### LLM politika katmanı (spec 3.5 katman 2) — güncelleme
- `policyFor`: `risk = max(kural riski, LLM riski)` (HIGH > MEDIUM > LOW); `ruleRisk` ayrıca saklanır. Anahtar yoksa `llm: null`, LLM hatasında `llm: { error: true }` — iki durumda da karar kural sonucudur (yayın engellenmez).
- Kontrol edilen metin varyantlar + Instant Form soruları + WhatsApp karşılamasını kapsar. MEDIUM: onaya gönderim `acknowledgeWarning:true` ister (422 + `policyWarning`), onay audit'e `policyWarningAcknowledged` olarak yazılır; HIGH engellenir.
- LLM çağrıları Prisma transaction'ı dışında yapılır; reject'te LLM çağrılmaz. Her çağrı `LlmCallLog`'a `promptVersion` (`creative-v1`, `policy-risk-v1`, `greeting-v1`, `lead-assistant-v1`) ve gerçek token sayısıyla (`COMPLETED`/`FAILED`) yazılır; içerik loglanmaz.

### AI asistan (spec 3.8) — mesajlaşma kısıtları
- Bot yanıtı yalnızca ACTIVE konuşmada, son mesaj INCOMING ise üretilir (`web/app/_lib/lead-assistant.ts`, worker `workers/meta-sync/src/assistant.ts`); koordinatör devralınca (ESCALATED) bot susar.
- Gelen mesaja yanıt 24 saatlik pencere içinde serbest metindir (WhatsApp `type:"text"`, Messenger `messaging_type:"RESPONSE"`); pencere dışı şablon/HUMAN_AGENT gereksinimi karşılama akışındaki gibi geçerlidir.
- Acil durum / insan isteği / kapsam dışı (fiyat, tıbbi uygunluk) tespiti kelime sınırlı çok dilli sözlükle (`detectHandoff`) yapılır; devirde lead'e kendi dilinde kısa bilgilendirme gider, koordinatör için `Alert` (tip `PAUSE_APPLIED`, `entityType:"CONVERSATION"`; acilde CRITICAL, aksi INFO) açılır. ❗ Şemaya `AlertType.CONVERSATION_ESCALATED` eklenmesi önerilir.
- Prompt'ta lead adı/telefon/e-posta yoktur: `sha256(orgId:leadId)` ilk 8 karakteri takma kimlik; lead serbest metnindeki e-posta/telefon maskelenir (spec 3.11).

---

## 2026-09-27 — Tam PAUSED yayın: ad set, lead formu, kreatif, reklam (spec 3.3/3.6; ADR-0014)

Kod: `packages/meta-api/src/publish.ts` (saf gövde üreticileri + doğrulama), `client.ts`/`mock.ts` (uçlar),
`web/app/_lib/campaign-publish.ts` (yayın/etkinleştirme orkestrasyonu). Aşağıdaki kaynaklar 2026-09-27'de
kontrol edildi; "ikincil" işaretliler resmi sayfa yerine uzman kaynağından alındı. 2026-09-26 notundaki iki madde
güncellendi: ad set/hedefleme artık Meta'ya gönderiliyor (sayısal locale anahtarlarıyla) ve ACTIVE geçişini
OWNER/ADMIN değil, yalnızca harcama yetkisi olan kişi (Owner veya yetki verdiği üye) yapabiliyor (ADR-0014).

### Kampanya bütçesi: CBO / ABO ve `is_adset_budget_sharing_enabled`
- v24.0+: kampanyada bütçe yoksa (ABO) `is_adset_budget_sharing_enabled` alanına True/False verilmesi **zorunlu**;
  verilmezse hata 100 / **4834011** ("Must specify True or False in is_adset_budget_sharing_enabled field. This is
  required field starting v24 if you are not setting budget at the campaign level"). Kaynak:
  developers.facebook.com/documentation/ads-commerce/marketing-api/bidding/guides/adset-budget-sharing.
  Uygulama: ABO'da `false` (pazar payları birbirine kaymasın). Önceki sürüm bu alanı göndermiyordu → v24+'da
  her ABO kampanya oluşturma hatası veriyordu (düzeltildi, `buildCreateCampaignBody`).
- CBO: kampanyada `daily_budget` + `bid_strategy=LOWEST_COST_WITHOUT_CAP`; ABO: ad set'te `daily_budget` +
  `bid_strategy`. ❗ **DOĞRULANMADI (canlı):** CBO'da `bid_strategy`'nin zorunluluğu; gönderilen değer Meta varsayılanıdır.
- Bütçe değişikliği: CBO'da kampanya, ABO'da her Meta ad set'i orantılı payını alır (kampanyaya bütçe yazmak
  yapıyı değiştirir). Bir ad set başarısız olursa önceden güncellenenler eski değerine geri yazılır (en iyi çaba).

### Ad set (`POST act_{id}/adsets`) — hepsi `status=PAUSED`, `billing_event=IMPRESSIONS`
- **Instant Form:** `OUTCOME_LEADS` + `destination_type=ON_AD` + `optimization_goal=LEAD_GENERATION` +
  `promoted_object={"page_id":…}`. Kaynak: /docs/marketing-api/guides/lead-ads/create/ ("optimization_goal:
  LEAD_GENERATION or LINK_CLICKS", "promoted_object set to the corresponding PAGE_ID", LEAD_GENERATION'da
  billing IMPRESSIONS). ❗ Bu sayfa hâlâ eski `objective=LEAD_GENERATION` yazıyor; yeni kampanyalarda eski
  objective'ler reddedildiği için ODAX eşdeğeri `OUTCOME_LEADS` kullanılıyor → **canlı doğrulanmalı**.
- **Click-to-WhatsApp:** objective `OUTCOME_ENGAGEMENT | OUTCOME_LEADS | OUTCOME_SALES | OUTCOME_TRAFFIC`;
  `destination_type=WHATSAPP`; `promoted_object.page_id` zorunlu (`whatsapp_phone_number` isteğe bağlı);
  `optimization_goal=CONVERSATIONS`. Kaynak: /docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp/.
  ❗ **DOĞRULANMADI:** belge optimizasyon hedeflerini açıkça yalnızca OUTCOME_ENGAGEMENT için listeliyor
  (CONVERSATIONS, LINK_CLICKS); LEADS/SALES ile CONVERSATIONS canlı doğrulanmalı. Sayfanın bir WhatsApp Business
  numarasına bağlı olması gerekir; bu bağ Admedic'te denetlenmiyor (Meta hatası yayın adımında gösterilir).
- **Açılış sayfası:** `destination_type=WEBSITE` + `optimization_goal=LINK_CLICKS` (bilinirlikte hedef türü yok,
  `REACH`). Gerekçe: sağlık/wellness veri kısıtları web dönüşüm optimizasyonunu kısıtlıyor (aşağıda). ODAX eşleme
  tablosu (/docs/marketing-api/reference/ad-campaign/) Leads → Website için "Landing Page Views, Link Clicks"
  içeriyor; Sales → Website için Link Clicks'i ikincil kaynak doğruluyor (jonloomer.com/odax-facebook-objectives).
  ❗ **DOĞRULANMADI:** OUTCOME_SALES + WEBSITE ad set'inde piksel (`promoted_object.pixel_id`) zorunlu olabilir.
- **Instagram DM:** `INSTAGRAM_DIRECT` planlayıcının hedefleriyle desteklenmiyor → plan kaydedilmeden engellenir.
- **Hedefleme:** `geo_locations.countries` (ISO alpha-2), `age_min ≥ 18` (spec 3.3), `age_max ≤ 65` (Meta üst sınırı),
  `locales`: sayısal anahtarlar `GET /search?type=adlocale&q=<İngilizce dil adı>`
  (/docs/marketing-api/audiences/reference/targeting-search). Seçim: "<Dil> (All)" varsa yalnızca o; yoksa adı tam
  eşleşen; yoksa "<Dil> (…)" bölgesel varyantlar ("Upside Down"/"Pirate" hariç). Eşleşme yoksa dil hedeflemesi
  yapılmaz (ülke hedeflemesi kalır). ❗ **DOĞRULANMADI:** dil bazında "(All)" kaydının varlığı ve adları.
- **Ad set başına tek dil:** Meta aynı ad set'te reklam dilini izleyicinin diline göre seçmez; planlayıcının pazar
  ad set'i yayında pazar × içerik dili olarak bölünür (ABO payı diller arasında eşit, toplam korunur).

### Lead formu (`POST {page_id}/leadgen_forms`)
- Sayfa erişim token'ı ile; lead ads App Review'ında `leads_retrieval` **ve** `pages_manage_ads` gerekir
  (/documentation/ads-commerce/marketing-api/guides/lead-ads: "You must include the leads_retrieval and
  pages_manage_ads permissions in your submission"). `pages_manage_ads` OAuth kapsamına eklendi (opsiyonel; eksikse
  Instant Form yayını açık mesajla durur).
- Gövde: `name`, `locale` (TR_TR, EN_US, DE_DE, RU_RU, AR_AR, FR_FR, NL_NL, PL_PL), `questions`
  (FULL_NAME, PHONE, EMAIL + taslağın soruları `CUSTOM`/`question_N`), `privacy_policy {url (https), link_text}`,
  `custom_disclaimer {title, body, checkboxes:[{key:"kvkk_consent", is_required:true, is_checked_by_default:false}]}`.
  Taslak başına bir form (taslağın dili ve soruları); rıza metni formun dilindedir (TR'de kuruluş metni).
- ❗ **DOĞRULANMADI:** TR/RU/NL/PL için `locale` enum değerleri; form adının sayfa başına benzersizlik zorunluluğu
  (ada kampanya kimliği son eki eklendi); sağlık durumu soran özel soruların lead ads politikası gereği reddedilmesi
  (taslak soruları kampanya politika kontrolüne dahil edildi).

### Kreatif (`POST act_{id}/adcreatives`), reklam (`POST act_{id}/ads`), görsel (`POST act_{id}/adimages`)
- `object_story_spec.link_data`: `name` (başlık), `message` (metin), `description`, `link`, `image_hash`,
  `call_to_action`; `page_id` her kreatifte zorunlu.
- **Lead reklamı:** `link="http://fb.me/"` (izin verilen tek URL), `call_to_action.value.lead_gen_form_id`; CTA
  yalnızca APPLY_NOW, DOWNLOAD, GET_QUOTE, LEARN_MORE, SIGN_UP, SUBSCRIBE (lead-ads/create) — diğerleri LEARN_MORE'a
  indirgenir. **WhatsApp:** `link="https://api.whatsapp.com/send"`, `{"type":"WHATSAPP_MESSAGE","value":{"app_destination":"WHATSAPP"}}`.
  **Web:** `link=<https açılış sayfası>`, `call_to_action.value.link` aynı adres.
- **Advantage+ kreatif özellikleri:** v22.0'dan beri `standard_enhancements` paketi açılıp kapatılamaz; özellikler
  `degrees_of_freedom_spec.creative_features_spec.<özellik>.enroll_status` (OPT_IN/OPT_OUT) ile tek tek yönetilir
  (/docs/marketing-api/advantage-catalog-ads/standard-enhancements/). Politika kontrolünden geçmiş sağlık metnini
  değiştirmemesi için `text_optimizations`, `description_automation`, `add_text_overlay` **OPT_OUT** gönderilir
  (üçü de v26 Ad Creative Features Spec'te mevcut: /docs/marketing-api/reference/ad-creative-features-spec/).
  ❗ **DOĞRULANMADI:** `text_translation`, `generate_cta`, `replace_media_text` gibi diğer metin özelliklerinin tek
  görselli link reklamlarındaki varsayılanı (şimdilik gönderilmiyor).
- **Reklam:** `status=PAUSED`, `adset_id`, `creative={"creative_id":…}`; kreatif, taslak varyantı başına bir kez
  oluşturulur ve aynı dildeki ad set'lerde paylaşılır.
- **Görsel:** `bytes` (base64) → yanıt `images.<ad>.hash` (+ `url`); kreatife `image_hash` olarak girer. Uygulama
  sınırı: JPEG/PNG, ≤3 MB (sunucusuz ortam istek gövdesi sınırı ~4,5 MB); ≥1080×1080 önerisi uyarıdır, engel değil.

### Etkinleştirme ve durdurma
- Tam yayınlanan kampanyada ACTIVE sırası reklamlar → ad set'ler → kampanya (her biri `POST /{id}` `status=ACTIVE`);
  kampanya en son açıldığı için teslimat hazır yapıyla başlar. Duraklatma yalnızca kampanyada.
- Meta'dan senkronlanan (Ads Manager'da kurulmuş) kampanyada yalnızca kampanya etkinleştirilir; ad set/reklam
  durumlarına dokunulmaz.

### Sağlık/wellness reklamverenleri — 2025 veri kısıtları (ikincil kaynak)
- Ocak 2025'te başlayıp 14 Şubat 2025'te tüm reklamverenlere yayıldı: sağlık sınıflı alan adlarında alt huni web
  olayları (lead, purchase, add-to-cart) ile optimizasyon ve bu olaylardan kitle oluşturma kısıtlı; AB'de landing
  page view optimizasyonu da kapalı. Instant Form (lead ads) ve üst huni hedefleri (bilinirlik, trafik, etkileşim)
  kullanılabilir. Kaynak: wheelhousedmg.com/insights/articles/meta-data-restrictions-healthcare-advertising/.
  Sonuç: planlayıcı web yönteminde LINK_CLICKS kullanır; ROAS/satın alma optimizasyonu Meta'ya gönderilmez.

### Bilinen açıklar
- ~~`MetaMarketingClient` `appsecret_proof` göndermiyor~~ → giderildi (2026-09-27, aşağıdaki bölüm).
- Meta'nın ad set başına günlük asgari bütçesi (para birimi ve optimizasyona göre değişir) önceden denetlenmiyor;
  küçük ABO paylarında ad set adımı Meta hatasıyla durabilir (hata mesajı yayın ilerlemesinde gösterilir).

## 2026-09-27 — `appsecret_proof` tüm sunucu çağrılarında (canlı öncesi P0)

Kaynaklar (2026-09-27 kontrol edildi): developers.facebook.com/docs/graph-api/guides/secure-requests ve
developers.facebook.com/docs/facebook-login/security ("Verifying Graph API Calls with appsecret_proof").

- Hesap: "sha256 hash of your access token, using your app secret as the key" → `HMAC-SHA256(key=app_secret,
  data=access_token)` hex (`packages/meta-api/src/secret-proof.ts`). Uygulama panelinde **Require App Secret** açıkken
  kanıtsız sunucu çağrısı başarısız olur. Belge örnekleri kanıtı istek parametresi olarak gösterir (POST'ta form
  alanı); GET'te sorgu parametresi olarak gönderilir.
- Zaman damgalı varyant (`appsecret_time`, 5 dk geçerli) kullanılmıyor; klasik kanıt her çağrıda yeniden hesaplanır.
- Kanıtın eklendiği yerler: Marketing istemcisi (`MetaMarketingClient` — tüm GET sorguları ve form POST gövdeleri;
  `createMetaClient` `META_APP_SECRET`'ı geçirir, doğrudan kurulumda secret verilmezse kanıt yok), Lead Ads çekimi
  (`getLeadgenData`), Conversions API (`postConversionEvents`), Messenger/Instagram Send API (web + worker),
  bağlantı token'ıyla WhatsApp Cloud API gönderimi (`WhatsAppTransport.appsecretProof`), `/me/*` keşif çağrıları
  (önceden vardı). Kanıt her zaman **çağrıda kullanılan token'dan** hesaplanır (sayfa token'ı → sayfa token'ının kanıtı).
- **Kanıt eklenmeyen yer:** ortam düzeyi `WHATSAPP_TOKEN` (tek kiracılı yedek). Bu token başka bir uygulamada
  (ör. Business Manager sistem kullanıcısı) üretilmiş olabilir; Graph, gönderilen fakat eşleşmeyen kanıtı ayar kapalı
  olsa bile reddeder ("Invalid appsecret_proof provided in the API argument", kod 100) ❗ **DOĞRULANMADI (canlı).**
  Bu nedenle kanıt yalnızca bu uygulamanın OAuth akışından gelen token'lara eklenir. Aynı gerekçeyle
  `PostConversionOptions.appSecret` / `LeadgenFetchOptions.appSecret` / `MessengerTextInput.appSecret` için boş dize
  kanıtı kapatır.
- Sayfalama: `paging.next` bağlantısının kanıtı içerip içermediği belgede yazmıyor ❗ **DOĞRULANMADI**. `nextPageUrl`
  ilk istekte sorguda gönderilen `access_token`/`appsecret_proof` bağlantıda yoksa ekler ve yalnızca
  `https://graph.facebook.com` kökündeki bağlantıyı izler (token başka sunucuya gitmez).
- ❗ **DOĞRULANMADI (canlı):** token `Authorization: Bearer` başlığında, kanıt sorguda olduğunda (Lead Ads, CAPI,
  Send API, `/me/*`) kabul edildiği gerçek uygulamayla doğrulanmalı; uyumsuzlukta token `access_token` parametresine
  taşınmalı. Canlı kontrol: panelde "Require App Secret" açıkken bağlantı yenileme, insights senkronu, yayın ve
  lead çekimi hatasız çalışmalı.

## 2026-09-27 — Lead rıza kutusu yanıtları, bekleyen çekim ve reklam düzeyinde inceleme (ADR-0015)

### Instant Form onay kutusu yanıtları
Kaynak: developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/retrieving (2026-09-27
kontrol edildi) ve resmi Python SDK (`adobjects/lead.py`, `userleadgendisclaimerresponse.py`).
- "The `field_data` does not contain the responses to optional custom disclaimer check boxes" → yanıtlar
  `GET /{lead_id}?fields=custom_disclaimer_responses` ile **açıkça** istenir. Tip `list<UserLeadGenDisclaimerResponse>`:
  `checkbox_key` (string), `is_checked` (string; `"1"` işaretli, `""` işaretsiz).
- Admedic formunun kutusu **zorunludur** (`is_required: true`, anahtar `kvkk_consent`). ❗ **DOĞRULANMADI:** zorunlu
  kutunun yanıtının `custom_disclaimer_responses`'ta döndüğü (belge örneği isteğe bağlı kutuları gösterir). Dönmezse rıza
  "zorunlu kutu" dayanağıyla yazılır (form kutu işaretlenmeden gönderilemez); canlı ilk lead'de kayıt dayanağı
  (`evidence.basis`) kontrol edilmeli.
- Leadgen webhook yükü yalnızca kimlik taşır (`leadgen_id`, `page_id`, `form_id`, `adgroup_id`, `ad_id`, `created_time`);
  kutu yanıtı webhook'ta yoktur.

### Lead saklama süresi
- ❗ **DOĞRULANMADI:** Meta yardım sayfası (business/help/1526849577619206, "About expired leads") robots nedeniyle
  okunamadı; ikincil kaynak (dashops.io) yaklaşık 90 gün sonra doğrudan indirmenin kapandığını, API ile erişimin
  sürebileceğini yazıyor. Uygulama 90 günden eski bekleyen lead'i yeniden denemez (`REFETCH_MAX_AGE_DAYS`).

### Reklam inceleme durumu
Kaynak: developers.facebook.com/docs/marketing-api/reference/adgroup ve /reference/adgroup-review-feedback (2026-09-27),
resmi Python SDK (`adobjects/ad.py`, `adgroupreviewfeedback.py`, `adgroupissuesinfo.py`, `campaign.py`).
- Reklam alanları: `effective_status` enum'u ACTIVE, PAUSED, DELETED, PENDING_REVIEW, DISAPPROVED, PREAPPROVED,
  PENDING_BILLING_INFO, CAMPAIGN_PAUSED, ARCHIVED, ADSET_PAUSED, IN_PROCESS, WITH_ISSUES; `ad_review_feedback`
  (AdgroupReviewFeedback: `global` map<string,string>, `placement_specific`); `issues_info` (list: `error_code` int,
  `error_message`, `error_summary`, `error_type`, `level`).
- **Kampanya nesnesinde `review_feedback` alanı YOK** (SDK `campaign.py`'de geçmiyor). Önceki kod kampanya
  oluşturduktan sonra bu alanı okuyordu; Graph "nonexisting field" (#100) döndürür ve oluşturulmuş kampanyanın kimliği
  kaybolurdu (yeniden denemede yinelenen kampanya). Okuma kaldırıldı; inceleme reklam düzeyinde senkronlanır.
- Toplu okuma: `GET /{version}/?ids=a,b,c&fields=…` (Graph çoklu kimlik okuması, istek başına 50 kimlik). ❗
  **DOĞRULANMADI (canlı):** listedeki bir kimlik artık yoksa isteğin tamamının #100 ile reddedildiği; istemci bu durumda
  parçayı tek tek okur.
- ❗ **DOĞRULANMADI:** PAUSED oluşturulan reklamların etkinleştirilmeden incelenip incelenmediği; worker PUBLISHED_PAUSED
  kampanyaları 6 saatte, ACTIVE kampanyaları 15 dakikada bir okur.

## 2026-09-29 — App Review ve erişim düzeyleri (canlıya hazırlık, ADR-0023)
Kaynaklar (2026-09-29 okundu): developers.meta.com/blog/updates-to-ads-management-standard-access-feature ve
developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review.
- **Marketing API erişim düzeyi** (eski adı "Ads Management Standard Access"): 4 Mayıs 2026'dan itibaren alt düzey
  "Limited Access", üst düzey "Full Access". Üst düzeye başvuru koşulu: son 15 günde 500+ Marketing API çağrısı ve son
  500 çağrıda hata oranı %15'in altında. Bu özellik için ekran kaydı artık istenmiyor. Bu, `ads_management` izninden
  ayrı bir özelliktir; kodda değişiklik gerekmez.
  → Sonuç: pilot hesapta Limited Access ile başlanır; gerçek kullanım birikince Full Access'e başvurulur.
- **WhatsApp izinleri** (`whatsapp_business_messaging`, `whatsapp_business_management`): Advanced access için her
  izne ayrı yazılı açıklama ve ayrı ekran kaydı zorunlu (mesaj gönderip WhatsApp'ta alındığını gösteren; şablon
  oluşturmayı gösteren). Ekran görüntüsü kabul edilmez. Ortalama inceleme süresi ~24 saat.
- ❗ **DOĞRULANMADI:** `ads_management`, `leads_retrieval`, `pages_manage_ads`, `pages_show_list`,
  `business_management` izinlerinin Advanced access başvurusu için güncel ekran kaydı ve işletme doğrulaması
  koşulları resmi sayfadan okunmadı; başvuru öncesi Uygulama Paneli → App Review ekranında her izin için ayrı
  denetlenmeli (`docs/app-review.md`).
- ❗ **DOĞRULANMADI (canlı):** Canlı doğrulama sonuçları henüz yok. Canlıya geçiş sayfasının (`/go-live`) Meta
  denetimi ilk kez gerçek hesapta çalıştırıldığında sonuçlar tarihiyle buraya yazılacak.

### Sayfa webhook aboneliği (lead ve mesaj bildirimleri)
Kaynaklar (2026-09-29 okundu): developers.facebook.com/docs/graph-api/reference/page/subscribed_apps ve
developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration.
- Meta, Anında Form lead'i (`leadgen`) ve sayfa mesajı (`messages`) bildirimini **yalnızca sayfa uygulamaya abone
  edildiyse** gönderir; uygulama panelinde webhook tanımlamak yetmez. Sayfanın uygulama ayarlarında platform kapalıysa da
  bildirim gelmez.
- Abone etme: `POST /{version}/{page-id}/subscribed_apps` + `subscribed_fields` (ör. `leadgen,messages`), **sayfa erişim
  anahtarıyla**. Yanıt `{ "success": true }`. Okuma: `GET /{page-id}/subscribed_apps` → `data[].id` (uygulama kimliği) ve
  `data[].subscribed_fields`.
- İzinler: `pages_manage_metadata`, `pages_show_list`; lead bildirimi için Lead Ads kılavuzu ayrıca `leads_retrieval`,
  `pages_read_engagement`, `ads_management` sayar. Sayfa anahtarı, sayfada ADVERTISE görevi olan kişiden alınmış olmalı.
- **Kod (bu tur):** Daha önce abonelik hiç yapılmıyordu; canlıda lead bildirimi gelmezdi. OAuth dönüşünde anahtarı olan
  her sayfa abone edilir (`subscribeDiscoveredPages`, Messenger izni varsa `messages` de); başarısızlık sayfa bağlantısının
  `lastError` alanına yazılır. `pages_read_engagement` OAuth izin listesine eklendi. Canlıya geçiş sayfası aboneliği okur.
- ❗ **DOĞRULANMADI (canlı):** `subscribed_fields` için virgülle ayrılmış biçimin (dizi yerine) kabul edildiği;
  Graph dizi parametrelerini virgüllü metin olarak da kabul eder, ilk canlı bağlantıda Canlıya geçiş sayfasından doğrulanmalı.

## 2026-10-01 — Sesli komut asistanı: Meta tarafında yeni davranış yok (ADR-0028)
- Sesle tetiklenen işlemler Meta'ya **aynı panel uçlarından** gider (yayın, duraklatma, bütçe, inceleme eşitlemesi);
  asistanın Meta'ya doğrudan çağrısı, ayrı anahtarı ya da yeni bir Graph ucu yoktur. Bu nedenle bu tarihte yeni bir Meta
  dokümanı okunmadı; geçerli kısıtlar bu dosyadaki önceki bölümlerdir.
- PUBLISH hâlâ her şeyi PAUSED oluşturur (2026-09-27, ADR-0014). Sesle etkinleştirme (R3) ve PAUSED yayın (R2) ekranda
  tıklama ister; onay ve ret sesle yapılamaz (R4).
- Meta'nın reklam hesabı düzeyindeki hız sınırları (613, 80004; 2026-09-16): sesli araç çağrıları için ayrı bir kota
  **bugün yoktur.** Faz 1'deki tek kota `POST /api/assistant/events` üzerindedir (kullanıcı başına dakikada 30,
  `voice-event:<userId>`) ve yalnızca denetim kaydını sınırlar; Meta'ya giden uçları yavaşlatmaz. Sesli araç çağrısı
  sınırı (oturum başına dakikada 30) **Faz 2'de planlanır**: istemcideki araç dağıtıcısında, gerekirse Meta'ya giden
  uçlarda da. Planlanan kural: asistan başarısız bir Meta çağrısını kendiliğinden yeniden denemez; hatayı söyler,
  yeniden denemeyi kullanıcı ister. O zamana kadar korunma, bu uçların mevcut davranışıdır.

## 2026-10-01 — Sesli komut asistanı Faz 4: sesle tetiklenen yayın, duraklatma, bütçe, etkinleştirme (ADR-0028)
- Yeni Meta dokümanı okunmadı; Meta tarafında yeni davranış yok. R2/R3 sesli araçları (`publish_campaign_paused`,
  `pause_campaign`, `archive_campaign`, `activate_campaign`, `decrease_budget`, `increase_budget`,
  `apply_recommendation`, `sync_meta_review`, `update_lead_status`) **panelin aynı uçlarını** kullanıcının oturumuyla
  çağırır: `POST /api/campaigns/:id/publish {action}`, `PATCH /api/campaigns/:id/budget`,
  `POST /api/recommendations/:id/apply`, `POST /api/meta/review-sync`, `PATCH /api/leads/:id`. Graph çağrıları,
  `appsecret_proof`, hata eşlemesi, harcama yetkisi ve aylık tavan denetimi bu uçlardakiyle birebir aynıdır.
- PUBLISH hâlâ kampanya, reklam seti ve reklamları **PAUSED** oluşturur (2026-09-27, ADR-0014). Sesle yayın harcama
  başlatmaz; harcama yalnızca ayrı `activate_campaign` (R3) ile başlar.
- **Otomatik yeniden deneme yok:** asistan başarısız ya da yarım kalan bir Meta çağrısını kendiliğinden yeniden
  denemez. Yayın `IN_PROGRESS` dönerse araç bunu söyler ve kampanyanın Yükleme sekmesini önerir; yayını sürdürmez.
  613/80004 hız sınırı hataları da kullanıcıya aktarılır; yeniden deneme kullanıcının yeni bir isteğidir ve yine
  ekranda onay ister.
- Lead durumu değişikliği, rıza denetiminden geçerse `sendLeadStatusConversion` ile CAPI dönüşümü gönderir; bu nedenle
  `update_lead_status` R2'dir (ekranda tıklama). CAPI'nin kendisinde değişiklik yok.
- Sesli araç çağrısı için Meta'ya özgü ayrı kota hâlâ yok; araç çağrısı sınırı istemcide (oturum başına dakikada 30).
