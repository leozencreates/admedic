# Demo verisi ve gizlilik öznesi

2026-09-20

Demo stüdyo verisi üretimle aynı DraftSchema ve JSON nesnesi biçimini kullanır.
Stüdyo bütçesi EUR cinsinden toplam test bütçesidir; reklam hesaplarındaki
minor-unit tutarlar ayrı tutulur. Demo sonuçları örnektir, Meta yayını değildir.

CRM gizlilik öznesi Lead'dir; oturum açan User ile varsayımsal ilişki kurulmaz.
Mevcut `/api/privacy/:id` URL'si artık lead ID kabul eder; klasörün eski
`userId` adı geriye dönük URL yapısını değiştirmez. İstekler workspace ve
organizasyon ile sınırlandırılır. Anonimleştirme transaction içindedir ve
denetim kaydına eski kişisel veri yazılmaz.
