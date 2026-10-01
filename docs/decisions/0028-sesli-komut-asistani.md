# 0028 — Sesli komut asistanı (ElevenLabs Agents, tarayıcıda istemci araçları)

- Tarih: 2026-10-01
- Durum: Kabul (ürün sahibi onayı: 2026-10-01 — R0–R4 risk modeli plandaki gibi; personel sesi ElevenLabs'te
  işlenir, veri konumu `ELEVENLABS_SERVER_LOCATION` ile seçilir; ajan LLM'i panelde denendikten sonra seçilir).
  Uygulama: Faz 0–1 (doğrulama, karar, sunucu altyapısı). Arayüz ve araçlar (Faz 2–5) sonraki turlarda.
- Önceki kararlar: ADR-0002 (onay kapılı executor), ADR-0013 (LLM katmanı), ADR-0014 (PAUSED yayın ve harcama
  yetkisi), ADR-0017 (kabuk ve menü ağacı), ADR-0019 (devralma yetkisi), ADR-0022 (rol ve tenant sınırları),
  ADR-0023 (sunucu merkezli mimari, güvenlik başlıkları), ADR-0026 (sesli ajanla giden arama)
- Değiştirdiği: ADR-0023 §5 `Permissions-Policy` (aşağıda §6)
- Dış kısıtlar: `docs/elevenlabs-constraints.md` (2026-10-01, "Sesli komut asistanı")

## Bağlam
Ürün sahibi, panele Türkçe konuşan, Siri benzeri bir mikrofon düğmesi istedi: personel sesle gezinsin, veri sorsun ve
işlem yaptırsın ("bütün emirleri yerine getirsin"). `docs/spec.md` sesli komut tanımlamaz; bu karar o kapsamı ekler.

İki zorluk var:
- Panelde 100'den fazla API ucu ve her birinde ayrı yetki, tenant, harcama ve denetim kuralı var. Sesin bunların
  hiçbirini atlamaması gerekir.
- Konuşma, araç sonuçları ve personelin sesi üçüncü taraf bir sağlayıcıda (ElevenLabs) işlenir. ADR-0023 "veri
  Türkiye'de" der; hasta verisi sızmamalıdır.

## Karar

### 1. Mimari: ElevenLabs Agents + tarayıcıda istemci araçları
- **Akış:** Tarayıcı `@elevenlabs/react` ile ajana bağlanır (varsayılan WebRTC). ElevenLabs konuşmayı metne çevirir
  (Scribe, Türkçe), aracı seçer ve yanıtı seslendirir (`eleven_flash_v2_5`). Seçilen araç tarayıcıda çalışır ve mevcut
  `/api/*` uçlarını kullanıcının kendi oturum çereziyle çağırır.
- **Sonuç:** Sesin yeni bir yetki yolu yoktur. `sameOrigin`, `requireRole`, tenant kapsamı (ADR-0022), harcama yetkisi
  ve aylık tavan (ADR-0014), denetim kaydı olduğu gibi devrededir; uçların mantığı kopyalanmaz.
- **Kimlik bilgisi:** Tarayıcı ElevenLabs API anahtarını görmez. `POST /api/assistant/session` oturumu, origin'i ve
  kotayı denetleyip sunucuda bir WebRTC token'ı (ya da WebSocket için 15 dakikalık imzalı URL) alır. Token'ın kısa
  ömürlü olduğu varsayılır; süresi ve tek kullanımlık olup olmadığı doğrulanmadı (`docs/elevenlabs-constraints.md`,
  DOĞRULANMADI). Panel token'ı saklamaz ve yeniden kullanmaz.
  Ajanda `enable_auth=true`; ElevenLabs bunu izinli host listesiyle birlikte önermediği için liste boş kalır.
- **Tek kaynak:** Araçların adı, şeması, rolü ve risk seviyesi `web/app/_lib/assistant/registry.ts` içindedir. Ajan
  yapılandırması bu kayıttan betikle üretilir (`web/scripts/elevenlabs-sync-agent.ts`); araç adları büyük/küçük harfe
  duyarlı olduğu için bir test, kayıt ile ajan yapılandırmasının birebir aynı olduğunu denetler. ElevenLabs'te araçlar
  ayrı bir kaynaktır (`/v1/convai/tools`) ve ajana `tool_ids` ile bağlanır.

Değerlendirilen diğer yollar:

| Seçenek | Sonuç |
| --- | --- |
| A — Sunucu araçları (ElevenLabs bizim uçlarımızı webhook ile çağırır) | Çağrıyı kullanıcı değil ElevenLabs yapar; oturum yoktur. Ajana ayrı bir kimlik bilgisi vermek gerekir ve bu, rol, tenant ve harcama denetimlerini atlar. Seçilmedi. |
| C — Kendi döngümüz (Scribe → kendi komut yönlendiricimiz → TTS) | Gecikme daha yüksek, kullanıcı asistanın sözünü kesemez; `packages/llm` araç çağrısı desteklemediği için büyük bir genişletme ister. Ertelendi; KVKK incelemesi ElevenLabs'in LLM'ini kabul etmezse yedek yoldur (ayrı karar). |

Aracı ElevenLabs'teki LLM'in seçmesi bir güvenlik açığı değildir: asistanın gördüğü veri azaltılır (§4) ve riskli her
işlem tarayıcıda deterministik bir onaydan, ardından sunucu denetiminden geçer (§2).

### 2. Risk modeli (R0–R4)
Her aracın bir seviyesi vardır. **Asıl karar sunucudadır**; istemcideki kapı yalnızca ek bir katmandır.

| Seviye | Anlamı | Onay | Örnek |
| --- | --- | --- | --- |
| R0 | Okuma, gezinme | Yok | Kampanyaları listele, Lead'ler sayfasına git |
| R1 | İç yazma, geri alınabilir | Asistan eylemi tekrar söyler; kullanıcı "evet" der ya da ekranda "Onayla"ya basar. Bekleyen eylem nonce ile tutulur, 60 sn'de düşer. | Uyarıyı kapat, lead durumunu değiştir, taslak gönder |
| R2 | Dış etki, harcama yok | **Ekranda tıklama zorunlu.** Diyalog parametreleri gösterir; ajanın bunu onaylayacak bir aracı yoktur. | PAUSED yayın, duraklatma, bütçe düşürme, arşiv, Meta inceleme eşitlemesi |
| R3 | Harcama başlatma ya da artırma | **Ekranda tıklama zorunlu.** Diyalog kampanyayı, tutarı, para birimini ve eski → yeni değeri gösterir. Sunucu ayrıca harcama yetkisini ve aylık tavanı denetler. | Etkinleştirme, bütçe artırma, bütçe artırma önerisini uygulama |
| R4 | Sesle yapılamaz | Asistan yalnızca ilgili sayfaya götürür | Aşağıdaki liste |

**R4 (sesle hiçbir zaman):**
- Onaylar: kampanya, öneri ve stüdyo taslağı için onay ve ret (ADR-0002, ADR-0014: onaylanan = yayınlanan).
- Silme ve gizlilik: lead silme, `privacy/*`.
- Meta ve platform bağlantıları: OAuth, bağlama ve bağlantıyı kesme.
- Harcama yetkisi verme, aylık tavanı gevşetme.
- Faturalama: Stripe ödeme, plan değişikliği.
- Politika kuralları, Canlıya geçiş, giriş ve çıkış.
- Hasta mesajları: `ai/chat`, `leads/[id]/messages`, `conversations/*` gönderme ve devretme. Hukuk görüşü gelirse ayrı
  kararla, yalnızca ESC rollerine ve R2 olarak açılabilir.
- Genel `capi`.

**Onay mekanizması:**
- R2 ve R3 araçları işlemi hemen yapmaz; `{ status: "awaiting_user_confirmation", pendingId }` döndürür ve diyaloğu
  açar. Tıklamada `api()` çağrılır ve sonuç `sendContextualUpdate` ile ajana bildirilir. Ret ya da süre dolarsa işlem
  iptal edilir.
- Ajanın kullanabildiği `confirm_pending_action(pendingId)` yalnızca R1 için geçerlidir. Bekleyen eylemin
  parametreleri sonradan değiştirilemez.

**Rol ve tenant:**
- Oturum açılırken yalnızca rolün (ve harcama yetkisinin) izin verdiği araçlar istemciye bağlanır. Sunucu yine de 403
  dönebilir; asistan "Bu işlem için yetkiniz yok." der ve yeniden denemez.
- Hiçbir araç `workspaceId` ya da `orgId` almaz. Kimlikler yalnızca daha önce bir okuma aracının döndürdüğü listeden
  seçilir (istemcide kısa ref → gerçek kimlik eşlemesi); asistan kimlik uyduramaz.

### 3. Asistan bir yetki sınırı değildir
ADR-0017 §2'deki menü kuralıyla aynı ilke: araç listesinden bir aracı gizlemek yalnızca kullanımı sadeleştirir. Yetki
her API ucunda ayrıca denetlenir. Bir araç yanlışlıkla açılsa da sunucu kuralları (rol, tenant, harcama yetkisi,
tavan, onay kapısı) aynı kalır.

### 4. Kişisel veri ve KVKK
- **Ne gider:** Personelin sesi, konuşmanın metni ve araç sonuçları ElevenLabs'e (ve ajanın LLM sağlayıcısına) gider.
  Personel konuşurken lead adı söyleyebilir; bu engellenemez, aydınlatma metninde yazılır.
- **Araç sonuçları temizlenir** (`_lib/assistant/sanitize.ts`): lead'ler adla değil takma adla (`leadAlias`) gösterilir;
  e-posta, telefon, mesaj içeriği ve sağlık beyanı gönderilmez. Sayılar ve durumlar gönderilir. Lead adıyla arama
  yapılmaz: "lead ara" komutu yalnızca arama kutusunu açar, metni kullanıcı yazar.
- **Veri konumu (ürün sahibi kararı):** Personel sesi ElevenLabs'te işlenir. Konum `ELEVENLABS_SERVER_LOCATION` ile
  seçilir: varsayılan ElevenLabs standardı (`us`), isteğe bağlı `eu-residency`. AB konumu Enterprise plan, ayrı hesap
  ve ayrı anahtar ister. Yapılandırma `global` ve `in-residency` (Hindistan) değerlerini de teknik olarak kabul eder;
  bunlar ürün sahibi kararının parçası değildir ve ayrı onay olmadan seçilmemelidir. Türkiye seçeneği yoktur; AB konumu da ADR-0023'teki "veri Türkiye'de" kuralını karşılamaz.
  Bu, ADR-0026'daki yurt dışına aktarım sorusuyla aynıdır ve hukuki incelemeye bağlıdır.
- **İzin ve aydınlatma:** İlk kullanımda "Sesiniz yapay zekâ tarafından ve üçüncü taraf ElevenLabs'te işlenir."
  diyaloğu çıkar; onay denetim kaydına yazılır. Mikrofon yalnızca kullanıcı düğmeye basınca açılır; uyandırma kelimesi
  yoktur.

### 5. Transkript saklama
- Panel transkript ve ses saklamaz. Denetim kaydı yalnızca `{ tool, risk, entityId, outcome, conversationId }` yazar
  (`VOICE_TOOL_CALL`, `VOICE_SESSION_STARTED`, `VOICE_CONSENT_GIVEN`). Asıl değişiklik, ilgili ucun kendi denetim
  kaydındadır.
- Asistan ajanında: `record_voice=false`, `retention_days=0` (ZRM yoksa), post-call webhook kapalı, akıl yürütme
  özeti kapalı. Sıfır saklama (ZRM) yalnızca Enterprise'ta vardır; açılırsa GPT modelleri seçilemez.

### 6. `Permissions-Policy` değişikliği (ADR-0023 §5)
- `web/next.config.ts`: `microphone=()` yerine `microphone=(self)`. Mikrofon yalnızca panelin kendi origin'ine açılır;
  çerçevelenen ya da üçüncü taraf içerik mikrofona erişemez. `camera`, `geolocation`, `payment` kapalı kalır.
- CSP'ye `connect-src` bugün eklenmedi. Eklenirse ElevenLabs hostları (`docs/elevenlabs-constraints.md`) seçilen
  konuma göre yazılmalıdır.

### 7. Ajan LLM'i — açık
ADR-0013 §2'deki "varsayılan yok" ilkesi gereği model açıkça seçilir ve buraya yazılır. **Karar ertelendi:** ElevenLabs
panelinde Türkçe komutlarla denendikten sonra seçilecek. Adaylar (ElevenLabs'in araç kullanımı önerisi): Claude
Sonnet 4.5, GPT-5.2, Gemini 2.5 Flash; Gemini 2.0 Flash önerilmiyor. ZRM gerekirse GPT elenir. Seçilene kadar eşitleme
betiği modeli zorunlu parametre olarak ister; ajanın ElevenLabs varsayılanına (`gemini-2.5-flash`) sessizce
bırakılmaz.

### 8. Ortam değişkenleri ve kapatma
- `VOICE_ASSISTANT_ENABLED` (varsayılan `false`), `ELEVENLABS_ASSISTANT_AGENT_ID` (telefon ajanından ayrı),
  `ELEVENLABS_ASSISTANT_CONNECTION` (`webrtc` | `websocket`), `ELEVENLABS_SERVER_LOCATION` (`us` | `eu-residency` |
  `in-residency` | `global`; onaylı olanlar `us` ve `eu-residency`, §4), `ASSISTANT_NAME` (yoksa `APP_NAME`; ad koda
  yazılmaz), `ELEVENLABS_ASSISTANT_VOICE_ID`.
- `ELEVENLABS_SERVER_LOCATION` yalnızca istemcinin `serverLocation` değerini belirler; `ELEVENLABS_API_BASE` aynı
  bölgeye ayrıca ayarlanır, uyuşmazlık oturum ucunda reddedilir.
- `ELEVENLABS_API_KEY` ve `ELEVENLABS_API_BASE` yeniden kullanılır ve yalnızca sunucuda kalır. `META_MOCK_MODE=true`
  iken dışarı istek gitmez.
- Acil kapatma: `VOICE_ASSISTANT_ENABLED=false` (ya da ajan kimliği boş) → oturum ve olay uçları 404, düğme görünmez.

### 9. Hız ve maliyet sınırları
- Oturum: kullanıcı başına saatte 20 (`voice:<userId>`). Olay kaydı (`/api/assistant/events`): kullanıcı başına
  dakikada 30 (`voice-event:<userId>`); yalnızca denetim kaydını sınırlar, Meta'ya giden uçları yavaşlatmaz.
- Araç çağrısı sınırı (oturum başına dakikada 30) **henüz uygulanmadı**; Faz 2'de istemcideki araç dağıtıcısında,
  gerekirse Meta'ya giden uçlarda da uygulanır. LLM kullanan araçlar mevcut `ai:<workspaceId>` kotasını kullanır.
- Ajanda: en uzun oturum (≈ 5 dk), sessizlik zaman aşımı, burst kapalı, düşük eşzamanlılık sınırı. Telefon ajanıyla
  aynı çalışma alanı eşzamanlılık havuzunu paylaşır.

## Sonuçlar
- **Faz 0–1 kapsamı:** ElevenLabs davranışının resmi kaynaklardan doğrulanması (`docs/elevenlabs-constraints.md`), bu
  karar, ortam değişkenleri, `packages/voice` oturum modülü, `/api/assistant/session` ve `/api/assistant/events` uçları,
  `Permissions-Policy` değişikliği ve bağımlılıklar (`@admedic/voice`, `@elevenlabs/react@1.16.0` sabit; kilit dosyasında
  `@elevenlabs/client@1.26.0`, kısıt notlarının doğrulandığı sürümler).
- **Olay kaydı istemci bildirimidir:** `VOICE_TOOL_CALL` satırı `after.source = "client"` taşır. Rolün hiç
  çalıştıramayacağı risk seviyesi reddedilir (R1 izleyiciye kapalı, R2 düzenleme rolleri, R3 harcama yetkisi); araç
  adının kayıtla karşılaştırılması Faz 2'de `registry.ts` ile gelir.
- **Doğrulanmayan** (ayrıntı `docs/elevenlabs-constraints.md`):
  - WebRTC token süresi; istemci aracı zaman aşımında ajanın davranışı; Türkçe dil kodu (`tr`);
  - PATCH'in `tool_ids` davranışı; AB konumunda token uçları; Enterprise dışı planda saklama ayarlarının kabulü;
  - LiveKit medya (ICE/TURN) adresleri; WebView2'de mikrofon izni penceresi (masaüstü, ADR-0025).
  - Hiçbiri gerçek bir ElevenLabs hesabıyla denenmedi.
- **Ürün sahibine kalan işler:**
  - ElevenLabs panelinde asistan ajanını oluşturmak: dil `tr`, TTS `eleven_flash_v2_5`, `enable_auth` açık,
    `agent.language` ve `conversation.text_only` geçersiz kılmaları açık, oturum süre sınırı, saklama ayarları.
  - Ajan LLM'ini panelde deneyip seçmek (§7) ve aylık dakika/maliyet sınırını belirlemek.
  - Asistanın adı ve sesi (Voice Library), İngilizce desteği, kısayol tuşu.
- **Açık sorular:**
  - KVKK: personel sesinin (lead adları dahil) yurt dışında işlenmesinin hukuki dayanağı ve aydınlatma metni. AB
    konumu yeterli değilse seçenek C'ye geçiş ayrı kararla yapılır.
  - VIEWER dahil her role gösterilsin mi (VIEWER yalnızca gezinme ve okuma görür)?
  - macOS masaüstü kapsamda mı (mikrofon izni ve entitlement)?
- **Faz 0 rol doğrulaması (sonuç):**
  - `studio/[id]` PATCH ve `experiments/[id]` PATCH rolü servis katmanında denetler (`web/app/_lib/studio-service.ts`:
    `changeDraft` onay/ret için OWNER/ADMIN, diğerleri için EDIT_ROLES; `updateExperiment` EDIT_ROLES). Değişiklik
    gerekmedi.
  - `campaign-planner` POST yalnızca oturum istiyordu; plan, kuruluşun aylık tavanından kalan payı da ortaya koyduğu
    için `requireRole(actor, EDIT_ROLES)` eklendi (menüdeki rolle aynı). `plan_campaign` aracı yalnızca EDIT rollerine
    bağlanır.
- **Bilinen açıklar (araç açılmadan önce kapatılmalı):**
  - Bir ADMIN aynı kampanyayı hem gönderip hem onaylayabiliyor. R4 kuralı bu açığı sesle genişletmez.
- **Numara:** ADR-0026 giden arama kararında kullanıldığı için (kodda referans var) bu karar 0028 olarak açıldı.
