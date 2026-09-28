# 0018 — "Bugün" ana sayfası, birleşik Onaylar kutusu ve aşama şeridi (Faz 3)

- Tarih: 2026-09-28
- Durum: Kabul (ürün sahibi onayı: 2026-09-28, Faz 3 planı)
- Önceki kararlar: ADR-0016 (K1–K11, Faz 1), ADR-0017 (kabuk, Faz 2)
- Uygulanan kararlar: K3-A ("Bugün" iş kuyruğu), K2-A'nın Onaylar kutusu, K8-C (aşama şeridi + K8-B etiketleri)

## Bağlam
Faz 1'de Onaylar sayfası gerçek onay işlerini saymaya başladı, ama hiçbir işte karar buradan verilemiyordu. Her
satır, kararın verildiği başka bir sayfaya ("Aç") götürüyordu. Ana sayfa (Genel bakış) bir gösterge kartları
panosuydu; kimseye "şu an sizden ne bekleniyor" demiyordu. Kampanyanın ve lead'in akıştaki yeri yalnızca bir durum
rozetiyle anlatılıyordu.

## Karar

### 1. Birleşik Onaylar kutusu (`/approvals`, `approvals-inbox.tsx`)
- **Kapsam:** tek bir listede dört tür iş var: içerik onayı, kampanya onayı, etkinleştirme ve bütçe önerisi.
  - Liste türe göre süzülür (sayılı düğmeler, `aria-pressed`).
  - En uzun bekleyen en üstte gösterilir.
  - Kampanya satırlarında aşama şeridi vardır.
- **Eylemler:** Satır başına en fazla bir birincil ve bir ikincil eylem bulunur; "Aç" her zaman ilgili sayfaya
  götürür. Eylemlerin hepsi mevcut API uçlarını kullanır ve yetki her çağrıda sunucuda yeniden denetlenir.

  | İş | Birincil | İkincil | Uç |
  |---|---|---|---|
  | İçerik | Onayla | Düzeltme iste (gerekçe zorunlu) | `PATCH /api/studio/[id]` approve / reject |
  | Kampanya | Onayla | Düzeltme iste (gerekçe zorunlu) | `POST /api/campaigns/[id]/approve` / `reject` |
  | Etkinleştirme | Etkinleştir (onay penceresi) | Aç | `POST /api/campaigns/[id]/publish` `ACTIVATE` |
  | Bütçe önerisi | Onayla | Yok say (onay penceresi) | `POST /api/recommendations/[id]/approve`, `PATCH … REJECTED` |
- **Etkinleştirme onay penceresi:** planlayıcıdakiyle aynı bilgileri gösterir:
  - günlük tutar,
  - bu kampanyanın aylık tahmini (günlük × 30),
  - etkin kampanyalarla birlikte aylık toplam ve üst sınır,
  - toplam üst sınırı aşıyorsa uyarı.

  Harcama yetkisi denetimi ve aylık üst sınır denetimi sunucuda değişmedi (ADR-0014).
- **Başarılı işlemden sonra:** satır listeden çıkar, sonuç `aria-live` bölgesinde duyurulur ve sayfa sunucudan
  tazelenir. Hata olursa mesaj satırın ya da pencerenin içinde gösterilir, sayfa silinmez.
- **Rol kapsamı** (`scopePendingApprovals`):
  - **Hesap sahibi / Yönetici:** tüm işleri görür ve karar verir.
  - **Reklam uzmanı:** onay veremez. Yalnızca kendi onaya gönderdiği ya da Meta'ya yüklediği işleri görür.
    Harcama yetkisi varsa tüm etkinleştirmeleri görür ve yapabilir. Bütçe önerilerini görmez.
  - **"Düzeltme istenenler"** (`listCorrectionRequests`): reklam uzmanının gönderip reddedilen içerik ve
    kampanyaları, gerekçe ve karar verenle birlikte. Her satırda "Düzelt" eylemi vardır.
  - Menüdeki Onaylar rozeti (`/api/shell`) aynı kapsamı sayar.
- **Şema dışı küçük API değişikliği:** içerik düzeltme isteği artık isteğe bağlı bir gerekçe alır
  (`DraftActionSchema` → `reason`, 3–500 karakter). Gerekçe denetim kaydına (`DRAFT_REJECT.after.reason`) yazılır.
  Migration yoktur. Kampanya reddinde gerekçe zaten zorunluydu (`rejectionReason`).

### 2. "Bugün" ana sayfası (`/`, `_lib/today.ts`)
Menü adı "Genel bakış" yerine "Bugün" oldu.

**Sizden beklenenler:** Satır başına tek eylem vardır. Önce sorunlar, sonra en uzun bekleyenler gelir; en fazla 12
satır gösterilir.
- **Kritik uyarılar** (kritik önemdeki ya da Meta bağlantısı / token / reklam reddi / Meta API hatası türündeki
  açık uyarılar): "İncele" → ilgili kayıt. Yöneticiler ve reklam uzmanı görür.
- **Hasta devri:** asistanın devrettiği, henüz kimsenin devralmadığı konuşmalar. "Devral" → lead. Hastayla
  yazışabilen roller görür.
- **Onay işleri:** yalnızca kullanıcının karar verebildikleri gösterilir. "İncele" ya da "Etkinleştir" → Onaylar.
- **Reklam uzmanı için ayrıca:**
  - düzeltme istenenler ("Düzelt"),
  - onaylanıp Meta'ya yüklenmeyi bekleyen kampanyalar ("Meta'ya yükle" → planlayıcı).
- **Yanıt bekleyen lead'ler:** tek bir özet satırı. "Lead'leri aç" → `/leads?status=NEW` (liste süzülmüş açılır).

**Temel göstergeler** (hasta koordinatörü dışındaki roller):
- **Bu ayın harcaması:** yanında aylık üst sınır ve etkin kampanyaların aylık tahmini. Tahmin üst sınırı aşarsa
  amber gösterilir ve yanına "Hedefin dışında" yazılır.
- **Lead başı maliyet (CPL), son 7 gün:** Meta insight verisinden hesaplanır.
- **Nitelikli lead oranı, son 30 gün:** Nitelikli ve sonraki aşamalar ya da `qualifiedAt` dolu olanlar sayılır.
- **İlk yanıt süresinin medyanı, son 30 gün:** Asistan yanıtları dahildir. Hedef 15 dakika; aşılırsa amber.

**Kurulum rehberi** (Hesap sahibi / Yönetici; tamamlanınca gizlenir). Beş adım ve ilerleme çubuğu var:
1. Meta bağlantısı
2. Klinik profili
3. Aydınlatma ve açık rıza metinleri
4. Aylık harcama üst sınırı
5. İlk kampanyanın onaya gönderilmesi

**Analist / İzleyici:** iş kuyruğu yerine son 7 günün en yüksek ve en düşük reklam getirili kampanyaları görünür.
Insight anlık görüntüleri reklam, reklam seti ya da kampanya düzeyinde olabildiği için hepsi kampanyaya toplanır.

### 3. Aşama şeridi (K8-C, `_lib/stages.ts`, `_components/stage-bar.tsx`)
- **Kampanya aşamaları (5):** Taslak → Onay → Meta'ya yükleme → Etkinleştirme → Yayında.
- **Lead aşamaları (6):** Yeni → Görüşme → Nitelikli → Konsültasyon → Seyahat → Tedavi. Kayıp lead gri gösterilir.
- **Mevcut aşamanın rengi:**
  - amber: bir insandan eylem bekleniyor
  - mavi: süreç ilerliyor
  - kırmızı: düzeltme gerekiyor ya da sorun var
  - tüm bölümler yeşil: akış tamamlandı
  - gri: pasif ya da kapandı
- **Erişilebilirlik:** Şeridin yanında her zaman K8-B durum etiketi ve bir ekran okuyucu cümlesi bulunur (ör.
  "Aşama 4/5 (Etkinleştirme): Etkinleştirme bekliyor"). Renk tek başına anlam taşımaz.
- **Kullanıldığı yerler:** Onaylar kutusu, Kampanya planlayıcı satırları, Kampanyalar tablosu (Meta'ya
  yüklenmemiş kampanyalar), lead listesi ve lead ayrıntısı başlığı. Bu yerlerdeki eski durum rozetleri kaldırıldı.
  Lead ayrıntısındaki tekrarlanan "Durum" satırı da kaldırıldı.

## Sonuçlar
- **Doğrulama:**
  - web: tip denetimi ve eslint temiz; 37 test dosyası ve 237 test geçti (DB entegrasyonu dahil).
  - Yeni testler:
    - `stages.test.ts`
    - `today.test.ts`: rol kapsamı ve süre biçimi.
    - `today.integration.test.ts`: kuyruk sırası ve rol süzgeci, başka çalışma alanının kayıtları, düzeltme
      gerekçesinin yalnızca gönderene dönmesi, kurulum adımları.
  - axe: değişen 6 rota × iki boyut; 0 ihlal, yatay taşma yok.
  - Tarayıcı denetimi (yazma çağrıları engellenerek):
    - tür süzgeci;
    - boş gerekçe uyarısı;
    - etkinleştirme penceresindeki günlük ve aylık tutarlar;
    - yazma başarısız olunca satırda gösterilen hata.
- **Bilinen noktalar:**
  - Demo verisinde insight anlık görüntüleri yalnızca reklam düzeyinde olduğundan `/campaigns` sayfasının kampanya
    başına toplamı boş görünür. Bu eski bir sorundur; Faz 5'te (kampanya sayfası) ele alınacak.
  - Hasta koordinatörünün ana sayfası hâlâ `/leads`. Onun "Bugün"ü Faz 4'teki lead gelen kutusuyla birleşecek.

## Güncelleme (2026-09-29, ADR-0022)
- "Hasta devri" ve "N lead yanıt bekliyor" satırları yalnızca hastaya yazabilen rollere (ESCALATION_ROLES) gösterilir;
  reklam uzmanı bu satırları görmez (ADR-0019 yetki değişikliği). Kapanmış lead'in devri iş sayılmaz; devir ayrı
  satırda gösterildiği için "yanıt bekliyor" özetinde yeniden sayılmaz. Devirler sorunların hemen ardından sıralanır.
- Yanıt bekleyenler satırı `/leads?tab=waiting` adresine gider (ADR-0019); "Meta'ya yükle" satırı kampanya sayfasına
  gider (ADR-0020).
- Kuyruk toplamı, bir kaynak kendi sınırına ulaştığında "en az N" olarak yazılır.
- Göstergeler kampanya toplamıyla aynı kuralı kullanır (en üst düzey, günlük satırlar, 7 gün = bugün dahil 7 UTC günü).
- Onaylar rozeti rolün yapabileceği işi sayar: harcama yetkisi olmayan yöneticide etkinleştirmeler sayılmaz.
  Reklam uzmanının "kendi gönderdiklerim" süzgeci listenin sınırından önce uygulanır.
- Onay gönderemeyen roller Onaylar sayfasında açıklama görür.
