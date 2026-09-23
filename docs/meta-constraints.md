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