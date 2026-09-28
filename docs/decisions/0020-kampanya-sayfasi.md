# 0020 — Kampanya sayfası, tek kampanya listesi ve kampanya performansı toplama (Faz 5)

- Tarih: 2026-09-28
- Durum: Kabul (ürün sahibi onayı: 2026-09-28, Faz 5 planı)
- Önceki kararlar: ADR-0014 (tam PAUSED yayın, harcama yetkisi), ADR-0015 (reklam düzeyi inceleme),
  ADR-0018 (aşama şeridi)
- Uygulanan karar: K5-C (kampanya sayfası = yaşam döngüsü şeridi + tek sıradaki eylem)

## Bağlam
Faz 5'ten önce kampanyayla ilgili tüm iş Kampanya planlayıcı sayfasındaydı. Bu tek sayfa (yaklaşık 1.500 satır)
şunları birlikte barındırıyordu:
- aylık üst sınır,
- harcama yetkisi,
- yeni kampanya formu,
- her kampanya satırındaki iş akışı: içerik ve görsel, onay, Meta'ya yükleme, etkinleştirme, duraklatma, arşiv ve
  inceleme.

Kampanyalar sayfası ise ayrı bir tablodan oluşuyordu ve kampanya başına harcama sütunu boş kalıyordu. Bunun
nedeni, Meta insight anlık görüntülerinin reklam düzeyinde saklanması ama sayfanın yalnızca kampanya düzeyindeki
satırları toplamasıydı. Meta'da oluşturulmuş kampanyalar da onay akışında "Taslak" olarak görünüyor ve onlara
"Onaya gönder" öneriliyordu.

## Karar

### 1. Kampanya sayfası (`/campaigns/[id]`)
- **Başlık:**
  - kampanya adı,
  - aşama şeridi,
  - "hedef · pazarlar · diller · günlük bütçe · dönüşüm yöntemi" satırı,
  - tek sıradaki eylem (aşağıdaki tablo),
  - yalnızca geçerli olanlarıyla "Diğer işlemler": Duraklat, Arşivle, Meta incelemesini yenile.

  | Durum | Sıradaki eylem (yetkiliye) |
  |---|---|
  | Taslak / düzeltme istendi | Hazırlık eksikse "Hazırlığı tamamla" (İçerik sekmesine geçer), hazırsa "Onaya gönder" |
  | Onay bekliyor | "Onayla" + "Düzeltme iste" (Hesap sahibi / Yönetici) |
  | Meta'ya yüklenmeye hazır | "Meta'ya yükle (kapalı)" / "Yüklemeye devam et" |
  | Etkinleştirme bekliyor | "Etkinleştir". Onay penceresinde günlük tutar, aylık etki, üst sınır ve Meta reddi gösterilir; eylem harcama yetkisi olan kişiye açıktır |
  | Yayında | yok |

  Yetkisi olmayan kullanıcı düğme yerine kimin işlem yapabileceğini söyleyen bir not görür.
- **Sekmeler** (`?tab=`, ←/→/Home/End):
  1. **Genel:** plan özeti, ajanın gerekçesi, hazırlık uyarıları, reklam setleri tablosu.
  2. **İçerik ve görsel:** onaylı içerik taslağı seçici, açılış sayfası, görsel yükleme.
  3. **Meta'ya yükleme ve inceleme:** yükleme ilerlemesi, son hata, reklam düzeyi inceleme.
  4. **Performans:** 7 ve 30 günlük göstergeler, günlük harcama grafiği (SVG; altında aynı verinin tablosu),
     reklam seti kırılımı.
  5. **Ajan kararları:** kampanyaya, reklam setlerine ve reklamlara ait kararlar ile bütçe değişiklikleri; hedef
     adları görünür.
- **Veri:** yeni `GET /api/campaigns/:id` ucu (salt okunur; çalışma alanı dışındaki kampanya için 404). Uç şunları
  döner:
  - planlayıcı listesiyle aynı kampanya görünümü (`_lib/campaign-view.ts`, `loadCampaignViews`; liste ucu da artık
    aynı modülü kullanıyor),
  - reklam setleri,
  - 7 ve 30 günlük toplamlar ile günlük seri,
  - kararlar ve bütçe değişiklikleri.
- **Mevcut uçlar aynen kullanılıyor:** tüm işlemler planlayıcıdaki uçları aynı gövdeyle çağırır. Harcama yetkisi,
  aylık üst sınır, yükleme devam döngüsü ve hata metinleri değişmedi.
- **Paylaşılan parçalar:** planlayıcıdan taşınan türler, yardımcılar ve küçük bileşenler tek bir modülde toplandı
  (`_lib/campaign-ui.tsx`).

### 2. Kampanyalar ve Yeni kampanya
- **`/campaigns` tek liste oldu.** Her satırda aşama şeridi ile son 7 günün harcaması, lead sayısı, lead başı
  maliyeti ve reklam getirisi görünür.
  - Süzgeçler: Tümü, Eylem bekleyen, Yayında, Arşiv (`?filter=`).
  - Sıralama: önce bir insandan eylem bekleyenler, sonra en çok harcayanlar.
  - Telefonda liste kart görünümünde; kartın tamamı bağlantı.
- **Planlayıcı "Yeni kampanya" oldu** (menü adı ve sekme adı da). Sayfada aylık üst sınır, harcama yetkisi ve
  kampanya oluşturma formu kaldı; kampanya listesi ve satır işlemleri kampanya sayfasına taşındı.
  - Taslak kaydedilince kampanya sayfası açılır.
  - Eski `?focus=<id>` bağlantıları kampanya sayfasına yönlendirilir.
- **Kampanya bağlantıları artık kampanya sayfasına gidiyor** (`campaignHref`): Onaylar, Bugün, uyarılar ve lead
  kaynağı.

### 3. Kampanya performansı toplama (`_lib/campaign-metrics.ts`)
- **Toplama:** insight anlık görüntüleri reklam, reklam seti ya da kampanya düzeyinde olabilir; hepsi kampanyaya
  toplanır. Reklam → reklam seti → kampanya eşlemesi çalışma alanıyla sınırlıdır.
- **Çift sayım önlemi:** aynı kampanya ve gün için birden fazla düzeyde satır varsa yalnızca en üst mevcut düzey
  sayılır.
- **Kullanıldığı yerler:** Kampanyalar listesi, kampanya sayfası ve "Bugün" sayfasının analist/izleyici için
  gösterdiği en iyi/en zayıf kampanyalar.

### 4. Meta'da oluşturulmuş kampanyalar (`isExternalCampaign`)
- **Tanım:** Meta kimliği olan, yayın durumu `EXTERNAL` olan ve iş akışı hâlâ taslak olan kampanya, Admedic onay
  akışına hiç girmemiş sayılır.
- **Gösterim:**
  - Aşama şeridi iş akışını değil Meta durumunu gösterir: "Meta'da yayında" (tamam) ya da "Meta'da duraklatıldı"
    (pasif).
  - Kampanya sayfası sıradaki eylem önermez; bunun yerine "onay ve yükleme adımları uygulanmaz" notunu gösterir.
- **Kapsam dışı:** akışa girmiş kampanyalar (onaya gönderilmiş, yüklenmiş, etkinleştirilmiş) yayın durumu kaydı
  olmasa da dış sayılmaz.

## Sonuçlar
- **Doğrulama:**
  - web: tip denetimi ve eslint temiz; 40 test dosyası ve 253 test geçti (DB dahil).
  - Yeni testler:
    - `stages.test.ts`: dış kampanya kuralı.
    - `campaign-page.integration.test.ts`: reklam düzeyi toplama, çift sayım önlemi, uç yanıtı, reklam adıyla
      kararlar, başka çalışma alanı için 404.
  - axe: kampanya listesi, iki kampanyanın sekmeleri, Yeni kampanya ve Bugün sayfaları, iki boyutta.
    - Telefonda yatay kayan tablolar klavyeyle odaklanabilir hâle getirildi (`tabIndex`, `role="region"`).
    - Son tarama temiz.
- **Bilinen noktalar:**
  - Demo verisinde insight satırlarının lead sayısı 0 olduğundan lead başı maliyet "—" görünüyor.
  - Taslak kaydedilince sayfa hemen kampanya sayfasına geçtiği için kaydetme yanıtındaki içerik kontrolü uyarıları
    ayrıca gösterilmiyor. Risk düzeyi Genel sekmesinde görünür.
  - Demo verisinde onay bekleyen (IN_REVIEW) kampanya olmadığından o durumun ekranı görsel olarak denetlenmedi.
    Akış planlayıcıdakiyle aynı uçları kullanıyor ve uç testleri geçiyor.

## Güncelleme (2026-09-29, ADR-0022)
- İçgörüler ve "Bugün" göstergeleri de bu toplama kuralını kullanır (İçgörüler'deki "Bütçe kullanımı" önceden reklam
  düzeyi satırları kampanyaya bağlamadığı için €0 gösteriyordu). Toplamlara yalnızca günlük satırlar girer.
- Onay akışından geçmiş ama yükleme adım kaydı olmayan kampanyada Yükleme sekmesi "Meta'da kuruldu" demez;
  "Meta'ya yüklendi, adım kaydı yok" der. Plan olmayan kampanyada reklam sayacı "2/0" yerine yalnızca yüklenen sayıyı yazar.
