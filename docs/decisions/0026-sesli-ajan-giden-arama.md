# 0026 — Sesli ajanla giden arama (ElevenLabs) için hazırlık

- Tarih: 2026-10-01
- Durum: Kabul (ürün sahibi onayı: 2026-10-01 — "müsait lead'leri ElevenLabs ajanları telefonla arayacak",
  tetikleme: "ikisi de" — düğme ve varsayılanı kapalı otomatik arama)
- Önceki kararlar: ADR-0002 (onay kapılı executor), ADR-0015 (lead rızası), ADR-0019 (devralma yetkisi),
  ADR-0023 (sunucu merkezli mimari, veri Türkiye'de)
- Dış kısıtlar: `docs/elevenlabs-constraints.md` (2026-10-01)

## Bağlam
Ürün sahibi, müsait lead'lerin ElevenLabs sesli ajanlarıyla telefonla aranmasını ve bunun kuruluma eklenmesini
istedi. `docs/spec.md` yalnızca yazılı kanalları (WhatsApp, Messenger, Instagram) tanımlar; telefonla arama yeni
kapsamdır. Arama, hastayla doğrudan temas kurar ve ses ile transkript yurt dışındaki bir sağlayıcıda işlenir.

## Karar

### 1. Kapsam: entegrasyona hazır, varsayılan kapalı
Kod, şema, kurulum adımları ve denetimler eklendi. Gerçek arama yalnızca dört ortam değişkeni ayarlandığında ve
deneme modu kapalıyken yapılır. Gerçek bir ElevenLabs hesabıyla deneme bu kararın dışındadır.

### 2. "Müsait lead" kuralı (`packages/voice/src/eligibility.ts`)
Elle ve otomatik arama aynı kuralı kullanır; kural sunucuda, arama kaydı açılmadan önce ve lead bazlı kilit altında
denetlenir.

| Koşul | Gerekçe |
| --- | --- |
| Telefonla aranma rızası kayıtlı (`ConsentType.PHONE_CALL`, geri çekilmemiş) | ElevenLabs şartı ve KVKK; pazarlama rızasından ayrıdır |
| Aşama `NEW`, `CONTACTED` ya da `QUALIFIED` | Randevudan sonra ilişki insandadır |
| Hiçbir konuşmayı koordinatör devralmamış | ADR-0019: devralınan lead'e otomasyon dokunmaz |
| Telefon ülke koduyla yazılmış ve ülkenin saat dilimi tanımlı | Yerel numara tahmin edilmez; bilinmeyen ülke aranmaz |
| Lead'in yerel saati 09:00–20:00 | Birden çok dilimli ülkede her dilimde uygun olmalı |
| En fazla 3 deneme, denemeler arasında en az 24 saat | Rahatsız etmeme |
| Sonucu bekleyen arama yok | Çift arama olmaz |
| (Yalnızca otomatik) Ajan daha önce görüşmemiş | Görüşülen lead'i koordinatör isterse elle arar |

### 3. Tetikleme
- **Elle:** lead sayfasında "Ajan arasın" (bakım rolleri). Onay diyaloğu gösterilir.
- **Otomatik:** işçi her turda müsait lead'leri en eskiden başlayarak arar. Yalnızca
  `Organization.voiceAutoCallEnabled` açıkken; açma yetkisi yalnızca hesap sahibindedir. Sınırlar: tur başına 5,
  aynı anda 3, günde 50 arama.
- ADR-0002 ile ilişki: otomatik arama, insan onayı olmadan hastayla temas kurar. Bunu, hesap sahibinin açık ayarı ve
  lead başına rıza kaydı dengeler. Harcama ya da reklam yayını içermez.

### 4. Ajana giden veri
Yalnızca ad, dil, klinik adı ve arama kimliği (`call_ref`). İlgilenilen hizmet, konuşma geçmişi, e-posta ve soyad
gönderilmez. Açılış cümlesi (yapay zekâ ve kayıt bildirimi) ajan ayarına bırakılmaz, her aramada panelden gönderilir;
ajanda geçersiz kılma açık değilse ElevenLabs aramayı reddeder (fail-closed).

### 5. Arama sonucu
- `POST /api/webhooks/elevenlabs`: imza ham gövde üzerinden doğrulanır; gizli anahtar yoksa her istek 401.
- Olay idempotent işlenir (`VoiceCall.conversationId` benzersiz; kimlik kaydedilemediyse `call_ref` ile eşlenir).
- Yalnızca arama özeti saklanır (alan şifrelemesiyle); tam transkript ve ses saklanmaz. Lead anonimleştirilince özet
  ve sağlayıcı kimlikleri silinir.
- Görüşme gerçekleştiyse ve lead `NEW` ise `CONTACTED` olur (denetim kaydıyla).
- İki saat içinde sonucu gelmeyen arama işçi tarafından başarısız sayılır.

### 6. Deneme modu
`META_MOCK_MODE=true` iken dış istek yapılmaz; arama kaydı hemen "deneme" özetiyle kapanır ve lead durumu değişmez.

## Sonuçlar
- **Yeni:** `packages/voice`, `VoiceCall` tablosu, `ConsentType.PHONE_CALL`, `Organization.voiceAutoCallEnabled`,
  göç `20261001090000_voice_calls_and_assistant_examples`, ortam değişkenleri `ELEVENLABS_*`, Canlıya geçiş
  sayfasında "Sesli arama" denetimi, `docs/runbook.md` "Sesli arama" bölümü.
- **Doğrulama (bu ortam):** `packages/voice` 30 test (9'u veritabanlı): kural, imza, istemci gövdesi, arama akışı,
  idempotent webhook, otomatik tur. Çalışan panelde: rızasız ve saat dışı arama 409, rıza kaydı ve geri çekme,
  imzasız webhook 401, lead sayfasında panel.
- **Doğrulanmayan:** Gerçek ElevenLabs hesabıyla hiçbir şey denenmedi: giden arama, geçersiz kılmaların kabulü, dil
  kodları, webhook imzası (algoritma dokümanda değil, SDK kaynağından). Çalışan panelde başarılı arama da görülmedi
  (deneme sırasında İstanbul'da gece olduğu için kural aramayı reddetti); başarılı yol veritabanlı testlerle sınandı.
- **Ürün sahibi kararı bekleyenler (canlı aramadan önce):**
  - ElevenLabs ile sağlık verisi için yazılı anlaşma (Enterprise, BAA, zero retention).
  - Ses ve transkriptin yurt dışında işlenmesi ADR-0023'teki "veri Türkiye'de" kararıyla çelişir; KVKK yurt dışına
    aktarım dayanağı ve aydınlatma metni güncellemesi hukuki inceleme ister.
  - Arama saatleri ve ticari arama kuralları ülke bazında doğrulanmalı (panel 09:00–20:00 uygular).
- **Kapsam dışı:** Anında Form'a telefonla aranma rızası kutusu eklenmedi (rıza şimdilik panelden kaydedilir);
  toplu arama (batch) API'si kullanılmadı; arama sonucuna göre koordinatöre uyarı açılmıyor.
