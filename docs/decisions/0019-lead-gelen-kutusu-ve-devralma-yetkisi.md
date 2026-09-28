# 0019 — Lead gelen kutusu, 24 saat penceresi göstergesi ve devralma yetkisi (Faz 4)

- Tarih: 2026-09-28
- Durum: Kabul (ürün sahibi onayı: 2026-09-28, Faz 4 planı ve 6. madde "devralma yetkisi")
- Önceki kararlar: ADR-0013 (lead asistanı), ADR-0016 (devir gerçeği), ADR-0017 (kabuk), ADR-0018 (Bugün)
- Uygulanan karar: K4-A (gelen kutusu: liste + sohbet + lead kartı; telefonda liste → tam ekran sohbet)

## Bağlam
Faz 4 öncesinde lead ekranı şöyleydi:
- Lead'ler bir tablodaydı; tabloda kimin yanıt beklediği görünmüyordu.
- Ayrıntı sayfasında sohbet, bilgi kartlarının altında kalıyordu.
- Yazma alanı mesajların altında, sayfayla birlikte kayıyordu.
- WhatsApp'ın 24 saat kuralı, ancak gönderim hata verince öğreniliyordu.
- Reklam uzmanı, asistanın yürüttüğü konuşmayı devralabiliyordu. Oysa devralınmış konuşmaya yazması yasaktı.
  Bu yüzden devralıp sonra yazamıyordu (ADR-0016'da açık soru).
- Konuşma okuma uçları (`GET /api/conversations/:leadId`, `GET /api/leads/:id/messages`) her role açıktı.
  İzleyici ve analist hasta mesajlarının içeriğini okuyabiliyordu; mesajlar çoğu zaman sağlık verisi içerir.

## Karar

### 1. Gelen kutusu düzeni (`app/leads/layout.tsx`, `inbox-shell.tsx`, `lead-inbox.tsx`)
- **Liste düzende yaşar.** Başka bir lead seçilince liste yeniden yüklenmez; seçim URL'de tutulur (`/leads/<id>`).
  - Masaüstünde solda liste (340 px), sağda seçili lead durur.
  - Telefonda seçim yoksa yalnızca liste görünür. Seçim varsa yalnızca konuşma görünür, alt sekme çubuğu gizlenir.
  - Sayfa kaymaz; yalnızca liste, mesajlar ve bilgi paneli kendi içinde kayar.
- **Sekmeler** (`?tab=`; ←/→ tuşlarıyla gezilebilir):
  - Yanıt bekleyen: en uzun bekleyen en üstte.
  - Devralınan: en son hareket en üstte.
  - Tümü: en son hareket en üstte.

  Sekme seçilmemişse ve yanıt bekleyen varsa o sekme açılır. Arama (`?q=`, üst çubuk dahil) ve durum süzgeci
  sürüyor.
- **Kart:** Kartın tamamı tek bağlantıdır ve seçili kart `aria-current` taşır. Kartta şunlar var:
  - ad ve son hareket zamanı;
  - kanal · ülke · dil;
  - son mesajın önizlemesi, hastanın dili `lang` ile işaretli (asistan ve ekip mesajlarında önek var);
  - durum, "Asistan devretti" ya da "Devralan: …" / "Sizde" etiketi;
  - "12 dk bekliyor" bilgisi.
- **"Yanıt bekliyor" kuralı** (`_lib/inbox.ts`, sunucu): hasta bir insandan yanıt bekliyor demektir. Üç durumdan
  biri yeterli:
  1. Asistan konuşmayı devretti ve kimse devralmadı.
  2. Konuşma devralındı ve son mesaj hastadan geldi.
  3. Lead yeni (NEW), açık bir konuşması yok ve kendisine hiç mesaj gönderilmedi (ör. Anında Form).

  Asistanın yürüttüğü konuşma bir insan beklemez. Tedavi edilen ve kaybedilen lead yanıt beklemez.
- **Aynı kural her yerde:** menüdeki Lead'ler rozeti (`/api/shell`), "Bugün" sayfasındaki "N lead yanıt bekliyor"
  satırı (artık `/leads?tab=waiting` adresine gider) ve liste aynı kuralı kullanır.
- **API değişikliği:** `GET /api/leads` her lead için `inbox` alanı döner: konuşma durumu, devir bilgisi, son
  mesaj, `needsReply` ve `waitingSince`. Son mesaj önizlemesi yalnızca bakım rollerine gönderilir (Hesap sahibi,
  Yönetici, Reklam uzmanı, Hasta koordinatörü); diğer rollere `null` gider.
- **Kaldırılan:** kullanılmayan `LeadTable` bileşeni. `toLead` ve `filterLeads` işlevleri kaldı.

### 2. Lead ayrıntısı ve sohbet (`app/leads/[id]/page.tsx`, `_components/lead-chat.tsx`)
- **Başlık:**
  - ad, aşama şeridi, "kanal · ülke · dil · oluşturulma" satırı;
  - telefonda 44×44 geri düğmesi.
- **Gövde:**
  - Sağ bölme 900 px ve üzerindeyse (kap sorgusu) sohbet ve 320 px'lik lead kartı yan yana durur.
  - Daha darsa "Sohbet | Lead bilgileri" sekmeleri gösterilir (`tablist`, ←/→/Home/End).
  - Lead kartında sırasıyla: Meta'dan çekilemedi bandı, Kişi bilgileri, Durumu güncelle, Açık rıza kayıtları.
    İş mantığı ve diyaloglar değişmedi.
- **Sohbet:**
  - Üstte ince bir durum şeridi: kanal, devir durumu, Devral düğmesi.
  - Ortada kayan mesaj listesi.
  - Altta sabit yazma alanı: 2–6 satır; klavye ipucu yalnızca fare ve klavyeli cihazlarda görünür.
- **24 saat penceresi göstergesi:** `GET /api/conversations/:leadId` artık her konuşma için `replyWindow` döner
  (`lastInboundAt`, `endsAt`, `open`). Hesap, gönderim ucuyla aynı kuralla yapılır: yalnızca hastadan gerçekten
  gelen mesajlar sayılır (`_lib/messaging-window.ts`).
  - **Pencere açık:** "Yanıt penceresi açık · N sonra kapanır". Metin dakikada bir güncellenir; 2 saatten az kaldıysa
    amber gösterilir.
  - **Pencere kapalı ya da hasta henüz yazmamış (WhatsApp):** şablon modu açılır ve kapatılamaz. Nedeni yanında
    yazar.
  - **Pencere kapalı (Messenger / Instagram):** mesajın insan temsilci etiketiyle gönderileceği yazar.

### 3. Yetki değişiklikleri (sunucu)
- **Hastaya yazma** (`POST /api/leads/:id/messages`), **konuşmayı devralma**
  (`POST /api/conversations/:id/escalate`; asistanın yürüttüğü konuşma da dahil) ve **konuşma başlatma**
  (`POST /api/conversations/:leadId`) artık yalnızca `ESCALATION_ROLES` rollerine açık: Hesap sahibi, Yönetici,
  Hasta koordinatörü.
  - Gerekçe: hastaya yazmak asistanı susturup konuşmayı üstlenmek demektir. Reklam uzmanı konuşmaları okuyabilir
    ama yazamaz.
  - Arayüz: `canReply=false` olan kullanıcı yazma alanını ve Devral düğmesini görmez; onun yerine bir açıklama notu
    görür.
- **Konuşma okuma** (`GET /api/conversations/:leadId`, `GET /api/leads/:id/messages`) artık yalnızca bakım
  rollerine açık (`CARE_ROLES`). Analist ve izleyici 403 alır; arayüz "Mesajları görme yetkiniz yok." der.
  Lead'in iletişim alanları için mevcut maskeleme sürüyor.
- **İstemci API katmanı:** `client-api.ts` hataları artık `ApiError(status)` olarak fırlatır. Böylece 403 gibi
  durumlar metin karşılaştırmasıyla değil, durum koduyla ayırt edilir.

## Sonuçlar
- **Doğrulama:**
  - web: tip denetimi ve eslint temiz; 39 test dosyası ve 249 test geçti (DB dahil).
  - Yeni testler:
    - `inbox.test.ts`: yanıt bekliyor kuralı, sekmeler, sıralama, önizleme maskesi, 24 saat penceresi.
    - `inbox.integration.test.ts`: liste alanları, rol bazlı okuma, reklam uzmanının devralamaması ve
      yazamaması, koordinatörün devralması.
  - axe: gelen kutusu, iki konuşma ve "Bugün", iki boyutta; bilgi sekmesi açıkken de tarandı. Seçili kartta
    kontrastı 4,45:1 olan bir zaman metni koyulaştırıldı; tarama temiz.
  - Etkileşim denetimi:
    - sekmenin URL'den gelmesi;
    - ok tuşlarıyla sekme değişimi;
    - seçilen lead'in `aria-current` taşıması;
    - telefonda liste ve alt çubuğun gizlenmesi;
    - bilgi sekmesi;
    - sayfanın kaymaması.
- **Yan düzeltme:** `budget.integration` testindeki aralıklı hata giderildi. Hata, aynı milisaniyede oluşan reklam
  setlerinin sırasının belirsiz olmasından kaynaklanıyordu; `budget-change.ts` sorgusuna `id` ikincil sıralaması
  eklendi.
- **Bilinen noktalar:**
  - Hasta koordinatörünün ana sayfası gelen kutusudur (`/leads`). "Bugün" sayfasındaki lead satırı da aynı kuralla
    buraya gider.
  - Gelen kutusu listesi en yeni 100 lead'i gösterir (mevcut API sınırı). Sayfalama gerekirse sonraki bir işte ele
    alınacak.
  - Telefonda WhatsApp şablon alanları, hasta henüz yazmamışken yazma alanının büyük kısmını kaplıyor.
    Onaylı şablon listesi (şablon kaydı) geldiğinde bu alanlar tek bir seçim kutusuna iner (remaining-work §6).

## Güncelleme (2026-09-29, ADR-0022)
- Liste, rozet ve "Bugün" artık aynı lead kümesini kullanır: liste en yeni 100 lead'e ek olarak daha eski ama yanıt
  bekleyen lead'leri de döndürür.
- NEW durumunun etiketi "Yeni" oldu (mavi); amber "yanıt bekliyor" vurgusu yalnızca gelen kutusu kuralından gelir
  (aşama şeridi de buna göre).
- Mesaj okuma kuralı bütün uçlara uygulandı: `GET /api/leads/:id` mesaj döndürmez; eski
  `GET /api/conversations/:id/messages` bakım rollerine sınırlıdır; `POST /api/ai/chat` yalnızca hastaya yazabilen
  rollere açıktır. Devir uyarısını yalnızca hastaya yazabilen roller kapatabilir.
- Gelen kutusu ilk açılışta bir kez yüklenir (önceden iki kez); `?status=` süzgeci uygulama içi bağlantıda da okunur.
