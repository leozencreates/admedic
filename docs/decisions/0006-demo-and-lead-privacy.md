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

## Güncelleme (2026-10-01): saklama süresi işi çalışmıyordu

- **Hata:** `anonymizeExpiredLeads`, zaten anonimleştirilmiş lead'leri dışarıda bırakmak için
  `NOT: { metadata: { path: ["anonymized"], equals: true } }` süzgecini kullanıyordu. PostgreSQL'de bu süzgeç,
  `metadata` içinde `anonymized` anahtarı hiç olmayan satırları da dışarıda bırakır (karşılaştırma NULL döner).
  Uygulamanın oluşturduğu lead'lerde bu anahtar yoktur; saklama süresi dolan lead'ler hiç seçilmiyordu.
  Sahte istemcili test bunu göremiyordu.
- **Düzeltme (ürün sahibi onayı: 2026-10-01):** ölçüt artık anonimleştirmenin yazdığı ad yer tutucusudur
  (`firstName: { not: "[anonymized]" }`).
- **Süre son etkinlikten sayılır:** lead kaydı eski olsa da kesim tarihinden sonra mesajı ya da sesli araması olan
  lead anonimleştirilmez. Gelen WhatsApp mesajı ve ekibin yanıtı lead satırını güncellemediği için, bu koruma
  olmadan görüşmesi süren hasta silinebilirdi.
- **Doğrulama:** `packages/database/src/privacy.db.test.ts` gerçek veritabanında; eski süzgeçle 4 testten 3'ü
  kırılıyor, yenisiyle hepsi geçiyor.
- **İlk canlı kurulumda dikkat:** iş artık gerçekten siler ve geri alınamaz. İşçiyi başlatmadan önce kaç lead'in
  etkileneceğine bakın: `DRY_RUN=1 pnpm --filter @admedic/web retention:run`. Süre `Organization.retentionDays`
  (varsayılan 365 gün; Klinik ve marka → Çalışma alanı ayarları).
