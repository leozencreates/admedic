# Proje Spesifikasyonu: AI Sağlık Turizmi Meta Reklam Ajanı

Çalışma adı: **Admedic** (kesinleşmedi; kod tabanında `APP_NAME` ortam değişkeninden okunmalı, hiçbir yerde sabit yazılmamalı).

Bu doküman OpenCode için ana bağlam dosyasıdır. Her görevden önce ilgili bölümü oku. Belirsiz bir noktada varsayım yapma; "Açık Sorular" bölümüne ekle ve kullanıcıya sor.

## 1. Problem ve Amaç

Türkiye'deki sağlık turizmi klinikleri ve aracı acenteler (saç ekimi, diş, estetik, göz, bariatrik, check-up) yurt dışı hasta kazanımı için büyük ölçüde Meta reklamlarına (Facebook, Instagram, WhatsApp) bağımlı. Mevcut süreç manuel, çok dilli kreatif üretimi pahalı, Meta'nın sağlık reklam politikaları nedeniyle reklam reddi sık, gelen lead'lerin takibi dağınık ve yavaş.

Amaç: Klinik ve acentelerin Meta kampanyalarını çok dilli olarak planlayan, politika uyumlu kreatif üreten, gelen hasta adaylarını hızla karşılayıp nitelendiren ve performansı raporlayan, insan onaylı bir AI ajan platformu.

Hedefler (ölçülebilir):
- Kampanya kurulum süresini manuel sürece göre %70 kısaltmak.
- Meta'ya gönderilen reklamlarda politika kaynaklı red oranını %10'un altında tutmak.
- Yeni lead'e ilk yanıt süresini (7/24) 2 dakikanın altına indirmek.
- Her klinik için lead başı maliyet (CPL) ve nitelikli lead oranını tek panelde göstermek.

Kapsam Dışı (v1):
- Google Ads, TikTok, YouTube entegrasyonu (P2, mimari buna açık tasarlanmalı).
- Tıbbi tavsiye, teşhis veya fiyat taahhüdü veren sohbet botu. Bot yalnızca bilgi toplar ve insana devreder.
- Hasta tıbbi kayıtlarının (röntgen, tahlil vb.) saklanması.
- Otomatik ödeme/tahsilat.
- İnsan onayı olmadan bütçe harcayan veya reklam yayınlayan tam otonom mod.

## 2. Kullanıcı Rolleri

| Rol | Açıklama |
|---|---|
| Platform Admin | Sistemi işleten ekip. Tüm tenant'ları, faturalandırmayı ve global politika kurallarını yönetir. |
| Tenant Owner | Klinik veya acente sahibi. Meta hesaplarını bağlar, bütçe onaylar, ekip üyelerini davet eder. |
| Marketer | Kampanya taslağı oluşturur, kreatifleri düzenler, onaya gönderir. |
| Patient Coordinator | Lead'leri görür, WhatsApp/Messenger konuşmalarını devralır, lead durumunu günceller. |
| Viewer | Yalnızca rapor görüntüler. |

Sistem multi-tenant olmalı; her klinik/acente bir tenant. Tenant verileri satır seviyesinde izole edilmeli (Postgres RLS veya her sorguda zorunlu tenant_id filtresi + testler).

## 3. Özellikler

Öncelik: P0 = MVP için zorunlu, P1 = hemen ardından, P2 = gelecek (mimari buna engel olmamalı).

### 3.1 Meta Hesap Bağlantısı (P0)
- Meta Business Login (OAuth) ile Business Manager, Ad Account, Page, Instagram hesabı ve WhatsApp Business Account bağlama.
- Token'lar şifreli saklanır (AES-256-GCM, anahtar KMS/ortam değişkeninden). Token'lar asla loglanmaz veya frontend'e dönmez.
- Token süresi dolmadan yenileme ve bağlantı koptuğunda tenant'a bildirim.
- Graph API sürümü `META_GRAPH_API_VERSION` ortam değişkeninden okunur; sabit yazılmaz.

Kabul kriterleri:
- Tenant Owner birden fazla ad account bağlayabilir ve varsayılanı seçebilir.
- Yetkisi eksik izinlerle bağlanılırsa hangi iznin eksik olduğu açıkça gösterilir.
- Bağlantı kesilince kampanya işlemleri durur ve UI'da uyarı çıkar.

### 3.2 Klinik Profili ve Hizmet Kataloğu (P0)
Klinik bilgileri: ad, şehir, akreditasyonlar, Sağlık Bakanlığı uluslararası sağlık turizmi yetki belgesi bilgisi, hizmet verilen diller.
Hizmet kataloğu: işlem adı, kategori, paket içeriği (otel, transfer, tercüman), "başlangıç fiyatı" gösterilip gösterilmeyeceği.
Hedef pazarlar: ülke + dil eşleşmesi (ör. Almanya → DE/TR, İngiltere → EN, Rusya/Kazakistan → RU, Körfez → AR/EN).
Marka kılavuzu: logo, renkler, ton, yasaklı ifadeler listesi.

Bu profil, ajanın tüm kreatif ve mesaj üretiminde bağlam olarak kullanılır.

### 3.3 Kampanya Planlama Ajanı (P0)
Kullanıcı doğal dilde hedef verir ve ajan taslak üretir (yayınlamaz): kampanya yapısı (objective, ad set'ler, CBO/ABO ve gerekçesi), hedefleme önerisi (18 yaş altı hedefleme engellenir), dönüşüm yöntemi (Instant Form / Click-to-WhatsApp / landing page), test planı (kreatif varyasyon sayısı, süre, karar metriği).

Kabul kriterleri:
- Taslak, kullanıcı onaylamadan Meta'ya ACTIVE statüsünde gönderilmez; gönderilen her şey önce PAUSED oluşturulur.
- Toplam bütçe, tenant'ın aylık üst limitini aşarsa taslak bloklanır.
- Her öneri "neden" açıklamasıyla gelir.

### 3.4 Çok Dilli Kreatif Üretimi (P0)
Diller: TR, EN, DE, RU, AR, FR, NL, PL. Arapça için RTL önizleme.
Üretilenler: primary text, headline, description, CTA önerisi, Instant Form soruları, WhatsApp karşılama mesajı. Her kreatif için birden fazla varyasyon.
Görsel tarafı (P1): görsel brief, format uyarlama (1:1, 4:5, 9:16). Yapay "önce/sonra" görseli üretimi yapılmaz.
Çeviri değil yerelleştirme: her pazar için ayrı prompt'la üretilir.

### 3.5 Politika Uyum Kontrolü (P0, kritik)
İki katmanlı kontrol:
1. Kural tabanlı katman (deterministik, test edilebilir): kişisel özellik varsayımı, garanti/kesin sonuç vaadi, önce/sonra karşılaştırması, tenant yasaklı ifadeleri.
2. LLM katmanı: Meta Advertising Standards'a göre risk skoru (düşük/orta/yüksek), gerekçe ve düzeltilmiş öneri.
Yüksek risk onaya gönderilemez; orta risk uyarıyla gönderilebilir.
Politika kuralları `policy_rules` tablosunda sürümlü tutulur; Platform Admin günceller.
Meta'dan gelen red gerekçeleri kaydedilir ve kural setini iyileştirmek için raporlanır.

⚠️ Meta'nın sağlık/wellness reklamverenlerine yönelik veri paylaşımı ve dönüşüm optimizasyonu kısıtları zaman içinde değişiyor. Uygulama sırasında güncel Meta dokümantasyonunu kontrol et; bulduğun kısıtları `docs/meta-constraints.md` dosyasına tarihle not et.

### 3.6 Onay Akışı (P0)
Durumlar: DRAFT → IN_REVIEW → APPROVED → PUBLISHED_PAUSED → ACTIVE ve REJECTED, ARCHIVED.
ACTIVE'ya geçiş ve her bütçe artışı yalnızca Tenant Owner (veya yetki verdiği kişi) tarafından yapılabilir.
Her geçiş audit log'a yazılır: kim, ne zaman, önceki/yeni değer.

### 3.7 Lead Yakalama ve CRM (P0)
Kaynaklar: Meta Lead Ads (webhook leadgen), WhatsApp Cloud API, Messenger, Instagram DM.
Tek birleşik lead kartı: ad, ülke, dil, kanal, ilgilenilen işlem, kaynak kampanya/reklam, zaman.
Lead durumları: NEW → CONTACTED → QUALIFIED → CONSULTATION_BOOKED → TRAVEL_PLANNED → TREATED → LOST (kayıp nedeni zorunlu).
Tekrarlanan lead tespiti (telefon/e-posta normalize edilerek).
Webhook imzası (X-Hub-Signature-256) doğrulanmadan istek işlenmez; işlemler idempotent olmalı.

### 3.8 AI Karşılama ve Nitelendirme Asistanı (P0)
Yeni lead'e kendi dilinde otomatik karşılama. Bilgi toplar; tıbbi tavsiye/uygunluk değerlendirmesi/teşhis yapmaz; kesin fiyat vermez; insan isterse veya acil durum/kapsam dışı olursa koordinatöre devreder. Bot olduğunu ilk mesajda belirtir. WhatsApp 24 saatlik mesajlaşma penceresi ve şablon kurallarına uyulur. Koordinatör devralınca bot susar.

### 3.9 Dönüşüm Takibi (P1)
Meta Conversions API, yalnızca sağlık kategorisi için izin verilen olay/alanlarla. Veri minimizasyonu (işlem türü, sağlık durumu vb. Meta'ya gönderilmez). CRM durum değişikliklerinden offline dönüşüm olayı (kısıtlar dahilinde).

### 3.10 Performans Analizi ve Optimizasyon Önerileri (P0 raporlama, P1 öneri)
Günlük Insight çekimi (zamanlanmış job). Metrikler: harcama, gösterim, CPM, CTR, lead, CPL, nitelikli lead oranı, konsültasyon/tedavi dönüşümü, pazar/dil/kreatif kırılımı.
Öneriler P1, tek tıkla onaylanıp uygulanır; otomatik uygulanmaz. Anomali uyarıları. Haftalık PDF/e-posta rapor (P1) — pdfmake ile PDF, Resend ile e-posta; meta-sync zamanlayıcısında haftalık günde (WEEKLY_REPORT_DAY) dedup'lu gönderim, `api/reports/weekly?pdf=1` ile indirme.

### 3.11 Uyum, Güvenlik ve Denetim (P0)
KVKK ve GDPR: lead verileri kişisel veri; sağlık beyanları özel nitelikli kişisel veri. Açık rıza + aydınlatma metni Instant Form/bot akışında eklenebilir; rıza kaydı saklanır. Saklama süresi tenant bazında; süresi dolan lead'ler anonimleştirilir. Veri sahibi talepleri: dışa aktarma/silme endpoint'leri. RBAC + tüm yazma işlemlerinde audit log. Hassas alanlar (telefon, e-posta) alan seviyesinde şifreli. LLM prompt'larında lead adı yerine takma kimlik.

Not: Türkiye sağlık kuruluşlarının reklam faaliyetleri ve uluslararası sağlık turizmi mevzuatı hukuki değerlendirme proje sahibine ait; kodda yalnızca tenant bazında içerik kısıtı ve yetki belgesi alanı sağlanır.

### 3.12 Faturalandırma (P2)
Tenant bazlı abonelik, reklam harcamasından bağımsız.

## 4. Teknik Mimari

Önerilen stack (gerekçelendirerek değişiklik önerilebilir):
- Dil: TypeScript (strict), tüm monorepo.
- Monorepo: pnpm workspaces + Turborepo.
- Web: Next.js (App Router), Tailwind, shadcn/ui. Arayüz dilleri TR ve EN (i18n baştan kurulmalı).
- API: Next.js route handlers veya ayrı Fastify; tüm girdiler Zod ile doğrulanır.
- Veritabanı: PostgreSQL + Prisma veya Drizzle.
- Kuyruk/zamanlanmış işler: Redis + BullMQ (webhook işleme, insights çekimi, mesaj gönderimi).
- LLM: Anthropic Claude API, sağlayıcı soyutlama katmanı arkasında (`packages/llm`). Model adı ortam değişkeninden.
- Gözlemlenebilirlik: pino, Sentry, kişisel veriler maskelenir.
- Test: Vitest (birim), Playwright (E2E). Meta API çağrıları için mock katmanı zorunlu.

Dizin yapısı:
```txt
apps/
  web/            # Panel (Next.js)
  worker/         # BullMQ job'ları
packages/
  db/             # Şema, migration, seed
  meta/           # Meta Marketing, Graph, WhatsApp Cloud API istemcileri
  llm/            # LLM soyutlama, prompt şablonları
  agents/         # campaign-planner, creative-writer, policy-checker, lead-assistant, optimizer
  policy/         # Kural tabanlı politika motoru + testleri
  shared/         # Tipler, Zod şemaları, yardımcılar
docs/
  meta-constraints.md
  decisions/      # ADR kayıtları
```

Ajan tasarım ilkeleri:
- Her ajan tek sorumluluklu; girdi/çıktı Zod şemasıyla tanımlı yapılandırılmış JSON.
- Ajanlar Meta'ya doğrudan yazamaz; yalnızca "önerilen aksiyon" nesnesi üretir; onay servisinden geçen ayrı bir executor uygular.
- Prompt şablonları `packages/llm/prompts/` altında sürümlü dosyalarda.
- Her LLM çağrısı kaydedilir (içerik maskelenmiş): tenant, ajan, prompt sürümü, token, süre.

Temel veri modelleri: Tenant, User, Membership, MetaConnection, AdAccount, ClinicProfile, Service, TargetMarket, Campaign, AdSet, Ad, Creative, CreativeVariant, PolicyCheck, PolicyRule, Approval, Lead, Conversation, Message, ConsentRecord, InsightSnapshot, Recommendation, AuditLog, LlmCallLog.

## 5. Geliştirme Fazları

- **Faz 0 – İskelet (1. hafta):** Monorepo, auth, multi-tenant yapı, RBAC, audit log, CI (lint, typecheck, test).
- **Faz 1 – MVP çekirdeği:** Meta bağlantısı, klinik profili, kampanya planlama ajanı, kreatif üretimi (TR/EN/DE/RU/AR), politika kontrolü, onay akışı, Meta'ya PAUSED yayın.
- **Faz 2 – Lead döngüsü:** Lead Ads webhook, WhatsApp Cloud API, AI karşılama asistanı, CRM paneli, rıza kaydı.
- **Faz 3 – Ölçüm ve optimizasyon:** Insights çekimi, raporlama paneli, anomali uyarıları, optimizasyon önerileri, CAPI (kısıtlar dahilinde).
- **Faz 4 – Genişleme:** Görsel uyarlama, ek diller, haftalık raporlar, faturalandırma, diğer platformlar.

## 6. OpenCode için Çalışma Kuralları

- Bir faza başlamadan önce o faz için görev listesi ve plan çıkar, onay bekle.
- Her anlamlı mimari karar için `docs/decisions/` altına kısa ADR yaz.
- Meta API davranışı hakkında emin olmadığın her konuda güncel resmi dokümantasyonu kontrol et; tahminle entegrasyon yazma.
- Para harcatan veya reklamı yayına alan hiçbir kod yolu insan onayı kontrolü olmadan birleştirilemez; bu kontrol için test yaz.
- Politika motoru (`packages/policy`) için her kurala pozitif/negatif test örnekleri ekle; TR, EN, DE, RU, AR dillerinde.
- Gizli anahtarları asla koda/teste yazma; `.env.example` güncel tutulsun.
- Kişisel veri içeren alanları loglama, snapshot testlerine koyma.
- Her PR/iş sonunda: ne yapıldı, nasıl test edildi, kalan riskler.

## 7. Başarı Metrikleri

| Tür | Metrik | Hedef |
|---|---|---|
| Öncü | Kampanya taslağından onaya geçen süre | < 30 dk |
| Öncü | Politika kontrolünden geçen kreatiflerin Meta onay oranı | > %90 |
| Öncü | Lead'e ilk yanıt süresi (medyan) | < 2 dk |
| Öncü | Bot → koordinatör devir oranı | İzlenecek |
| Gecikmeli | Nitelikli lead oranı | Tenant başlangıcına göre +%20 |
| Gecikmeli | Lead → konsültasyon dönüşümü | Tenant başlangıcına göre +%15 |
| Gecikmeli | Aylık aktif tenant tutma | > %85 |

## 8. Açık Sorular

| Soru | Kim yanıtlayacak | Bloklayıcı mı? |
|---|---|---|
| Ürün B2B SaaS mı, yoksa önce iç operasyon aracı mı? | Ürün sahibi | Evet (Faz 0 tenant modeli) |
| Hasta fotoğrafları platformda hiç işlenecek mi? | Ürün sahibi + hukuk | Faz 2 öncesi |
| İlk pilot klinik(ler) ve öncelikli işlem kategorileri hangileri? | Ürün sahibi | Faz 1 öncesi |
| Veri barındırma lokasyonu (TR / AB) | Hukuk + mühendislik | Faz 0 |
| Meta Tech Provider / App Review süreci hangi Business Manager ile yürütülecek? | Ürün sahibi | Faz 1 öncesi |
| Nihai ürün adı | Ürün sahibi | Hayır |

## 9. Eklenen Notlar

- 2026-09-16: Çalışma adı "Admedic"; uygulama adı kodda sabit değil, `APP_NAME` ortam değişkeninden okunur.
- 2026-10-01: Bu belgede olmayan dört kapsam ürün sahibi isteğiyle eklendi; ayrıntı ADR'lerde: Windows ve iOS
  uygulaması (ince istemci, ADR-0025), sesli ajanla telefonla arama (ADR-0026), asistana üslup örnekleri (ADR-0027),
  50 ajanlık lead takımı (ADR-0029). §6'daki insan onayı kuralı değişmedi: lead takımının önerileri onay bekler;
  otomatik arama yalnızca hesap sahibinin açtığı ayarla ve lead başına rıza kaydıyla çalışır.