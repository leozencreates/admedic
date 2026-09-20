# Reklam stüdyosu

## Kurulum

1. `pnpm install`
2. Kök `.env` dosyasına `.env.example` alanlarını uyarlayın. `DATABASE_URL` erişilebilir bir PostgreSQL veritabanını ve kullanıcıyı içermeli. `AUTH_URL` tarayıcıda kullanılacak tam origin olmalı (yerelde `http://localhost:3000`). `AUTH_SECRET` için rastgele güçlü bir değer kullanın; örnek dosyadaki boş alanı doldurun.
3. `pnpm db:generate && pnpm --filter @admedic/database build`
4. `pnpm db:deploy` — mevcut tabloları sıfırlamadan stüdyo migration'ını uygular.
5. `.env` içinde `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` (en az 12 karakter), `BOOTSTRAP_CLINIC` alanlarını doldurun. `pnpm --filter @admedic/web user:create` çalıştırın. Komut yeni kullanıcı, klinik ve çalışma alanı oluşturur; çalışma alanı ID'sini gösterir. Mevcut kullanıcının parolasını değiştirmez. Ardından bootstrap parolasını ortamdan kaldırın.
6. `pnpm web:dev`, ardından `/login`. E-posta, parola ve çalışma alanı ID'si ile giriş yapın.

Kayıtlı demodaki eski bcrypt parolaları yeni oturum sisteminde kullanılmaz. Yeni kullanıcı için yukarıdaki CLI'ı kullanın. CLI yeni bir organizasyon açar; ekip daveti veya mevcut kliniğe kullanıcı ekleme arayüzü bu faza dahil değildir.

### AI ayarları

Sunucuda `ANTHROPIC_API_KEY` ve hesabınızda kullanılabilir modelin kimliğini `LLM_MODEL` olarak ayarlayıp sunucuyu yeniden başlatın. Model kodda sabit değildir. Anahtar tarayıcıya gönderilmez. Canlı çağrı sağlayıcı hesabından ücretlenir; çalışma alanı başına saatte 20 çağrı sınırı vardır.

Anahtar yoksa AI düğmesi açık hata gösterir. "Metinleri kendim yazacağım" ile boş bir taslak açıp bütün metinleri elle doldurabilirsiniz. Bu yol AI üretimi olarak sunulmaz.

## Ekranlar ve akış

- `/studio`: TR/EN/DE/RU/AR brifi, AI üretimi, düzenlenebilir iki reklam kartı, Arapça RTL. İki varyant başlık bakımından farklı, metin ve CTA aynı olacak şekilde üretilir. Eski tarayıcı taslağı isteğe bağlı içe aktarılabilir; otomatik olarak sunucuya gönderilmez.
- `/library`: kliniğin reklam kütüphanesi, arama ve durum filtresi. Son güncellenen 100 taslak gösterilir.
- Taslak → Onaya gönder → İçeriği onayla veya Düzeltme iste. Owner/admin onaylar; media buyer taslak oluşturabilir/düzenleyebilir. Viewer/analyst yalnızca okur. Yüksek riskli içerik sunucu tarafında engellenir. Kaydedilen her düzenleme önceki onayı sıfırlar. İşlemler sürüm kontrolü ve audit kaydıyla transaction içinde tamamlanır.
- Onaylı taslaktan A/B deneyi oluşturun. Deney reklam metinlerinin değişmez kopyasını tutar; taslağın sonraki düzenlemeleri deneyi değiştirmez. Her taslak için bir deney oluşturulur.
- `/tests`: kayıtlı deneyler. Detay ekranında Meta metriklerini senkronize etme butonu, manuel toplam harcama/tıklama/lead verileri kaydedilir; gün sayısı geriye alınamaz, tamamlanan deney değiştirilemez. Tamamlanan deney için optimizasyon önerileri gösterilir. Deneyi tamamlamak kazanan bulunduğu anlamına gelmez.
- `/recommendations`: tamamlanan deneylere göre üretilen bütçe ve yayın önerileri. Owner/admin onaylayabilir; onaylanan öneriler "Uygula" ile işaretlenir.
- `/experiments`: kayıtsız hızlı hesaplayıcı ve açıkça etiketlenmiş örnek veriler.

Oturum 8 saat geçerlidir. Her erişimde üyeliğin aktifliği ve rolü tekrar doğrulanır. Çıkış sunucudaki oturumu iptal eder. Yazma isteklerinde `AUTH_URL` ile origin eşleşmesi zorunludur. Production cookie HTTPS gerektirir.

## API

| Yol | Yöntem | İşlev |
| --- | --- | --- |
| `/api/session` | GET / POST / DELETE | Oturum durumu / giriş / çıkış |
| `/api/studio` | GET / POST | Klinik taslakları / yeni taslak |
| `/api/studio/:id` | GET / PATCH | Taslak / sürümlü düzenleme ve onay işlemleri |
| `/api/studio/generate` | POST | Yetkilendirilmiş AI üretimi |
| `/api/experiments` | GET / PATCH | Kliniğin kayıtlı deneyleri / metrik ve durum kaydı |
| `/api/experiments/:id/sync` | POST | Meta'dan metrik senkronizasyonu; tamamlandıysa öneri üret |
| `/api/recommendations` | GET / POST | Öneri listesi / yeni öneri oluştur |
| `/api/recommendations/:id` | PATCH | Öneri onay / reddet / uygula |

## Sınırlar

İçerik onayı Meta yayını değildir. Canlı Meta deney oluşturma, otomatik metrik çekimi, görsel üretimi/yükleme ve bütçe değişikliği bu ekranlarda etkin değildir. Kural denetimi sınırlı, sürümlü bir ifade taramasıdır; Meta onayı garanti etmez. LLM politika değerlendirmesi ve veritabanından kural yönetimi henüz yoktur. Bu faz mevcut Fastify salt okunur demo API'sine oturum entegrasyonu eklemez.

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

Kararlar: `docs/decisions/0004-ad-studio.md`, `0005-authenticated-studio.md`.
