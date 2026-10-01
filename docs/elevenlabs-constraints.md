# ElevenLabs Agents — kısıtlar ve tarihli bulgular

Bu dosya, sesli ajanla giden arama (ADR-0026) ve sesli komut asistanı (ADR-0028) entegrasyonlarının dayandığı
ElevenLabs davranışını kayda geçirir.
Kural `docs/meta-constraints.md` ile aynıdır: emin olunmayan davranış tahminle yazılmaz, resmi dokümana bakılır ve
bulgu tarihle buraya not edilir.

## 2026-10-01 — giden arama, webhook ve şartlar

Kaynak: `https://elevenlabs.io/docs` altındaki sayfalar (yollar aşağıda), 2026-10-01'de okundu.

### Tek giden arama
- **Twilio:** `POST /v1/convai/twilio/outbound-call`. Zorunlu gövde alanları: `agent_id`, `agent_phone_number_id`,
  `to_number`. İsteğe bağlı: `conversation_initiation_client_data`, `call_recording_enabled`, `telephony_call_config`.
  Yanıt: `success`, `message`, `conversation_id`, `callSid`. (`/api-reference/twilio/outbound-call`)
- **SIP trunk:** `POST /v1/convai/sip-trunk/outbound-call`. Aynı gövde (`call_recording_enabled` yok). Yanıt:
  `success`, `message`, `conversation_id`, `sip_call_id`. (`/api-reference/sip-trunk/outbound-call`)
- **Kimlik doğrulama:** `xi-api-key` başlığı. Varsayılan kök `https://api.elevenlabs.io`.
  (`/api-reference/authentication`)
- **Arama başına bağlam:** `conversation_initiation_client_data.dynamic_variables` (değerler dize, sayı ya da
  mantıksal). Ajan isteminde `{{ad}}` olarak kullanılır. `system__` ön eki ayrılmıştır.
  (`/eleven-agents/customization/personalization/dynamic-variables`)
- **Geçersiz kılmalar:** `conversation_config_override.agent.first_message`, `.agent.language`, `.agent.prompt.prompt`
  vb. **Varsayılan olarak kapalıdır**; ajanın Security sekmesinde alan alan açılır. Açık olmayan bir alan gönderilirse
  ElevenLabs hata verir. (`/eleven-agents/customization/personalization/overrides`)
  - Uygulama: panel her aramada `first_message` ve `language` gönderir. Bu ikisi açık değilse arama başlamaz; böylece
    bildirim cümlesi söylenmeden arama yapılamaz.

### Arama sonu webhook'u
- **Kurulum:** `POST /v1/workspace/webhooks` (`auth_type: "hmac"`) bir `webhook_secret` döndürür; `PATCH
  /v1/convai/settings` ile `post_call_webhook_id` ve `events` atanır. İkisi panelden de yapılabilir.
- **Olaylar:** `transcript`, `audio`, `call_initiation_failure`, `answering_machine_detection` ve maskesiz türleri.
  Panel yalnızca `transcript` ve `call_initiation_failure` olaylarını işler; `audio` olayına **abone olunmamalıdır**
  (ses kaydı base64 olarak gelir ve panel saklamaz).
- **Gövde:** `{ type, event_timestamp, data }`. `type` değerleri: `post_call_transcription`, `post_call_audio`,
  `call_initiation_failure`.
  - Transkript `data`: `conversation_id`, `status`, `transcript[]`, `metadata.call_duration_secs`,
    `metadata.termination_reason`, `analysis.call_successful` (`success | failure | unknown`),
    `analysis.transcript_summary`, `conversation_initiation_client_data`.
  - Başlatma hatası `data`: `conversation_id`, `failure_reason` (`busy | no-answer | unknown`). Sesli mesaj
    açıldığında bu olay gönderilmez.
- **Yeniden deneme:** Varsayılan olarak kapalıdır (`retry_enabled`); yalnızca `post_call_transcription` için ve yalnızca
  5xx, 429, 408 yanıtlarında, en fazla 5 kez (hemen, 30 sn, 2 dk, 8 dk, 30 dk). Yeniden gönderilen gövde aynıdır;
  işleyici idempotent olmalıdır. 7 gün içinde art arda 10 hata olursa webhook kendiliğinden kapanır.
- **Çıkış IP adresleri** (güvenlik duvarı için): ABD `34.67.146.145`, `34.59.11.47`; AB `35.204.38.71`,
  `34.147.113.54`; Asya `35.185.187.110`, `35.247.157.189`; AB veri konumu `34.77.234.246`, `34.140.184.144`.
- Kaynak: `/eleven-agents/workflows/post-call-webhooks`, `/eleven-api/resources/webhooks`,
  `/eleven-api/resources/ip-allowlisting`.

### Webhook imzası — dokümanda yazılı değil
- Başlık adı `ElevenLabs-Signature` dokümanda geçer; algoritma geçmez. Doküman yalnızca resmi SDK'nın
  `constructEvent` işlevini önerir.
- Algoritma resmi SDK kaynağından alındı (`github.com/elevenlabs/elevenlabs-js`, `src/wrapper/webhooks.ts`):
  başlık `t=<unix saniye>,v0=<hex>`; imzalanan dizgi `<t>.<ham gövde>`; HMAC-SHA256, hex; 30 dakikadan eski zaman
  damgası reddedilir.
- **Doğrulanmadı:** gerçek bir ElevenLabs teslimiyle sınanmadı. İlk canlı kurulumda bir test araması yapılıp
  webhook'un 200 döndüğü görülmelidir; 401 dönüyorsa önce bu bölüm yeniden denetlenir.

### Telefon numarası ve sınırlar
- Numara `POST /v1/convai/phone-numbers` ile aktarılır (Twilio: `sid`, `token`; SIP: `outbound_trunk_config`).
  Dönen `phone_number_id`, aramada `agent_phone_number_id` olarak kullanılır. Twilio'da doğrulanmış arayan kimliği
  yalnızca giden aramada çalışır.
- Eşzamanlı arama sınırı plana bağlıdır (fiyat sayfası: Free 4, Starter 6, Creator 10, Pro 20, Scale 30, Business 40).
  Sınır aşılınca 429 (`concurrent_limit_exceeded`). Giden aramada kuyruk yoktur.
- Panelin kendi sınırları daha dardır: aynı anda en fazla 3 otomatik arama, günde 50 (`packages/voice/src/service.ts`).

### Diller
- Türkçe, İngilizce, Almanca, Rusça, Arapça, Fransızca, Felemenkçe ve Lehçe desteklenen diller arasındadır
  (`/eleven-agents/customization/voice/customization/language`).
- **Doğrulanmadı:** `agent.language` için bu dillerin kodları (`tr`, `de`, `ru`, `ar`, `nl`, `pl`). Dokümanda yalnızca
  `en`, `fr`, `es` örneği var; iki harfli ISO 639-1 kodu varsayıldı. Ajanın "ek diller" listesine bu diller
  eklenmelidir; eklenmemiş dilde geçersiz kılma reddedilebilir.

### Şartlar ve uyum — ürün sahibi kararı gerektirir
Kaynak: `https://elevenlabs.io/agents-terms`, `/eleven-agents/legal/disclosure-requirement`,
`/eleven-agents/legal/hipaa`, `/overview/administration/data-residency`.

- **Sağlık verisi:** Sağlık bilgisi, ElevenLabs yazılı olarak kabul etmedikçe "yasak veri"dir. Sağlık verisi için
  anlaşma (BAA) yalnızca Enterprise planda ve "zero retention" kipiyle verilir.
  - Uygulama: panel ajana yalnızca **ad, dil, klinik adı ve arama kimliği** gönderir; ilgilenilen hizmet ve konuşma
    içeriği gönderilmez. Ancak görüşmenin kendisinde hasta sağlık bilgisi söyleyebilir. **Yazılı anlaşma olmadan
    canlı arama yapılmamalıdır.**
- **Rıza:** Giden aramada yasal olarak gereken rızayı müşteri alır ve yazılı kanıtını saklar.
  - Uygulama: `ConsentType.PHONE_CALL` kaydı olmadan arama başlamaz; kayıt kanıtıyla (nasıl, ne zaman) tutulur.
- **Bildirim:** Karşı tarafa yapay zekâ ile konuştuğu ve görüşmenin kaydedilip ElevenLabs ve LLM sağlayıcılarıyla
  paylaşılabileceği söylenmelidir.
  - Uygulama: açılış cümlesi her aramada panelden gönderilir (`packages/voice/src/disclosure.ts`). Aydınlatma metni
    de bu aktarımı kapsamalıdır (hukuki inceleme).
- **Veri konumu:** AB veri konumu (`https://api.eu.residency.elevenlabs.io`) yalnızca Enterprise planda, ayrı çalışma
  alanı ve ayrı anahtarla. Türkiye'de veri konumu seçeneği yok. Bu, ADR-0023'teki "veri Türkiye'de" kararıyla
  çelişir; arama sırasında ses ve transkript yurt dışında işlenir (KVKK md. 9, yurt dışına aktarım).
- **Saklama:** Ajan ayarında `retention_days`, `delete_transcript_and_pii`, `delete_audio`. Varsayılan saklama süresi
  kaynaklarda çelişkili (kılavuz 2 yıl, API şeması süresiz); ajan ayarında açıkça kısaltılmalıdır.
- **Arama saatleri:** ABD için kılavuz 08:00–21:00 (alıcının yerel saati) der. Türkiye ve AB ülkeleri için ElevenLabs
  dokümanında kural yok; panel 09:00–20:00 uygular. Ülke bazlı kurallar hukuki incelemeyle doğrulanmalıdır.
- **Yaptırımlar:** Rusya ve Belarus'tan erişim engellidir. Panel `+7` numaralarını aramaz (saat dilimi tablosunda yok).

### Doğrulanamayanlar
- İmza algoritması (yukarıda), `answering_machine_detection` olayının gövdesi, `metadata.termination_reason`
  değerlerinin listesi, giden arama uçlarının istek hızı sınırı, Türkiye'ye özgü herhangi bir rehber.
- Bu entegrasyonun tamamı gerçek bir ElevenLabs hesabıyla **denenmedi**; yalnızca deneme modu ve birim testleri.

## 2026-10-01 — Sesli komut asistanı: tarayıcıdan bağlantı ve istemci araçları (ADR-0028)

Kaynaklar (hepsi 2026-10-01'de okundu):
- Resmi OpenAPI şeması: `https://api.elevenlabs.io/openapi.json`. Şema indirildi, alanlar doğrudan okundu.
- Resmi SDK kaynağı: npm `@elevenlabs/react@1.16.0` ve bağımlılığı `@elevenlabs/client@1.26.0`. Paket arşivi indirildi;
  `dist/utils/location.js`, `dist/utils/WebRTCConnection.js` ve `dist/platform/web/createWorkletModuleLoader.js`
  okundu.
- `https://elevenlabs.io/docs` altındaki sayfalar (yollar her maddede).

### Oturum kimliği: WebRTC token ve imzalı URL
- **WebRTC:** `GET /v1/convai/conversation/token?agent_id=…`, `xi-api-key` ile, yalnızca sunucuda. Yanıt
  `{ token, conversation_id }` (`TokenResponseModel`). İsteğe bağlı sorgu: `participant_name`, `branch_id`,
  `version_id`, `environment`. İstemci bu değeri `conversationToken` olarak verir.
  (`/api-reference/conversations/get-webrtc-token`)
- **WebSocket:** `GET /v1/convai/conversation/get-signed-url?agent_id=…`. Yanıt `{ signed_url }`;
  `include_conversation_id` isteğe bağlı. İstemci bu değeri `signedUrl` olarak verir.
  (`/api-reference/conversations/get-signed-url`)
- **İmzalı URL süresi:** "Signed URLs are valid for 15 minutes." Konuşma bu pencere içinde başlamalıdır. Süre dolunca
  açık bağlantı kapanmaz, yalnızca aynı URL ile yeni bağlantı kurulamaz. (`/eleven-agents/customization/authentication`)
- ❗ **DOĞRULANMADI: WebRTC token süresi.** Ne doküman ne `TokenResponseModel` bir süre bildirir. Şemadaki başka bir
  model (`ConversationTokenResponseModel`) `expiration_time_unix_secs` alanı taşır, ama bu uçla ilişkisi yazılmamış.
  Uygulama token'ı oturum açılırken alır ve hemen kullanır; saklamaz, yeniden kullanmaz. Süre ilk canlı denemede
  ölçülmelidir.
- **SDK davranışı** (`WebRTCConnection.create`): `conversationToken` verilirse doğrudan LiveKit odasına bağlanır.
  Yalnızca `agentId` verilirse token'ı tarayıcıdan, anahtarsız ister. `enable_auth` açık ajanda bu istek 401 alır
  (SDK iletisi: "Your agent has authentication enabled, but no signed URL or conversation token was provided.").

### `enable_auth` ve izinli host listesi
- `platform_settings.auth.enable_auth` (varsayılan `false`): açıkken konuşma başlatmak imzalı token ister.
- `platform_settings.auth.allowlist`: konuşma başlatabilecek hostlar. Eşleşme tamdır; alt alan adları ayrı eklenir.
  `require_origin_header` (varsayılan `false`) yalnızca liste doluysa etkilidir. (OpenAPI `AuthSettings`)
- Doküman açıkça: "Do not configure signed URLs and allowlists together on the same agent."
  (`/eleven-agents/customization/authentication`)
  - Uygulama: asistan ajanında yalnızca `enable_auth=true`; allowlist boş kalır.

### İstemci araçları (client tools)
- **Ad eşleşmesi:** "The tool and parameter names in the agent configuration are case-sensitive and **must** match
  those registered in your code." (`/eleven-agents/customization/tools/client-tools`)
- **Şema alanları** (OpenAPI `ClientToolConfig`):
  - `type: "client"`, `name`, `description`, `parameters` (JSON şeması).
  - `expects_response` (varsayılan `false`): `true` ise konuşma istemci yanıt verene kadar bekler ve yanıt LLM'e
    gider. Paneldeki adı "Wait for response". Sonuç döndüren her araçta `true` olmalıdır.
  - `response_timeout_secs`: varsayılan **20**, aralık **1–120** sn (uçlar dahil).
  - `interruption_mode`: `allow` (varsayılan), `disable_during_tool`, `disable_during_tool_and_turn`.
    `disable_interruptions` kullanım dışı.
  - `pre_tool_speech`: `auto` (varsayılan), `force`, `off`. `force_pre_tool_speech` kullanım dışı.
  - `execution_mode`: `immediate` (varsayılan), `post_tool_speech`, `async`.
  - `tool_error_handling_mode`: `auto`, `summarized`, `passthrough`, `hide`.
- ❗ **DOĞRULANMADI:** zaman aşımında ajanın LLM'e ne ilettiği; doküman yazmıyor.
  - Uygulama: ekranda onay bekleyen R2/R3 araçları beklemez. Hemen `awaiting_user_confirmation` döner, sonuç
    `sendContextualUpdate` ile sonradan iletilir.
- **React SDK:** araçlar `clientTools` nesnesiyle bağlanır (ad → `async (params) => sonuç`); dönen değer ajana
  iletilir. `sendContextualUpdate` ajanı yanıt vermeye zorlamadan bilgi verir; `sendUserMessage` metinle bir kullanıcı
  turu açar. `textOnly` ve `serverLocation` seçenekleri vardır. (`/eleven-agents/libraries/react`)

### Ajan yapılandırmasını koddan eşitleme (PATCH)
- `PATCH /v1/convai/agents/{agent_id}` kısmi güncellemedir. Gövde: `conversation_config`, `platform_settings`,
  `workflow`, `name`, `tags`, `version_description`. Yanıt güncel ajan yapılandırmasıdır.
  (OpenAPI; `/api-reference/agents/update`)
- **Araçlar ayrı bir kaynaktır.** `conversation_config.agent.prompt.tools` şemada "use tool_ids instead" notuyla
  kullanım dışıdır.
  - Araç oluşturma `POST /v1/convai/tools`, güncelleme `PATCH /v1/convai/tools/{tool_id}` (`tool_config`).
  - Ajana bağlama `prompt.tool_ids` ile. `GET /v1/convai/tools/{tool_id}/dependent-agents` aracı kullanan ajanları
    listeler.
  - Uygulama: `web/scripts/elevenlabs-sync-agent.ts` iki adımda çalışır. Önce araçları ada göre eşler, oluşturur ya da
    günceller; sonra ajanı `tool_ids` ve prompt ile PATCH'ler.
- Prompt alanları: `prompt.prompt`, `prompt.llm` (varsayılan `gemini-2.5-flash`; şema notu: "If using data residency,
  the LLM must be supported in the data residency environment"), `prompt.temperature` (varsayılan 0).
- ❗ **DOĞRULANMADI (canlı):** PATCH'in `tool_ids` listesini birleştirmek yerine değiştirdiği; sürümlü ajanda
  (`enable_versioning_if_not_enabled`, `branch_id`) davranışı. İlk eşitlemede ajan `GET` ile geri okunup
  karşılaştırılmalıdır.

### Geçersiz kılmalar (overrides)
- "Overrides are disabled by default." Her alan Security sekmesinde ayrı açılır. API karşılığı:
  `platform_settings.overrides.conversation_config_override.*`, hepsi varsayılan `false`. Açık olmayan alan
  gönderilirse hata döner; ASR anahtar kelimeleri istisnadır, yok sayılır.
  (`/eleven-agents/customization/personalization/overrides`)
- Açılabilen alanlar (şema): `agent.first_message`, `agent.language`, `agent.prompt.*`,
  `agent.max_conversation_duration_message`; `tts.voice_id`, `tts.model_id`, `tts.speed`, `tts.stability`,
  `tts.similarity_boost`; `conversation.text_only`, `conversation.max_duration_seconds`; `asr.*`, `turn.*`.
- Asistan için açılacaklar: `agent.language` (tr/en), `conversation.text_only` (mikrofon yoksa metin kipi) ve isteğe
  bağlı `tts.voice_id` (`ELEVENLABS_ASSISTANT_VOICE_ID`).
  - **Prompt geçersiz kılması açılmaz.** Prompt yalnızca eşitleme betiğinden gelir; istemci promptu değiştiremez.

### Türkçe model desteği
- **TTS:** `eleven_flash_v2_5` Türkçe dahil 32 dil; `eleven_flash_v2` yalnızca İngilizce. Ajan dokümanı: "Additional
  languages switch the agent to use the v2.5 Multilingual model. English will always use the v2 model."
  (`/overview/models`, `/eleven-agents/customization/voice/customization/language`)
- **Ajan TTS model listesi** (şema `TTSConversationalModel`): `eleven_turbo_v2`, `eleven_turbo_v2_5`,
  `eleven_flash_v2`, `eleven_flash_v2_5`, `eleven_multilingual_v2`, `eleven_v3_conversational`, `eleven_v4`,
  `eleven_v4_turbo`. `eleven_turbo_v2_5` dokümanda kullanım dışı (yerine Flash v2.5).
  - Varsayılan `eleven_flash_v2` olduğu için Türkçe ajanda `eleven_flash_v2_5` açıkça seçilmelidir.
- **ASR:** Scribe v2 ve Scribe v2 Realtime 90+ dil, Türkçe dahil (`/overview/models`). Ajan şemasında ASR sağlayıcısı
  `scribe_realtime` (varsayılan) ya da `elevenlabs`; model adı (`scribe_v2`) ajan şemasında ayrıca seçilmez.
- ❗ **DOĞRULANMADI:** ajan `language` alanında Türkçe kodunun `tr` olduğu. Alan serbest dizedir; dokümanda yalnızca
  `en` ve `fr` örneği var. Giden arama bölümündeki dil kodu notuyla aynı durum.

### Tarayıcının bağlandığı hostlar (CSP `connect-src` eklenirse)
SDK kaynağından (`@elevenlabs/client@1.26.0`, `dist/utils/location.js`), `serverLocation` → host:

| `serverLocation` | API ve WebSocket | WebRTC (LiveKit sinyali) |
| --- | --- | --- |
| `us` (varsayılan), `global` | `wss://api.elevenlabs.io` (ve `https://`) | `wss://livekit.rtc.elevenlabs.io` |
| `eu-residency` | `wss://api.eu.residency.elevenlabs.io` | `wss://livekit.rtc.eu.residency.elevenlabs.io` |
| `in-residency` | `wss://api.in.residency.elevenlabs.io` | `wss://livekit.rtc.in.residency.elevenlabs.io` |

- Tanınmayan değer uyarıyla `us`'e düşer. React SDK (`ConversationProvider`) `serverLocation`'dan hem `origin`'i hem
  `livekitUrl`'i türetir. SDK'da Singapur yok; dokümanda `api.sg.residency.elevenlabs.io` var.
- Bugünkü panel CSP'sinde `connect-src` yok (ADR-0023 §5); bu turda ek gerekmez. Eklenirse seçilen konumun iki hostu
  (ve `https://` karşılıkları) yazılmalıdır.
- AudioWorklet modülleri varsayılan olarak `blob:` URL'den yüklenir (Safari iframe'de `data:`). Sıkı bir `script-src`
  ya da `worker-src` eklenirse ya `blob:` izni ya da SDK'nın `workletPaths` seçeneğiyle kendi sunucumuzdan verilen
  dosyalar gerekir.
- ❗ **DOĞRULANMADI:** LiveKit'in ICE/TURN medya adresleri. Medya akışı `connect-src` kapsamında değildir; kurumsal
  güvenlik duvarında UDP/TURN gereksinimi ilk canlı denemede görülmelidir.

### Veri konumu (data residency)
- Bölgeler: varsayılan ABD; AB (`api.eu.residency.elevenlabs.io`), Hindistan (`api.in…`), Singapur (`api.sg…`).
  "Data residency is an Enterprise feature." Ayrı ortamda ayrı hesap, boş çalışma alanı ve ayrı API anahtarı gerekir.
  "Different regions have different LLMs available." (`/overview/administration/data-residency`)
- Uygulama: `ELEVENLABS_SERVER_LOCATION` yalnızca istemcinin `serverLocation` değerini belirler. Sunucunun token
  istediği API kökü her zaman `ELEVENLABS_API_BASE`'tir (varsayılan `https://api.elevenlabs.io`) ve aynı bölgeye ayrıca
  ayarlanmalıdır (ör. `eu-residency` için `https://api.eu.residency.elevenlabs.io`). İkisi uyuşmazsa oturum ucu
  CONFLICT ile reddeder: AB ortamı ayrı hesap olduğu için AB ajanına ABD kökünden token alınamaz.
- ❗ **DOĞRULANMADI (canlı):** AB ortamında token uçlarının aynı yolla çalıştığı.
- Türkiye seçeneği yoktur (giden arama bölümüyle aynı). Personel sesi her durumda yurt dışında işlenir.

### Saklama ve sıfır saklama (ZRM)
- Ajan ayarı `platform_settings.privacy` (OpenAPI `PrivacyConfig`): `record_voice` (varsayılan `true`),
  `retention_days` (varsayılan `-1` = süresiz), `delete_transcript_and_pii`, `delete_audio`,
  `apply_to_existing_conversations`, `zero_retention_mode` (varsayılan `false`), `conversation_history_redaction`.
- Retention sayfası: varsayılan 2 yıl; `-1` süresiz, `0` planlı silme ya da gün sayısı; transkript ve ses için ayrı.
  (`/eleven-agents/customization/privacy/retention`) Şema varsayılanıyla (`-1`) çelişki sürüyor; değer açıkça
  ayarlanmalıdır.
- **ZRM (ajan başına):** "No call recordings will be stored. No transcripts or call metadata containing PII will be
  logged or stored by our systems post-call." Bilgi yalnızca post-call webhook ile alınabilir; hata ayıklama
  kısıtlanır. Çalışma alanında genel ZRM zorunluysa ajan bazında kapatılamaz.
  (`/eleven-agents/customization/privacy/zrm`)
- **ZRM planı:** "Enterprise customers can use Zero Retention Mode." Agents kapsamdadır, ancak "UI traffic remains
  non-ZRM". ZRM ile kullanılabilen LLM'ler: "Gemini, Claude, and ElevenLabs-hosted Qwen LLMs". **GPT modelleri listede
  yok.** (`/eleven-api/resources/zero-retention-mode`)
- **Asistan için hedef ayar:** `record_voice=false`, ZRM yoksa `retention_days=0`, post-call webhook kapalı,
  `enable_reasoning_summary=false` (şema: "Not ZRM compatible").
- ❗ **DOĞRULANMADI:** Enterprise olmayan planda `record_voice=false` ve `retention_days=0` değerlerinin kabul edildiği.

### Ücret ve eşzamanlılık
- `https://elevenlabs.io/pricing/agents`:
  - Ek dakika **$0.08**. Eşzamanlılık sınırı aşılınca burst (sınırın en fazla 3 katı) **çift ücretle** ($0.16/dk).
  - "LLM usage is billed separately on top, based on the model you choose."
  - Eşzamanlılık: Free 4, Starter 6, Creator 10, Pro 20, Scale 30, Business 40, Enterprise özel. Metin mesajı $0.003.
  - `https://elevenlabs.io/pricing/api` sayfasının okunan tablosunda dakika ve eşzamanlılık sütunları bir plan kaymış
    göründü. Ödemeden önce paneldeki abonelik sayfasından teyit edilmelidir.
- **"v4" iddiası:** `eleven_v4` ve `eleven_v4_turbo` ajan TTS modeli olarak şemada var. Fiyat sayfası v4 için Creator ve
  üstü planlarda geçici bir kredi kampanyası anıyor. ❗ **DOĞRULANMADI:** ajanlarda v4'ün dakika ücretini değiştirip
  değiştirmediği. Asistan v4 kullanmaz (Flash v2.5).
- **Ajan sınırları** (`AgentCallLimits`): `agent_concurrency_limit` (varsayılan `-1` = sınırsız), `daily_limit`
  (varsayılan 100.000), `bursting_enabled` (varsayılan `true`).
- **Süre:** `conversation.max_duration_seconds` (varsayılan 600); sessizlikte kapatma
  `turn.silence_end_call_timeout` (varsayılan `-1` = kapalı); `turn.turn_timeout` 7 sn.
  - Uygulama (maliyet tavanı): asistan ajanında `bursting_enabled=false`, düşük bir `agent_concurrency_limit`,
    `max_duration_seconds` ≈ 300 ve bir sessizlik zaman aşımı ayarlanır.
- Fiyat sayfası eşzamanlılık sınırını çalışma alanı düzeyinde tanımlar: telefon ajanı ile asistan aynı havuzu
  paylaşır.

### LLM seçimi (bilgi; karar ADR-0028'de açık)
- Şemadaki `LLM` listesinde ör. `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `gpt-5.2`,
  `gemini-2.5-flash` var.
- Dokümanın araç kullanımı önerisi: "GPT 5.2, Gemini-2.5-Flash, or Claude Sonnet 4.5", "avoiding Gemini-2.0-Flash";
  karmaşık araç zinciri için Claude Sonnet 4/4.5. (`/eleven-agents/customization/llm`)
- ZRM gerekiyorsa GPT seçilemez (yukarıda). Ek LLM maliyeti panelde "Detailed costs" düğmesiyle görülür.

### Doğrulanamayanlar
- WebRTC token süresi; istemci aracı zaman aşımında ajanın davranışı; Türkçe dil kodu; PATCH'in `tool_ids` davranışı;
  AB ortamında token uçları; Enterprise dışı planda saklama ayarlarının kabulü; LiveKit ICE/TURN adresleri; v4 ücreti.
- Hiçbiri gerçek bir ElevenLabs hesabıyla denenmedi.
