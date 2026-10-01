# 0027 — Randevuya dönüşen Instagram konuşmaları asistana üslup örneği olur

- Tarih: 2026-10-01
- Durum: Kabul (ürün sahibi onayı: 2026-10-01 — "dönüşen konuşmalar örnek olsun", resmi API verisiyle)
- Önceki kararlar: ADR-0013 (LLM katmanı ve lead asistanı), ADR-0019 (lead gelen kutusu), ADR-0026 (sesli arama)

## Bağlam
Ürün sahibi, ajanların "başarılı Instagram mesajlarına" bilgisayar kullanımıyla (Instagram arayüzünü otomatik
kullanarak) ulaşmasını istedi. İki sorun vardı:

- Instagram arayüzünü otomasyonla kullanmak Instagram kurallarına aykırıdır ve kliniğin hesabının kapatılmasına yol
  açabilir. Bu ürünün Meta uygulama onayını da riske atar.
- Aynı veri zaten resmi yoldan geliyor: Instagram mesajları `messages` webhook'uyla alınıp `Conversation` ve
  `Message` tablolarına yazılıyor (ADR-0023 §6).

Ürün sahibi resmi API verisinin kullanılmasını ve randevuya dönüşen konuşmaların örnek olmasını onayladı.

## Karar

### 1. Ne örnek olur
- Kanalı Instagram olan, lead'i randevu aşamasına (`CONSULTATION_BOOKED`) ya da ötesine geçmiş konuşmalar.
- Yalnızca **ekibin (insan) yazdığı giden mesajlar**. Hastanın yazdıkları, asistanın kendi yanıtları ve sistem notları
  örnek olmaz.
- Aynı çalışma alanı ve yanıtlanan lead'le aynı dil. Yanıtlanan lead'in kendi konuşması ve anonimleştirilmiş lead'ler
  dışarıda kalır.
- En yeni 3 konuşma, konuşma başına ilk 4 yanıt, yanıt başına 400 karakter.

### 2. Neden yalnızca ekip yanıtları
Hastanın yazdıkları özel nitelikli (sağlık) veri içerir. Bunları başka bir hastanın konuşmasının istemine koymak hem
amaçla bağlantısız bir kullanım olur hem de modelin bir hastanın ayrıntısını diğerine aktarma riskini doğurur. Ekip
yanıtları üslubu ve akışı taşır; hastanın anlattıklarını taşımaz.

### 3. Maskeleme (`@admedic/llm` `toStyleExamples`)
Örnek metinde hastanın adı ve soyadı `[ad]`, e-posta ve telefon `[e-posta]` / `[telefon]` olur. İstemde örneklerin
yalnızca üslup için olduğu, kural ve gerçek sayılmadığı, ad, tarih, fiyat ve tıbbi ayrıntının kopyalanmayacağı yazar.

### 4. Varsayılan kapalı, kuruluş ayarı
`Organization.assistantExamplesEnabled` (Klinik ve marka → Yapay zekâ ayarları; hesap sahibi ya da yönetici).
Örnekli istem ayrı sürümle günlüğe yazılır: `lead-assistant-v1-ex1` (`LlmCallLog.promptVersion`).

### 5. Sesli ajana örnek verilmez
Onaylanan seçenek örneklerin arama ajanına da verilmesini içeriyordu. Bu yapılmadı: örnekler, maskelenmiş olsa da,
kliniğin hastalarla yazışmasından gelir ve ElevenLabs şartları yazılı anlaşma olmadan sağlık verisi gönderilmesini
yasaklar (ADR-0026 §4, `docs/elevenlabs-constraints.md`). Yazılı anlaşma yapılırsa ayrı kararla eklenebilir.

## Sonuçlar
- **Yeni:** `packages/database/src/assistant-examples.ts` (`loadTeamReplyExamples`), `toStyleExamples` ve
  `leadAssistantPromptVersion` (`@admedic/llm`); web (`lead-assistant.ts`) ve işçi (`assistant.ts`) asistanı aynı
  işlevleri kullanır. Örnekler okunamazsa yanıt örneksiz üretilir.
- **Doğrulama (bu ortam):** `@admedic/llm` 22 test (maskeleme, sınırlar, istem sürümü). İşçide veritabanlı uçtan uca
  test: ayar kapalıyken örnek yok; açıkken ekip yanıtları istemde, hastanın adı, yazdıkları, telefonu, asistan ve
  sistem mesajları, dönüşmeyen ve başka dildeki konuşmalar istemde değil.
- **Doğrulanmayan:** Gerçek LLM ile yanıt kalitesinin değişimi ölçülmedi. Yerel veritabanında Instagram konuşması yok.
- **Kalan risk:** Ekip yanıtının kendisi hastanın ayrıntısını yineleyebilir ("iki ameliyat geçirdiğinizi
  yazmıştınız"). Ad ve iletişim maskelenir, serbest metindeki sağlık ayrıntısı maskelenemez. Aydınlatma metninin bu
  kullanımı kapsaması hukuki inceleme ister; ayar bu yüzden kapalı başlar.
- **Kapsam dışı:** Entegrasyondan önceki Instagram konuşmalarının içe aktarımı; WhatsApp ve Messenger konuşmalarının
  örnek olması; örneklerin panelde önizlenmesi.
