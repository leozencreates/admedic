# Reklam stüdyosu

## Kurulum

1. `pnpm install`
2. Kök `.env` dosyasına `.env.example` alanlarını uyarlayın. `DATABASE_URL` erişilebilir bir PostgreSQL veritabanını ve kullanıcıyı içermeli. `AUTH_URL` tarayıcıda kullanılacak tam origin olmalı (yerelde `http://localhost:3000`). `AUTH_SECRET` için rastgele güçlü bir değer kullanın; örnek dosyadaki boş alanı doldurun.
3. `pnpm db:generate && pnpm --filter @admedic/database build`
4. `pnpm db:deploy` — mevcut tabloları sıfırlamadan stüdyo migration'ını uygular.
5. `.env` içinde `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` (en az 12 karakter), `BOOTSTRAP_CLINIC` alanlarını doldurun. `pnpm --filter @admedic/web user:create` çalıştırın. Komut yeni kullanıcı, klinik ve çalışma alanı oluşturur. Mevcut kullanıcının parolasını değiştirmez. Ardından bootstrap parolasını ortamdan kaldırın.
6. `pnpm web:dev`, ardından `/login`. E-posta ve parolayla giriş yapın (kullanıcının çalışma alanı otomatik açılır; birden çoksa en son kullanılan).

Kayıtlı demodaki eski bcrypt parolaları yeni oturum sisteminde kullanılmaz. Yeni kullanıcı için yukarıdaki CLI'ı kullanın. CLI yeni bir organizasyon açar; ekip daveti veya mevcut kliniğe kullanıcı ekleme arayüzü bu faza dahil değildir.

### AI ayarları

Sunucuda `ANTHROPIC_API_KEY` ve hesabınızda kullanılabilir modelin kimliğini `LLM_MODEL` olarak ayarlayıp sunucuyu yeniden başlatın. Model kodda sabit değildir. Anahtar tarayıcıya gönderilmez. Canlı çağrı sağlayıcı hesabından ücretlenir; çalışma alanı başına saatte 20 çağrı sınırı vardır.

Anahtar yoksa AI düğmesi açık hata gösterir. "Metinleri kendim yazacağım" ile boş bir taslak açıp bütün metinleri elle doldurabilirsiniz. Bu yol AI üretimi olarak sunulmaz.

## Ekranlar ve akış

- `/studio`: TR/EN/DE/RU/AR/FR/NL/PL brifi, AI üretimi, düzenlenebilir iki reklam kartı, Arapça RTL önizleme. İki varyant başlık bakımından farklı, metin ve CTA aynı olacak şekilde üretilir. Eski tarayıcı taslağı isteğe bağlı içe aktarılabilir; otomatik olarak sunucuya gönderilmez.
- `/library`: kliniğin reklam kütüphanesi, arama ve durum filtresi. Son güncellenen 100 taslak gösterilir.
- Taslak → Onaya gönder → İçeriği onayla veya Düzeltme iste. Owner/admin onaylar; media buyer taslak oluşturabilir/düzenleyebilir. Viewer/analyst yalnızca okur. Yüksek riskli içerik sunucu tarafında engellenir. Kaydedilen her düzenleme önceki onayı sıfırlar. İşlemler sürüm kontrolü ve audit kaydıyla transaction içinde tamamlanır.
- Onaylı taslaktan A/B deneyi oluşturun. Deney reklam metinlerinin değişmez kopyasını tutar; taslağın sonraki düzenlemeleri deneyi değiştirmez. Her taslak için bir deney oluşturulur.
- `/tests`: kayıtlı deneyler. Stüdyo deneyleri **manuel ölçümle** çalışır: toplam harcama/tıklama/lead verileri elle kaydedilir; gün sayısı geriye alınamaz, tamamlanan deney değiştirilemez. Varyantların Meta reklam seti/reklam eşleşmesi olmadığı için `POST /api/experiments/:id/sync` Meta'dan metrik çekmez (deney bulunursa 409 döner); otomatik Insight çekimi kampanya düzeyinde `workers/meta-sync` ile yapılır. Tamamlanan deney için optimizasyon önerileri üretilebilir. Deneyi tamamlamak kazanan bulunduğu anlamına gelmez.
- `/recommendations`: tamamlanan deneylere göre üretilen bütçe ve yayın önerileri (`POST /api/recommendations`, OWNER/ADMIN). Onay (`/approve`, OWNER/ADMIN) ve uygulama (`/apply`) ayrı adımlardır; uygulama hedef kampanyanın günlük bütçesini minor unit olarak günceller (ADR-0011), yayınlı kampanyalarda Meta `updateBudget` çağrısı yapar (ABO'da ad set payları). Bütçe artışı yalnızca Owner veya Owner'ın harcama yetkisi verdiği ADMIN/MEDIA_BUYER üye tarafından ve **toplam** aylık üst sınır içinde (aktif kampanyalar + yeni bütçe × 30) yapılabilir (spec 3.3/3.6, ADR-0014). Kampanya bütçesi ayrıca `PATCH /api/campaigns/:id/budget` ile değiştirilir (ADR-0007).
- `/experiments`: kayıtsız hızlı hesaplayıcı ve açıkça etiketlenmiş örnek veriler.
- `/campaign-planner`: onaylı stüdyo taslakları kampanyaya **değişmez kopya** olarak bağlanır (dil başına en fazla 3), reklam görseli (JPEG/PNG ≤3 MB) Meta görsel kütüphanesine yüklenir; "Yayına hazırlık" eksikleri (pazar başına içerik, görsel, açılış sayfası, gizlilik politikası) giderilmeden onaya gönderilemez. Onaydan sonra "Yayınla" Meta'da kampanya → ad set (pazar × dil) → lead formu → kreatif → reklamı PAUSED kurar; yarım kalırsa kaldığı yerden sürer. "Aktifleştir" yalnızca harcama yetkisi olan kişiye açıktır (ADR-0014).

Oturum 8 saat geçerlidir. Her erişimde üyeliğin aktifliği ve rolü tekrar doğrulanır. Çıkış sunucudaki oturumu iptal eder. Yazma isteklerinde `AUTH_URL` ile origin eşleşmesi zorunludur. Production cookie HTTPS gerektirir.

## API

| Yol | Yöntem | İşlev |
| --- | --- | --- |
| `/api/session` | GET / POST / DELETE | Oturum durumu / giriş / çıkış |
| `/api/studio` | GET / POST | Klinik taslakları / yeni taslak |
| `/api/studio/:id` | GET / PATCH | Taslak / sürümlü düzenleme ve onay işlemleri |
| `/api/studio/generate` | POST | Yetkilendirilmiş AI üretimi |
| `/api/experiments` | GET | Kliniğin kayıtlı deneyleri |
| `/api/experiments/:id` | GET / PATCH | Deney detayı / metrik ve durum kaydı |
| `/api/experiments/:id/sync` | POST | Stüdyo deneyinde otomatik Meta senkronu yok (deney bulunursa 409); metrikler `PATCH /api/experiments/:id` ile elle girilir |
| `/api/recommendations` | GET / POST | Öneri listesi / yeni öneri oluştur |
| `/api/recommendations/:id` | GET / PATCH | Öneri detayı / reddet, durum güncelle |
| `/api/recommendations/:id/approve` | POST | Öneri onayı (OWNER/ADMIN) |
| `/api/recommendations/:id/apply` | POST | Onaylı öneriyi kampanyaya uygula (bütçe minor unit; Meta push) |
| `/api/campaigns` | GET / POST | Kampanyalar (içerik özeti, yayına hazırlık, yayın ilerlemesi) / plan + isteğe bağlı `contentDraftIds`, `landingUrl` ile taslak |
| `/api/campaigns/:id/content` | PUT | Onaylı stüdyo taslaklarını (+ https açılış sayfası) bağla; yalnızca DRAFT/REJECTED |
| `/api/campaigns/:id/image` | POST | Reklam görselini Meta görsel kütüphanesine yükle (JPEG/PNG ≤3 MB, base64 JSON) |
| `/api/campaigns/:id/submit` · `/approve` · `/reject` | POST | Onay akışı (planlı kampanyada yayına hazırlık zorunlu; onay/red OWNER/ADMIN) |
| `/api/campaigns/:id/publish` | POST | `PUBLISH` (eksiksiz PAUSED yayın, kaldığı yerden), `ACTIVATE` (harcama yetkisi + toplam üst sınır), `PAUSE`, `ARCHIVE` |
| `/api/campaigns/:id/budget` | PATCH | Kampanya günlük bütçesi (ADR-0007; artış harcama yetkisi + toplam üst sınır, ABO'da ad set payları) |
| `/api/meta/review-sync` | POST | Reklam düzeyinde Meta inceleme durumu ve red gerekçeleri (`{ campaignId? }`; EDIT rolleri; yeni red → AD_DISAPPROVED uyarısı) |
| `/api/leads/refetch` | GET / POST | Alanları Meta'dan çekilemeyen Instant Form lead sayısı / şimdi yeniden çek (`{ leadId? }`) |
| `/api/org/settings` | GET / PATCH | Aylık üst sınır (yükseltme/kaldırma yalnızca Owner), aktif kampanya toplamı, gizlilik politikası bağlantısı, rıza metni, saklama süresi |
| `/api/org/members` | GET | Üyeler ve etkin harcama yetkisi (OWNER/ADMIN) |
| `/api/org/members/:userId/spend-authority` | PUT | Harcama yetkisi ver/geri al (yalnızca OWNER; ADMIN/MEDIA_BUYER üyeye; audit) |
| `/api/billing/*` | GET / POST / PATCH | Abonelik, Stripe Checkout, webhook ve faturalar (spec 3.12) |

## Sınırlar

İçerik onayı tek başına Meta yayını değildir: onaylı taslak kampanyaya bağlanır, kampanya ayrıca onaylanır ve Meta'ya PAUSED yayınlanır; harcama yalnızca yetkili etkinleştirmeyle başlar (ADR-0014). Canlı Meta deney oluşturma ve görsel üretimi bu ekranlarda etkin değildir (görsel yükleme Kampanya Planlayıcı'dadır); stüdyo deneyleri için otomatik metrik çekimi yoktur (kampanya insight'ları worker ile çekilir). Bütçe değişikliği stüdyo ekranlarında değil, kampanya bütçe ucu ve öneri uygulaması üzerinden yapılır (ADR-0007/0011). Kural denetimi sürümlü bir ifade taramasıdır (kurallar `policy_rules` tablosundan, ADR-0008) ve LLM risk katmanıyla birleştirilir (`docs/meta-constraints.md`, 2026-09-25); Meta onayı garanti etmez. Fastify salt okunur API (`apps/api`) oturum çerezi değil `API_TOKEN` Bearer belirteci kullanır ve yalnızca masaüstü kabuğuna veri taşır.

LLM çağrı kayıtları metni değil çalışma alanı, model, prompt sürümü, token sayısı, süre ve durumu tutar. Başarısız/yarım veya doğrulamadan geçmeyen yanıtlarda ham sağlayıcı çıktısı kaydedilmez; bu çağrıların token sayısı sıfır kalabilir. Süresi dolan `WebSession` ve `RequestQuota` kayıtları işlevsel olarak geçersizdir; periyodik veritabanı bakımında temizlenebilir.

## Doğrulama

```sh
pnpm --filter @admedic/policy test
pnpm --filter @admedic/llm test
pnpm --filter @admedic/recommendation test
pnpm --filter @admedic/web test
STUDIO_DB_TEST=1 pnpm --filter @admedic/web test
pnpm --filter @admedic/web exec playwright install chromium
STUDIO_E2E=1 pnpm --filter @admedic/web test:e2e
pnpm --filter @admedic/web typecheck
pnpm --filter @admedic/web lint
pnpm --filter @admedic/web build
```

DB/E2E testleri açık opt-in ister; benzersiz test organizasyonları oluşturur, yalnızca kendi kayıtlarını temizler. Migration uygulanmış test veritabanı kullanılması önerilir. Tarayıcı testi: giriş → Arapça manuel taslak → kayıt → onay → deney → Meta senkronizasyonu → öneriler → tamamlama → çıkış; ayrıca mobil taşma ve RTL kontrolü. AI sağlayıcısı birim/entegrasyon testlerinde mock edilir; canlı anahtar olmadan gerçek AI çağrısı doğrulanmaz.

Kararlar: `docs/decisions/0004-ad-studio.md`, `0005-authenticated-studio.md`, `0014-full-paused-publish-and-spend-authority.md`.
