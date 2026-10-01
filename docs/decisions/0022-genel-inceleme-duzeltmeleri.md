# 0022 — Altı fazın genel incelemesi: rol sınırları ve tutarlılık düzeltmeleri

- Tarih: 2026-09-29
- Durum: Kabul (ürün sahibinin "bütün fazları genel olarak kontrol et" isteği üzerine)
- Önceki kararlar: ADR-0016 – ADR-0021 (tasarım yenilemesi, Faz 1–6)

## Bağlam
Faz 1–6 tamamlandıktan sonra üç bağımsız inceleme yapıldı:
- **Güvenlik ve yetki:** kod okuyarak, `1650a23..HEAD`.
- **Kod tutarlılığı:** belgeler ile kodun uyumu, tekrarlanan ve ölü kod, test boşlukları.
- **Rol bazlı gezinme:** 6 rol × 2 ekran boyutu, yalnızca okuma.

Bu ADR bulunanları ve yapılan düzeltmeleri kaydeder. Güvenlik düzeltmelerinin ilk kısmı (Y1, Y2, O1) ayrı bir
commit'te yayınlandı (`3a990b0`).

## Karar

### 1. Hasta verisinin rol sınırları (güvenlik)

| Bulgu | Önce | Sonra |
|---|---|---|
| Y1 | `GET /api/leads/:id` son 10 mesajı her role döndürüyordu | Mesaj dönmez; mesajlar rol denetimli `GET /api/conversations/:leadId` ucundan okunur |
| Y2 | `GET /api/conversations/:id/messages` rol denetimi yapmıyordu | Yalnızca bakım rolleri (CARE_ROLES) okur |
| O1 | `POST /api/ai/chat` reklam uzmanına açıktı (hastaya gerçek gönderim, simüle kayıt) | Yalnızca hastaya yazabilen roller (ESCALATION_ROLES) |
| O2 | Lead listesi ve ayrıntısı izleyiciye açıktı (ad, ilgilendiği hizmet, kayıp nedeni) | İzleyici 403 alır; menüdeki Lead'ler ile aynı roller okur (`LEAD_READ_ROLES`) |
| O3 | `GET /api/alerts` rol süzmüyordu | Zil ile aynı kapsam (`_lib/alert-scope.ts`): izleyici 403, koordinatör yalnızca devir uyarıları |
| D1 | Uyarı rozeti ve bildirim listesi farklı rollere açıktı | İkisi aynı kapsamda |
| D2 | Rapor alıcısının e-postası her role dönüyordu | Yalnızca hesap sahibi ve yönetici görür |
| D3 | Reklam uzmanı devir uyarısını kapatabiliyordu | Devir uyarısını yalnızca hastaya yazabilen roller kapatır |
| D4 | Konuşma başlatanın kimliği istek gövdesinden alınıyordu | Her zaman oturumdaki kullanıcı |
| D5 | Sekme başlığında hasta adı reklam uzmanında da görünüyordu | Yalnızca hastaya yazabilen rollerde görünür |

- **Arayüz tarafı:** Lead ayrıntısındaki durum, rıza ve "Meta'dan yeniden çek" düğmeleri artık yalnızca bu işlemleri
  yapabilen rollere gösterilir. Uç, arayüze bunun için `canEdit` bayrağını döner.
- **Sayfa düzeyinde rol görünürlüğü:** Rolün menüde görmediği bölüm doğrudan adresle açılırsa sayfa yerine
  açıklama gösterilir (`guardedSection` + `nav-tree.ts` rol tablosu). Kapsanan örnekler:
  - izleyici için Meta bağlantıları, Faturalar ve Klinik;
  - koordinatör için Kampanyalar.

  Bu yalnızca arayüz tutarlılığıdır; yetki API'de denetlenir.
- **Uyarılar sayfası:** Zil ile aynı kapsamda. Her uyarının "Görüldü / Çözüldü" düğmesi yalnızca o uyarıyı
  kapatabilen role gösterilir.

### 2. Rol ve sayı tutarlılığı
- **Reklam uzmanı** artık şunları görmez: "Bugün"deki "Hasta devri → Devral" satırı, "N lead yanıt bekliyor" satırı
  ve Lead'ler rozeti. Bu işlerin hiçbirini yapamaz (ADR-0019).
- **Lead'ler rozeti, "Bugün" satırı ve gelen kutusu** aynı lead kümesini kullanır. Liste, en yeni 100 lead'e ek
  olarak daha eski ama yanıt bekleyen lead'leri de döndürür.
- **"Bugün" kuyruğu:**
  - Kapanmış lead'in devri kuyruğa girmez.
  - Devir, "yanıt bekliyor" özetinde ikinci kez sayılmaz.
  - Devirler sorunların hemen ardından sıralanır; bekleme süresi her zaman gösterilir.
  - Toplam, sınırlı kaynaklarda "en az N" diye yazılır.
- **Göstergeler ve İçgörüler** kampanya toplamıyla aynı kuralı kullanır (ADR-0020):
  - en üst düzey satır sayılır, yalnızca günlük satırlar toplanır;
  - "7 gün" bugün dahil 7 UTC günüdür.

  İçgörüler'deki "Bütçe kullanımı" artık €0 göstermiyor.
- **Onaylar:**
  - Rozet rolün yapabileceği işi sayar: harcama yetkisi olmayan yöneticide etkinleştirmeler sayılmaz.
  - Reklam uzmanının "kendi gönderdiklerim" süzgeci listenin sınırından önce uygulanır.
  - Onaya iş gönderemeyen roller Onaylar sayfasında açıklama görür.
- **Lead durumu:**
  - NEW durumunun etiketi "Yanıt bekliyor" yerine "Yeni" oldu (mavi).
  - Amber vurgu yalnızca gelen kutusu kuralından gelir; lead ayrıntısındaki aşama şeridi de buna uyar.
- **Uyarı bağlantıları:** Uyarı kaydı Meta kimliği taşısa da ilgili kampanyaya gider.
- **Harcama sınırları:**
  - "Bugün"deki sınır "kuruluşun aylık üst sınırı" diye adlandırıldı.
  - Politika sayfasındaki "ajanın hesap sınırı"nın bundan ayrı olduğu yazıldı.

### 3. Metin ve görünüm
- **Ham kodların yerine Türkçe adlar:**
  - içerik kuralı anahtarları (`guarantee` → "Garanti vaadi");
  - optimizasyon kuralı sürüm kodları (`policy_v1` → "Bütçe koruma kuralları");
  - yan menüdeki "Mod: MOCK" → "Mod: Deneme (Meta'ya bağlanmaz)".
- **Uyarı metinleri:**
  - Worker'ın ürettiği anomali uyarıları Türkçe sayı ve para biçimine geçti ("2,00×", "€250,00").
  - Demo tohum verisindeki uyarı metinleri Türkçeleştirildi.
- **Kampanya sayfası:**
  - Onay akışından geçmiş ama yükleme kaydı olmayan kampanyada Yükleme sekmesi artık "Meta'da kuruldu" demez.
  - Reklam sayacı "2/0" yazmaz.
- **Telefon:**
  - Bekleyen iş varsa kurulum kartı kuyruğun altına iner.
  - En iyi / en zayıf kampanya tablosu sığar; en zayıf listesi en iyi listesini tekrar etmez.
  - Kampanya sekmelerinde kaydırma ipucu var.
  - Alt çubukta "Reklam oluştur" yerine "Oluştur" yazar.
- **Tek süre biçimleyici** `formatDuration` ("3 sa 5 dk"); göreli zaman kaba kalır ("3 sa önce").
- **WhatsApp şablon modu:** "Enter gönderir" ipucu gösterilmez ve Enter şablonu göndermez.
- **Olmayan lead:** Açılışta h1 gösterilir.
- **Gelen kutusu:** İlk açılışta bir kez yüklenir; `?status=` süzgeci uygulama içi bağlantıda da okunur.

### 4. Temizlik
- **Silinen kod:**
  - kullanılmayan dışa aktarımlar: `pendingApprovalSummary`, `conversationStyle`, `alertStatusLabel`;
  - 15 kullanılmayan i18n anahtarı;
  - ölü CSS.
- **Birleştirilen tekrarlar:** `messageParty` ortak modüle taşındı (`_lib/message-party.ts`), `responseDuration`
  kaldırıldı.
- **Kampanya ucu:** Aynı toplama sorgusunu üç kez çalıştırmıyor.
- **Sistem notu süzgeci:** Gönderen alanı boş (NULL) mesajları artık dışlamıyor.

## Sonuçlar
- **Yeni testler:**
  - `tests/review-roles.integration.test.ts` (8 test), şunları kapsar:
    - lead ayrıntısı, eski mesaj ucu ve asistan ucu için yetkisiz rol reddi;
    - uyarı kapsamı ve kapatma yetkisi;
    - kabuk rozetleri;
    - rapor alıcısı;
    - "Bugün" kuyruğu kuralları;
    - rozet ile liste kümesinin aynı olması.
  - `tests/format.test.ts`.
  - Mevcut birim testlerine eklemeler: `nav-tree`, `stages`, `today`.
- **Açık kalanlar** (`docs/remaining-work.md`):
  - kabuk yoklamasının maliyeti;
  - UTC gün sınırı;
  - 3 ondalıklı para birimlerinin arayüzde gösterimi (ADR-0011 sınırı);
  - analistin lead adlarını görmesi (ürün kararı);
  - kampanya, politika ve ayar okuma uçlarının her role açık olması.
- **Demo veritabanı:** Yerel demo veritabanındaki eski uyarı metinleri `pnpm db:seed` ile yenilenir.
