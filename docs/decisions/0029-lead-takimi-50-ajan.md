# 0029 — Lead takımı: 50 ajanlık hiyerarşi, nihai karar direktörde, uygulama insan onayında

- Tarih: 2026-10-01
- Durum: Kabul (ürün sahibi onayı: 2026-10-01 — "lead bulmak için 50 ajanlık takım, hiyerarşi olsun, en son kararı
  en tepedeki versin"; ölçek: "doğrudan 50 ajan")
- Önceki kararlar: ADR-0002 (onay kapılı executor), ADR-0013 (LLM katmanı), ADR-0014 (harcama yetkisi),
  ADR-0018 (Onaylar kutusu)

## Bağlam
Ürün sahibi lead bulmak için 50 ajanlık hiyerarşik bir takım istedi; nihai kararı en tepedeki ajan verecek. Aynı
oturumda ajanların Facebook gruplarına gizlice girip lead kovalaması da istendi; bu **yapılmadı** (aşağıda §5).

## Karar

### 1. Takımın işi: reklam kanalında lead üretimini planlamak
Takım, hangi pazarda, hangi dilde, hangi hizmetle, hangi mesaj açısıyla ve ne kadar bütçeyle lead reklamı
yapılacağını önerir. Kanal yalnızca Meta lead formları, mesaja yönlendiren reklamlar ve kliniğin kendi sayfasıdır.

### 2. Kadro (`packages/lead-team/src/roster.ts`)
50 ajan: 1 direktör, 7 takım lideri, 42 uzman.

| Takım | Uzman | Odak |
| --- | --- | --- |
| Pazar | 7 | Türkiye, Almanya, Birleşik Krallık, Hollanda, ABD, Körfez, diğer |
| Dil ve mesaj | 8 | TR, EN, DE, RU, AR, FR, NL, PL |
| Hizmet | 7 | Tıbbi, diş, sağlıklı yaşam, cerrahi, teşhis, psikiyatri, paket ve konaklama |
| Kitle ve hedefleme | 5 | Demografi, ilgi alanı, yeniden hedefleme, yerleşim, zamanlama |
| Kreatif açı | 5 | Güven, hasta yolculuğu, ekip, konfor, soru ve çekinceler |
| Bütçe ve test | 5 | Dağıtım, lead başı maliyet, test planı, ölçekleme, harcama temposu |
| Uyum ve lead kalitesi | 5 | Reklam politikası, rıza, lead formu, yanıt hızı, kayıp nedenleri |

### 3. Hiyerarşi ve nihai karar (`packages/lead-team/src/run.ts`)
- Sıra: uzmanlar (aynı anda en fazla 6) → takım liderleri → direktör. Her ajan tek LLM çağrısıdır; çalıştırma başına
  50 çağrı. Geçersiz çıktıda ajan bir kez yeniden denenir.
- Uzman yalnızca bağlamı görür. Lider yalnızca kendi takımının raporlarını görür. Direktör yedi liderin raporunu görür
  ve **takımın nihai kararını verir**: en fazla 5 öneri, sıralı; elediklerini gerekçesiyle yazar.
- Bir uzmanın hatası takımı durdurmaz. Hiçbir uzmanı rapor veremeyen takımın lideri çağrılmaz. Hiçbir lider raporu
  yoksa ya da direktör geçerli karar üretemezse çalıştırma başarısızdır.
- Çıktılar şemayla doğrulanır (`schemas.ts`): bilinmeyen pazar ya da dil boş bırakılır, metin kısaltılır, sınır dışı
  bütçe yok sayılır.

### 4. Direktörün kararı uygulanmaz; insan onaylar
"En son kararı en tepedeki versin" isteği takım içi kararı karşılar. Projenin temel kuralı (spec §6, ADR-0002)
gereği ajanlar Meta'ya yazamaz ve harcama başlatamaz:

- Direktörün önerileri `PENDING` kaydedilir ve Onaylar kutusuna "Lead takımı önerisi" olarak düşer.
- Hesap sahibi ya da yönetici onaylar ya da gerekçeyle reddeder.
- **Onay kampanya oluşturmaz.** Yalnızca önerinin uygulanmaya değer bulunduğunu kaydeder; kampanya Yeni kampanya
  sayfasında kendi onay ve harcama yetkisi akışıyla kurulur (ADR-0014).

### 5. Yapılmayan: gruplara gizlice girip lead kovalamak
Ajanların Facebook gruplarına gizli ya da sahte kimlikle girip üyelere ulaşması istendi. Bu, insanları aldatmayı ve
sağlıkla ilgili kişisel verilerini rızasız toplamayı gerektirir; KVKK'ya ve Meta kurallarına aykırıdır, kliniğin reklam
hesabını ve bu ürünün Meta uygulama onayını riske atar. Takımın ortak kuralları bunu açıkça yasaklar
(`packages/llm/prompts/lead-team-v1.ts` kural 1): veri kazıma, sahte ya da gizli hesap, gruplara katılıp insanlara
ulaşma, istenmemiş mesaj ve liste satın alma önerilemez.

### 6. Ajanlara giden veri (`web/app/_lib/lead-team.ts`)
Kişisel veri gitmez. Bağlam: klinik profili (ad, diller, hedef pazar, hizmetler, akreditasyon, yasaklı ifadeler),
pazar hedefleri, kampanyaların son 30 günlük toplamları, aylık üst sınır ve lead hunisinin **sayıları** (aşama, dil,
kanal). Kayıp nedenlerinden yalnızca hazır neden sayılır; serbest metin not gitmez.

### 7. Maliyet ve koruma
- Yalnızca hesap sahibi, yönetici ya da reklam uzmanı çalıştırır; düğme onay ister.
- Çalışma alanı başına aynı anda bir çalıştırma, 24 saatte en fazla 3.
- Her çağrı `LlmCallLog`'a yazılır (`lead-team:<ajan>`, istem sürümü `lead-team-v1`).
- 20 dakikadan uzun süren çalıştırma yarıda kalmış sayılır ve kapatılır.

### 8. Deneme çıktısı
Deneme modunda ve yapay zekâ ayarlı değilken çalıştırma, kalıpla üretilen deneme çıktısıyla tamamlanır
(`simulate.ts`). Çalıştırma `simulated` olarak işaretlenir ve panel bunu uyarıyla gösterir. Canlı modda yapay zekâ
ayarlı değilse çalıştırma başlamaz (503).

## Sonuçlar
- **Yeni:** `packages/lead-team`, `packages/llm/prompts/lead-team-v1.ts`, `LeadTeamRun` / `LeadTeamReport` /
  `LeadTeamProposal` tabloları (göç `20261001100000_lead_team`), `/lead-team` sayfası ve menü öğesi,
  `GET/POST /api/lead-team`, `POST /api/lead-team/proposals/[id]`, Onaylar kutusunda yeni iş türü.
- **Doğrulama (bu ortam):** `@admedic/lead-team` 9 test (kadro sayısı, hiyerarşi sırası, eşzamanlılık sınırı, hata
  dayanıklılığı, şemalar). Web'de veritabanlı 6 test: roller, deneme çalıştırması, Onaylar'a düşme, karar, eşzamanlı
  çalıştırma ve günlük sınır, canlıda 503, sahte LLM taşıyıcısıyla 50 çağrı ve **isteklerde lead adı, telefon ve kayıp
  notu olmadığı**. Çalışan panelde deneme çalıştırması: 50/50 ajan, 5 öneri, Onaylar rozeti 5.
- **Doğrulanmayan:** Gerçek LLM ile hiç çalıştırılmadı (yerelde `ANTHROPIC_API_KEY` yok). Önerilerin kalitesi,
  çalıştırma süresi ve gerçek token maliyeti ölçülmedi. `/lead-team` erişilebilirlik kapısına (`web/e2e/a11y.pw.ts`)
  eklenmedi.
- **Maliyet:** Çalıştırma başına 50 çağrı. Bağlam her çağrıda yinelenir; gerçek tutar ilk canlı çalıştırmada
  `LlmCallLog` üzerinden ölçülmelidir.
- **Negatif:** Onaylanan öneri kampanyaya kendiliğinden dönüşmez; kullanıcı Yeni kampanya sayfasında yeniden girer.
  Öneriden kampanya taslağı üretmek ayrı iştir.
- **Çalışma biçimi:** Çalıştırma web sürecinde, yanıt gönderildikten sonra yürür. Sunucu o sırada yeniden başlarsa
  çalıştırma yarıda kalır ve 20 dakika sonra başarısız işaretlenir.
