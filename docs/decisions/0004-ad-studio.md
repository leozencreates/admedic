# ADR 0004 — Reklam stüdyosu ve manuel deney analizi

Tarih: 2026-09-20

Mevcut API salt okunur; web panelinde doğrulanmış kullanıcıya bağlı yazma altyapısı ve LLM sağlayıcısı yok. İlk stüdyo sürümü TR/EN şablonlarından düzenlenebilir iki reklam taslağı üretir. Taslaklar açık kullanıcı eylemiyle bu tarayıcıda saklanır; ortak tenant kaydı veya yayın onayı sayılmaz.

A/B ekranı manuel girilen harcama, tıklama ve lead sayılarını karşılaştırır. Bağımsız rastgele atanmış kitleler varsayımıyla tıklama→lead oranı için Wilson %95 aralıkları kullanılır. Her kolda en az 100 tıklama ve 10 lead, planlanan süre ve ayrık aralıklar olmadan kazanan önerilmez. CPL ayrıca raporlanır; istatistiksel sonuç gelir/ROAS kazananı olarak sunulmaz. Tek değişken ve sabit değerlendirme zamanı önerilir.

Bu sürüm Meta'ya yazmaz. Canlı yayın ve bütçe değişiklikleri mevcut onay/executor altyapısına sunucu tarafı yetkilendirme ile bağlanmalıdır. LLM, çok dilli politika motoru ve otomatik metrik senkronizasyonu sonraki entegrasyon işleridir.
