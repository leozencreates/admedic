# ADR-0011: Para birimi birimleri (minor units) ve ortak şifreleme modülü

- **Durum:** Kabul edildi
- **Tarih:** 2026-09-26
- **İlgili:** ADR-0007 (kampanya bütçe güncellemesi "major unit" notu), spec §3.3, §3.6, §3.11

## Bağlam

Veritabanı şeması `Organization.monthlyAdBudgetCap`, `Campaign.dailyBudget`, `AdSet.dailyBudget`,
`InsightSnapshot.spend/conversionValue` alanlarını **minor unit** (kuruş/cent) olarak tanımlar ve
seed verisi ile panel biçimlendirmesi (`formatMoney`) bu kurala uyar. Buna karşılık kampanya
oluşturma, bütçe değiştirme, yayınlama ve öneri uygulama rotaları `dailyBudget`'ı **major unit**
olarak saklayıp Meta'ya `×100` gönderiyordu; planlayıcı ise aylık üst sınırı cent, kampanya
rotası major olarak yorumluyordu. Aynı üst sınır iki yolda 100× farklı değerlendiriliyordu ve
kampanya listesi bütçeleri 100× küçük gösteriyordu. ADR-0007 bu tutarsızlığı "ayrı bir migration
işi" olarak not etmişti.

Ayrıca alan seviyesinde şifreleme üç farklı anahtar türetimiyle yapılıyordu (web: scrypt,
worker: hex/sha256, config: kullanılmayan `getEncryptionKey`). Worker, web'in şifrelediği
Meta token'larını çözemiyordu.

## Karar

1. **Veritabanında para her zaman minor unit'tir** (şema yorumları bağlayıcıdır). Tek istisna
   yoktur; `dailyBudget`, `monthlyAdBudgetCap`, `spend`, `conversionValue`, `value` alanları cent.
2. **API girdileri insan birimi (major) kabul eder** — panel formları ve mevcut testler bu şekilde
   çalışır — ve sunucu `Math.round(x * 100)` ile minor'a çevirir. API yanıtları minor değeri
   `…Cents` adıyla, gerekiyorsa major değeri de ayrıca döner.
3. **Meta'ya gönderim** `@admedic/meta-api` `dailyBudgetCents` alanıyla doğrudan minor değerdir;
   `×100` çarpımı rotalarda yapılmaz. Meta'dan okunan `daily_budget` değerleri de minor'dır
   (`MetaCampaign.dailyBudgetCents`).
4. **Aylık üst sınır kontrolü** her yolda aynı formülle yapılır: `dailyBudgetCents * 30 >
   monthlyAdBudgetCap` (ikisi de minor). Üst sınır `PATCH /api/org/settings` ile major girilir.
5. **Şifreleme tek modüldür:** `@admedic/config` `encryptField/decryptField`
   (AES-256-GCM, anahtar = scrypt(ENCRYPTION_KEY, "admedic-salt")). Web ve worker bu modülü
   kullanır; `ENCRYPTION_KEY` 64 hex karakter zorunludur, `AUTH_SECRET`'ten türetme yoktur.
   Anahtar süreç ömrü boyunca bir kez türetilir (scrypt maliyeti liste isteklerinde tekrarlanmaz).

## Sonuçlar

- Mevcut veritabanlarında major olarak kaydedilmiş kampanya bütçeleri (yalnızca API ile
  oluşturulan kayıtlar) 100× küçük görünür; `pnpm --filter @admedic/database db:seed` demo
  veriyi yeniler. Canlı kayıtlar için tek seferlik `UPDATE "Campaign" SET "dailyBudget" =
  "dailyBudget" * 100 WHERE ...` operatör kararıyla uygulanır (otomatik migration bilinçli olarak
  yazılmadı: hangi kayıtların major olduğu veriden anlaşılamaz).
- ADR-0007'deki "major unit" cümlesi bu ADR ile geçersizdir.
- Farklı ondalık hassasiyetli para birimleri (KWD, BHD: 3 ondalık) için `×100` varsayımı hâlâ
  sınırlıdır; hesap para birimine göre ölçek (`AdAccount.currency`) ayrı bir iş olarak kalır.
