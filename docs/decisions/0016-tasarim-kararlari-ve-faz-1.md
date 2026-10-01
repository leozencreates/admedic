# 0016 — Tasarım kararları (K1–K11) ve Faz 1 düzeltmeleri; aydınlatma / açık rıza ayrımı

- Tarih: 2026-09-28
- Durum: Kabul (ürün sahibi onayı: 2026-09-28, "hepsi ekip önerisi, Faz 1'i de onaylıyorum")
- İlgili spec: 3.7, 3.8, 3.11, §4 (i18n), arayüz genelinde
- Önceki kararlar: ADR-0006 (lead gizliliği), ADR-0014 (tam PAUSED yayın, harcama yetkisi), ADR-0015 (Instant Form rızası)

## Bağlam
Beş kişilik tasarım ekibi (UX araştırma, bilgi mimarisi, görsel tasarım, erişilebilirlik/mobil, içerik) paneli
ölçerek denetledi. Öne çıkan bulgular:

- Yan menü 19 düz öğe, ekran boyunda kesiliyordu: 1366×768'de Lead CRM, Uyarılar ve "Oturumu kapat" görünmüyordu.
  Mobilde menü her sayfada ilk ekranın %64'ünü kaplıyordu.
- Onay işi 4–6 ekrana dağılmıştı. "Onaylar" ile "Kararlar & Onaylar" aynı veriyi gösteriyordu ve ikisinde de onay
  verilemiyordu. Genel Bakış'taki "Onay bekleyen karar" sayacı tıklanamıyordu.
- Koordinatör, asistanın devrettiği hastayı göremiyordu: ekran "devralındı" diyordu ama kimse devralmamıştı.
- Ekranda ham kodlar vardı (PUBLISHED_PAUSED, LEAD_AD, OWNER, kayıt kimlikleri). Harcamayı başlatan "Aktifleştir"
  küçük bir çipti ve onay sormuyordu.
- axe: 405 kontrast düğümü (5 kök neden), etiketsiz alanlar vardı; lead satırları klavyeyle açılamıyordu.
  `window.confirm/prompt` kullanılıyordu, biçimler tutarsızdı ("18%", "29.27x", sunucu saat dilimi).
- KVKK: Instant Form metni ve Klinik sayfasındaki tek alan, aydınlatma ile açık rızayı birleştiriyordu. Panelde
  "Rıza ver" düğmesi, personelin rızayı hasta yerine "verdiği" izlenimini yaratıyordu.

Kararlar Claude Design tuvalinde ("Admedic Tasarım Kararları") seçenekleriyle birlikte sunuldu.

## Karar

### 1. Ürün sahibinin kararları (tümü ekip önerisi)
| # | Konu | Seçim |
|---|---|---|
| K1 | Görsel yön | B — Operasyon odası: koyu menü + mevcut mor, kompakt, veri önde |
| K2 | Menü yapısı | A — İş alanına göre 5 grup + Ayarlar, rol filtreli |
| K3 | Ana sayfa | A — "Bugün" iş kuyruğu: rol ve yetkiye göre, satır başına tek eylem |
| K4 | Lead ekranı | A — Gelen kutusu: liste + sohbet + lead kartı; mobilde liste → tam ekran sohbet |
| K5 | Kampanya deneyimi | C — Kampanya sayfası: yaşam döngüsü şeridi + tek sıradaki eylem |
| K6 | Sayfa başlığı | B — Kompakt başlık; tanıtım yalnızca boş durumda |
| K7 | Mobil gezinme | A — Rol bazlı alt sekme çubuğu + "Menü" |
| K8 | Durum anlatımı | C (B'nin etiketleriyle) — aşama çubuğu + "sıradaki adım" etiketi; amber = sizden eylem bekleniyor |
| K9 | Meta terimleri | C — Türkçe birincil, İngilizce ipucunda |
| K10 | Ses ve ton | A — Sade-profesyonel; metinde "siz", düğmede yalın emir, ünlem yok |
| K11 | Erişilebilirlik | B — Önce kritik akışlar + ortak bileşenler, sonra kademeli; otomatik axe kontrolü |

Ekip kararları: v1'de karanlık mod yok (token'lar hazır); grafikler kütüphanesiz ve sade; mobilde lead listesi kart
listesi olur, diğer tablolarda sütun önceliği uygulanır; içerik kendi dil etiketi ve yönüyle gösterilir (Arapça
sağdan sola), arayüz Türkçedir; ikon seti Lucide; yazı tipi IBM Plex Sans + Plex Sans Arabic (Faz 2).

### 2. Faz 1 (karar gerektirmeyen düzeltmeler) — bu değişiklikle uygulandı
Büyük yeniden tasarım (yeni menü, yazı tipi, "Bugün" sayfası) Faz 2+ işidir. Faz 1 yalnızca bugünkü ekranlarda
kırık, yanıltıcı ya da erişilemez olanı düzeltir.

**Ortak temel**
- `web/app/_lib/labels.ts`: tüm durum/rol/kanal/dil/ülke etiketleri için tek kaynak. Her `*Style` `{label, tone}`
  döndürür. Renk anlamı sabittir: amber = bir insandan eylem bekleniyor, blue = süreç ilerliyor, green = canlı/tamam,
  red = sorun, gray = pasif. `status.ts` ve `alert-labels.ts` bu kaynağı yeniden dışa aktarır.
  - Ajan kararlarında (AgentDecision) `PENDING`, onay kutusundaki bir iş değildir. Bu yüzden "Onay bekliyor" (amber)
    yerine `decisionApprovalStyle` ile "Uygulanmadı" (gri) gösterilir.
- `web/app/_lib/format.ts`: tr-TR ve Europe/Istanbul için ortak biçimler: "%18", "29,27×", "€3,18",
  "27 Eyl 2026, 20:57". Elle yazılmış `toLocale*` ve `toFixed` biçimlemeleri kaldırıldı.
- `web/app/_components/dialog.tsx`: `Dialog` ve `ConfirmDialog`, tarayıcının `<dialog>` öğesiyle çalışır (odak
  tutar, Esc ile kapanır). Tüm `window.confirm/prompt/alert` çağrıları bunlarla değiştirildi.
- `globals.css`:
  - Özel sınıflar `@layer components` içine taşındı, böylece Tailwind yardımcıları onları ezebilir.
  - Yeni kontrast token'ları eklendi (`--color-muted` #58617a vb.) ve `.input`, `.danger-button` sınıfları tanımlandı.
  - Mobilde giriş alanları 16 px (iOS yakınlaştırmasını önler).
- `app-shell.tsx`:
  - "İçeriğe atla" bağlantısı eklendi.
  - Yan menü kendi içinde kayar; hesap, dil ve çıkış her zaman görünür.
  - Mobilde "Menü" düğmesi var; `/login` sayfasında kabuk gösterilmez.
- Sekme başlıkları sayfaya özgüdür ("Onaylar · APP_NAME"): kök düzende şablon, bölüm `layout.tsx` dosyalarında
  `generateMetadata` + oturum koruması (`page-meta.ts`) kullanılır.
- Girişten sonra `next` parametresine ya da role göre yönlendirme yapılır: hasta koordinatörü → `/leads`, diğerleri
  → `/`. `next` yalnızca uygulama içi yol olabilir (`safeNextPath`).

**Akışlar**
- Lead sohbeti:
  - Sayfa değil, mesaj kutusu kayar; 30 saniyelik yenileme artık sayfayı zıplatmıyor.
  - Yanıt kutusu görünür ve çok satırlıdır.
  - Enter yalnızca fiziksel klavyede gönderir; dokunmatik ekranda Enter yeni satır açar.
- Devir yanılgısı düzeltildi. Asistan devrettiğinde ekranda "Asistan devretti — kimse devralmadı [Devral]" görünür.
  Devir uyarısı en az "Önemli" (WARNING) önemdedir, acil durumda "Kritik". Worker uyarı metinleri ham kanal kodu
  yerine kanal adını gösterir.
- "Etkinleştir" (harcamayı başlatır) artık birincil düğmedir ve bir onay penceresi açar. Pencerede günlük tutar ve
  aylık etki gösterilir. Sunucu tarafındaki harcama yetkisi denetimi değişmedi (ADR-0014).
- Lead satırları gerçek bağlantıdır ve klavyeyle açılır. Durum filtresi Türkçedir; liste düzenli aralıkla yenilenir.
  Kayıp diyaloğu erişilebilirdir ve hazır kayıp nedenleri sunar.
- Onay sayacı gerçek onay işlerini sayar (`pending-approvals.ts`). "Onaylar" ile "Kararlar & Onaylar" tekrarı
  kaldırıldı; ikincisi "Ajan kararları" oldu.
- İçgörüler grafiği düzeltildi (boş çubuklar sorunu). Onaylar ve İçgörüler sayfalarındaki mobil taşmalar giderildi.
- Studio A/B testi sayfasındaki "Meta verilerini güncelle" düğmesi kaldırıldı. Uç her zaman 409 döndürüyordu: studio
  deneyleri elle girilen ölçümle çalışır.
- Metin ve terimler K9-C ve K10-A'ya göre düzenlendi:
  - "Anında Form", "Reklam seti", "Etkinleştir" (asla "Aktifleştir"), "Meta'ya yükle (kapalı)" kullanılır.
  - Hata mesajları "ne oldu + ne yapmalı" biçimindedir; büyük harfli etiket yoktur.
  - `packages/meta-api` `resolveDelivery` mesajları ürünün hedef adlarını kullanır ("Potansiyel müşteri",
    "Satış", "Bilinirlik").

### 3. Aydınlatma metni ile açık rıza metninin ayrılması (KVKK)
Dayanak: KVKK Kurulu'nun 2026/347 sayılı İlke Kararı. Resmî metin (kvkk.gov.tr) bu ortamdan açılamadı; içerik
hukuk bürosu özetinden doğrulandı. Özete göre:
- Aydınlatma ve açık rıza ayrı metinlerde, ayrı başlık ve beyanlarla alınır.
- Başka bir hukuki sebebe dayanan işleme için yalnızca aydınlatma yapılır, rıza istenmez.
- Aydınlatma için en fazla "okudum ve anladım" beyanı alınabilir.
- Rızanın ispat yükü veri sorumlusundadır.

Uygulanan değişiklikler:
- Şema: `Organization.privacyNoticeText` eklendi (migration `20260928180000_privacy_notice_text`).
  `consentText` artık yalnızca açık rıza beyanıdır. Klinik sayfasında üç ayrı alan var: aydınlatma metni
  bağlantısı, aydınlatma metni, açık rıza metni. `api/org/settings` yeni alanı kabul eder (en fazla 20.000
  karakter) ve denetim kaydına yazar.
- Instant Form metinleri (8 dil):
  - Bölüm başlığı "Açık rıza" oldu. Gövde, aydınlatma bilgisinin ayrı bağlantıda olduğunu söyler.
  - Kutu metni "…açık rıza veriyorum" şeklindedir. Kutu zorunlu olmaya devam eder (anlam değişmedi).
  - Bağlantı adı "Aydınlatma metni" / "Privacy notice" / "Datenschutzhinweise" …
- Panelde rıza kaydı:
  - "Rıza ver" yerine "Açık rızayı kaydet" kullanılır. Pencere kaydedilecek beyanı gösterir ve kanıt ister: rızanın
    nasıl alındığı (yazılı mesaj, e-posta, imzalı form, kayıtlı telefon görüşmesi), tarih (gelecek tarih reddedilir)
    ve isteğe bağlı not.
  - API (`PATCH /api/leads/[id]`) kanıtsız rıza kaydını 422 ile reddeder. Kanıt `{recordedBy, basis, obtainedAt,
    note}` olarak saklanır; `acceptedAt`, rıza gününün İstanbul saatiyle öğlesidir.
  - Geri çekme, tehlike onay penceresiyle kaydedilir.

### 4. Hukuki açık sorular (ürün sahibi / avukat onayı bekliyor)
1. **Instant Form kutusu:** İlke Kararı'nın 3. ilkesine göre, başvuruya yanıt vermek için yapılan işleme (m. 5/2-c
   "sözleşmenin kurulması" ya da m. 5/2-f "meşru menfaat") açık rıza gerektirmeyebilir. O durumda zorunlu rıza
   kutusu ilkeye aykırı düşebilir. İki seçenek var:
   - (a) Kutu zorunlu veri işleme rızası olarak kalır (bugünkü durum).
   - (b) Başvuru işlemesi yalnızca aydınlatmaya dayanır; kutu isteğe bağlı pazarlama ve/veya sağlık verisi
     (m. 6) rızasına dönüşür. Sağlık verisi (tedavi ilgisi) için açık rıza gerekebilir.
   Karar, `ConsentRecord` türünü (DATA_PROCESSING / MARKETING / HEALTH_DATA) ve form şemasını etkiler.
2. **Metinler:** 8 dildeki taslak metinlerin son hâli (özellikle Türkçe, Almanca ve Arapça) hukuki onaydan
   geçmeli. Varsayılan açık rıza metni: `web/app/_lib/consent-texts.ts`; form metinleri:
   `web/app/_lib/lead-form-texts.ts`.
3. Panelden kaydedilen rıza için kabul edilecek kanıt türleri yeterli mi? Sözlü rızanın kayıt altına alınma
   biçimi ne olmalı?

## Sonuçlar
- Migration `20260928180000_privacy_notice_text` uygulanmalı (`scripts\dev-up.cmd` ya da `pnpm db:deploy`). Kod,
  alan olmadan `api/org/settings` çağrısında 503 döner.
- Bu değişiklikten önce yayınlanmış formların `LeadForm` kaydı eski birleşik metni saklar. Kayıt değişmez; kişinin
  gördüğü metnin kanıtı budur.
- Doğrulama:
  - web: tip denetimi ve eslint temiz; 32 test dosyası / 215 test (DB entegrasyon dahil) geçti.
  - Diğer paketler: `workers/meta-sync` 27, `packages/meta-api` 85 test geçti.
  - axe (wcag2a/aa/21aa): 18 rota × 1366×768 ve 390×844 = 36 sayfa yüklemesinde 0 ihlal, yatay taşma yok.
  - `budget.integration` testi paralel koşuda bir kez başarısız oldu; tek başına ve tekrar koşuda geçti. Paylaşılan
    test veritabanında sıra bağımlılığı olabilir; izlenmeli.
- Açık işler (Faz 2+): K1–K7 uygulaması (yeni menü ve kabuk, "Bugün" sayfası, lead gelen kutusu, kampanya sayfası,
  alt sekme çubuğu). Her faz başlamadan önce görev listesi ve plan ürün sahibinin onayına sunulur.
- Karar bekleyen küçük konu: reklam uzmanı (MEDIA_BUYER) şu an ACTIVE bir konuşmayı devralabiliyor (`CARE_ROLES`).
  Devralmanın `ESCALATION_ROLES` (Owner, Admin, Hasta koordinatörü) ile sınırlanması önerilir; yetki modelini
  değiştirdiği için Faz 4'te (lead gelen kutusu) ele alınacak.
