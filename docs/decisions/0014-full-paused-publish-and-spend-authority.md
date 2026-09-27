# 0014 — Meta'ya eksiksiz PAUSED yayın ve harcama yetkisi (Owner + yetki devri, toplam aylık üst sınır)

- Tarih: 2026-09-27
- Durum: Kabul
- İlgili spec: 3.3, 3.4, 3.6, 3.11, §6
- Önceki kararlar: ADR-0002 (onay kapılı yürütme), ADR-0007 (bütçe güncellemeleri), ADR-0008 (sürümlü kurallar), ADR-0011 (para birimleri)

## Bağlam
Onaylanan kampanya Meta'ya yalnızca **kampanya kabuğu** olarak yazılıyordu: ad set, hedefleme, kreatif ve reklam
yoktu; "Aktifleştir" teslimatı olmayan bir kampanyayı açıyordu. Onaylanan metin (Kreatif Stüdyo taslakları)
kampanyaya bağlı değildi, yani onaylanan ile yayınlanacak içerik arasında bağ yoktu. ABO kampanyalar v24+'da
zorunlu `is_adset_budget_sharing_enabled` alanı olmadan oluşturulduğu için canlıda hata verecekti.

Spec 3.6 "ACTIVE'ya geçiş ve her bütçe artışı yalnızca Tenant Owner (veya yetki verdiği kişi) tarafından
yapılabilir" diyor; kod bu yetkiyi OWNER **ve ADMIN** rolüne veriyordu ve yetki devri kaydı yoktu. Aylık üst
sınır yalnızca işlem yapılan kampanyanın `günlük × 30` değerine bakıyordu; diğer aktif kampanyalar sayılmıyordu.

## Karar

### 1. İçerik ve görsel onaydan önce kampanyaya bağlanır (onaylanan = yayınlanan)
- `PUT /api/campaigns/:id/content` (veya oluşturmada `contentDraftIds`) yalnızca **APPROVED** stüdyo taslaklarını
  kabul eder ve `Campaign.content`'e **değişmez kopya** yazar (dil, varyantlar, Instant Form soruları, WhatsApp
  karşılaması; dil başına en fazla 3, toplam 8 taslak). Açılış sayfası bağlantısı (https) aynı kayda girer.
- `POST /api/campaigns/:id/image` JPEG/PNG'yi (sihirli baytlarla doğrulanır, ≤3 MB) reklam hesabının görsel
  kütüphanesine yükler, hash'i `Campaign.imageHash` olarak saklar. Kütüphanedeki görsel reklam değildir.
- İçerik ve görsel yalnızca DRAFT/REJECTED'da değişir; onaya gönderim (ve onay) planlı kampanyada **yayına
  hazırlık** koşullarını ister: yayınlanabilir hedef × yöntem, her pazarda en az bir içerikli dil, görsel,
  web için https açılış sayfası, Instant Form için kuruluşun https gizlilik politikası (`Organization.privacyPolicyUrl`).
- Politika kontrolü (submit/approve/publish/activate) artık kampanya adı + brief + **bağlı içeriğin tamamını**
  taze kural setiyle tarar (ADR-0008).

### 2. Yayın: eksiksiz, PAUSED, yarım kalırsa kaldığı yerden
`POST /api/campaigns/:id/publish {action:"PUBLISH"}` (`web/app/_lib/campaign-publish.ts`):
1. Ad set yapısı: planlayıcının pazar ad set'leri pazar × içerik dili olarak bölünür (Meta reklam dilini
   izleyiciye göre seçmez); ABO payı diller arasında eşit bölünür, toplam korunur. Bir kez, Meta'ya ilk yazımdan önce.
2. Kampanya (PAUSED; CBO'da bütçe kampanyada, ABO'da `is_adset_budget_sharing_enabled=false`).
3. Dil hedeflemesi: `search?type=adlocale` ile sayısal locale anahtarları.
4. Instant Form: taslak başına lead formu (dil, sorular, zorunlu rıza kutusu, gizlilik politikası; sayfa token'ı).
5. Ad set'ler (PAUSED; hedef türü/optimizasyon `resolveDelivery` ile: Instant Form → ON_AD/LEAD_GENERATION,
   WhatsApp → WHATSAPP/CONVERSATIONS, web → WEBSITE/LINK_CLICKS; sağlık kısıtları nedeniyle web dönüşüm
   optimizasyonu kullanılmaz). Instagram DM ve lead hedefi dışında Instant Form planlayıcıda engellenir.
6. Kreatifler: taslak varyantı başına bir kreatif; metni değiştiren Advantage+ özellikleri OPT_OUT.
7. Reklamlar (PAUSED): ad set × o dildeki taslak × varyant.
Her Meta nesnesinin kimliği çağrıdan hemen sonra yazılır (`Campaign.publishState`, `AdSet.metaAdSetId`, `Ad`).
Hata veya süre dolması (istek başına ~40 sn; her çağrıda en az bir adım ilerler) ilerlemeyi korur; aynı çağrı
kaldığı yerden sürer, nesne ikinci kez oluşturulmaz. `publishLockedUntil` eşzamanlı yayını engeller. Meta'da
oluşan nesne yerelde yazılamazsa `CAMPAIGN_PUBLISH_ORPHANED`, adım hatası `CAMPAIGN_PUBLISH_FAILED` denetimi
düşülür. Yarım kalan yayın arşivlenebilir (Meta'da kampanya duraklatılır). Planı olmayan (eski) kampanya yayınlanmaz.

### 3. Harcama yetkisi: yalnızca Owner veya Owner'ın yetki verdiği üye
- `Membership.canApproveSpend` (+ `spendGrantedBy`, `spendGrantedAt`). Yetkiyi yalnızca OWNER verir/geri alır
  (`PUT /api/org/members/:userId/spend-authority`), yalnızca ACTIVE **ADMIN** veya **MEDIA_BUYER** üyeye;
  her değişiklik `SPEND_AUTHORITY_GRANTED/REVOKED` denetimi. Etkin yetki her istekte veritabanından taze okunur
  ve rol değişince kendiliğinden düşer (`effectiveSpendAuthority`).
- Harcama yetkisi isteyen işlemler: **ACTIVATE**, **her bütçe artışı** (`PATCH …/budget`, öneri uygulama).
  Azaltma, duraklatma ve arşivleme EDIT rollerine açık kalır (harcamayı düşürür/durdurur).
- Aylık üst sınırı **yükseltmek veya kaldırmak yalnızca Owner'a** aittir: sınır, yetki devredilen üyeleri de
  bağlayan korumadır (devredilen üye sınırı yükseltebilseydi sınır onu bağlamazdı). Düşürmek OWNER/ADMIN'e açık.

### 4. Toplam aylık üst sınır
`aktif kampanyaların aylık toplamı + bu kampanyanın (yeni) günlük bütçesi × 30 ≤ kuruluş sınırı`
(`web/app/_lib/spend-cap.ts`). Aktif = `status=ACTIVE`, arşivlenmemiş, aynı para birimli hesaplar (kur çevrimi
yok); kampanyanın kendisi toplamda ikinci kez sayılmaz; ömür boyu bütçede tutarın tamamı sayılır. Kontrol
noktaları: planlayıcı (plan engeli), taslak oluşturma, bütçe artışı, öneri uygulama, **etkinleştirme**.
Etkinleştirme kuruluş satırı kilitliyken sınırı denetler ve kampanyayı yerelde ACTIVE sayarak rezerve eder
(eşzamanlı iki etkinleştirme sınırı birlikte aşamaz); Meta başarısız olursa rezervasyon geri alınır.
Meta'dan senkronlanan kampanyaların bütçesi (CBO: kampanya, ABO: aktif ad set toplamı) ve durumu worker
senkronunda yerele yazılır, böylece Ads Manager'da kurulmuş aktif kampanyalar da toplama girer.

### 5. Etkinleştirme zinciri
Tam yayınlanan kampanyada reklamlar → ad set'ler → kampanya ACTIVE (kampanya en son). Meta'dan senkronlanan
veya eski akışla yayınlanmış kampanyada yalnızca kampanya etkinleştirilir. Kampanya Meta'da açıldıktan sonra
yerel kayıt yazılamazsa kampanya yeniden duraklatılmaya çalışılır ve `CAMPAIGN_ACTIVATION_FAILED` düşülür.

## Sonuç
- Migration `20260927090000_full_publish_and_spend_authority` (Membership yetki alanları, Organization
  `privacyPolicyUrl`, Campaign `contentDraftIds/content/imageHash/imageUrl/publishState/publishLockedUntil`).
- Rol davranışı değişti: ADMIN artık tek başına etkinleştiremez ve bütçe artıramaz (Owner yetki vermeli);
  aylık üst sınırı yükseltemez/kaldıramaz. Meta OAuth kapsamına `pages_manage_ads` eklendi (Instant Form için
  yeniden yetkilendirme gerekir).
- Canlı doğrulama bekleyen noktalar ve kaynaklar: `docs/meta-constraints.md` (2026-09-27).
- Testler: `packages/meta-api/src/publish.test.ts`, `client.test.ts`, `mock.test.ts`; `web/tests/campaign-publish.test.ts`,
  `campaign-safety.test.ts`, `publish-flow.integration.test.ts`, `budget.integration.test.ts`,
  `spend-authority.integration.test.ts`, `org-settings.integration.test.ts`, `recommendations.integration.test.ts`;
  `workers/meta-sync/src/scheduler.db.test.ts`.
