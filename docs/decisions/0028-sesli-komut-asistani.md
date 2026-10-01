# 0028 — Sesli komut asistanı (ElevenLabs Agents, tarayıcıda istemci araçları)

- Tarih: 2026-10-01
- Durum: Kabul edildi — Faz 0–5 uygulandı (ürün sahibi onayı: 2026-10-01 — R0–R4 risk modeli plandaki gibi;
  personel sesi ElevenLabs'te işlenir, veri konumu `ELEVENLABS_SERVER_LOCATION` ile seçilir; ajan LLM'i panelde
  denendikten sonra seçilir).
  Uygulama: Faz 0–1 (doğrulama, karar, sunucu altyapısı), Faz 2 (R0 okuma ve gezinme araçları, düğme), Faz 3 (R1 iç
  yazma araçları ve sözlü onay; aşağıda "Faz 3"), Faz 4 (R2/R3 araçları ve yalnızca ekranda onay; aşağıda "Faz 4"),
  Faz 5 (masaüstü mikrofon izni, oturum ve maliyet sınırları, A/B ölçüm araçları; aşağıda "Faz 5"). Canlı
  ElevenLabs, e2e ve masaüstü elle denemeleri insan tarafından yapılacak (aşağıda "Faz 5 — insanın denemesi gerekenler").
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
| R1 | İç yazma, geri alınabilir | Asistan eylemi tekrar söyler; kullanıcı "evet" der ya da ekranda "Onayla"ya basar. Bekleyen eylem nonce ile tutulur, 60 sn'de düşer. | Uyarıyı kapat, taslak gönder (lead durumu Faz 4'te R2'ye taşındı) |
| R2 | Dış etki, harcama yok | **Ekranda tıklama zorunlu.** Diyalog parametreleri gösterir; ajanın bunu onaylayacak bir aracı yoktur. | PAUSED yayın, duraklatma, bütçe düşürme, arşiv, Meta inceleme eşitlemesi, lead durumu (CAPI; Faz 4) |
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
- R2 ve R3 araçları işlemi hemen yapmaz; `{ status: "awaiting_screen_confirmation", pendingId }` döndürür ve diyaloğu
  açar (Faz 4'te kesinleşen ad). Tıklamada `api()` çağrılır ve sonuç `sendContextualUpdate` ile ajana bildirilir. Ret ya da süre dolarsa işlem
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
- Faz 5'te uygulananlar (kuruluş başına günlük oturum sınırı, aylık dakika bütçesi, en uzun oturum ve oturum sonu
  kaydı): aşağıda "Faz 5 — oturum ve maliyet sınırları".

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
- **Açık sorular** (güncel liste "Faz 4 → Açık sorular" altında):
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

## Faz 3 — R1 iç yazma ve sözlü onay (2026-10-01)

### Bekleyen eylem modeli
- R1 aracı işlemi yapmaz. Parametreleri doğrular, gerekirse okuma yapar ve bir bekleyen eylem yazar
  (`web/app/_lib/assistant/pending.ts`). Ajana `{ status: "awaiting_confirmation", pendingId, summary, question,
  expiresInSeconds, next }` döner. Bekleyen eylemin oluşması denetim kaydına yazılmaz.
- `pendingId` = `p_` + 128 bit kriptografik rastgele değer. Parametreler oluşturma anında kopyalanır, derin dondurulur ve
  parmak izi alınır; onayda parmak izi uyuşmazsa çalışmaz. Kimlik çalıştırmadan önce tüketilir: tekrar oynatma ve
  eşzamanlı ikinci onay reddedilir.
- Aynı anda tek bir bekleyen eylem vardır; yenisi eskisini iptal eder (sonuçta `previousPendingCancelled`). Süre 60 sn.
  Oturum kapanınca (`runtime.dispose()`) bekleyen eylem iptal edilir.
- Özet (`assistant.action.*`, `web/app/_lib/i18n.ts`) kişisel veri içermez; kayıtlar kısa ref ile anılır.

### Onay kuralları
- **Ajan yolu:** `confirm_pending_action(pendingId)` yalnızca R1 onaylar. R2/R3 (Faz 4) gelse de ajan yolu
  `not_confirmable` alır; yalnızca ekrandaki tıklama (`source: "ui"`) onaylar.
- **Kullanıcı turu (istemcide zorunlu):** ajan yolu onayı, bekleyen eylem oluştuktan **sonra** gelen bir kullanıcı
  turu (sesli döküm ya da yazılan ileti; `runtime.noteUserTurn`) açık bir onaysa (`isAffirmativeReply`: en az bir onay
  sözcüğü, hiç ret sözcüğü yok) geçer. Aksi hâlde `no_user_reply` (denetimde `denied`); eylem beklemeye devam eder.
  Böylece kiracının yazdığı serbest metinle (kampanya adı, uyarı başlığı) enjekte edilen bir talimat, kullanıcı
  konuşmadan aynı turda R1 oluşturup onaylayamaz.
- **Ekran yolu:** onay kartı aynı depoyu kullanır (`runtime.pending.confirm/cancel`, `onPendingChange`). Sonuç ajana
  `sendContextualUpdate` ile bildirilir; onaylanınca aracın temizlenmiş sonucu (sesli onayda dönenle aynı JSON: yeni
  ref'ler, üretilen metin varyantları) iletiye eklenir. Düğmeler kartın gösterdiği `pendingId` ile çağırır (eylem bu
  arada değiştiyse tıklama yok sayılır); her yeni ya da değişen eylemde "Onayla" 1 sn etkin olmaz. Odak yalnızca
  gövdeden ya da asistanın içinden **kart kabına** taşınır ("Onayla"ya değil); sayfadaki başka öğeden ve yazma
  alanından çalınmaz. Kart odaktayken eylem değişirse yeni özet duyurulur.
- **Prompt (v2, `packages/voice/agent/assistant.prompt.tr.md`):** ajan özeti aynen okur ve "Onaylıyor musunuz?" diye
  sorar. `confirm_pending_action` yalnızca hemen sonraki turda açık ve tek anlamlı bir evetten ("evet",
  "onaylıyorum", "tamam, yap") sonra çağrılır; başka her yanıtta `cancel_pending_action`. Ajan kullanıcı adına onay
  vermez; birden çok değişiklik ayrı ayrı onaylanır. "Bu kampanya/bu lead" için `get_current_context`.
- Prompt bir güvenlik sınırı değildir: ajan kuralı çiğneyip onay çağırsa bile işlem yalnızca R1'dir, tek seferliktir,
  parametreleri dondurulmuştur ve sunucu rolü, tenant'ı ve iş kurallarını yeniden denetler.

### Araçlar (planın §3 tablosundan sapmalar)
- `reject_or_requeue_recommendation` → `submit_recommendation_for_review` (yalnızca DRAFT → PENDING). Öneri **ret**i
  §2'de R4'tür (onay ve ret), araç olmaz.
- `update_lead_status`: kayıp nedeni serbest metin değil, `LOST_REASONS` listesinden seçilir (sağlık verisi ajana ya
  da araca yazılmaz). NEW'e dönülmez.
- `create_campaign_draft`: parametre `title` (kayıt testi "name" içeren parametreyi yasaklar) ve zorunlu
  `dailyBudget` (sunucu varsayılanına düşülmez); kampanya duraklatılmış taslaktır.
- `submit_studio_draft`: hazırlarken taslağın sürümü okunup dondurulur; `acknowledgeWarning` gönderilmez. Orta risk
  uyarısı 422 `policy_warning` döner ve kullanıcı ekrandan gönderir.
- `generate_ad_copy`: üretilen tam içerik yalnızca tarayıcı belleğinde kalır; ajana varyant metni ve politika riski
  gider. `confirm_pending_action` zaman aşımı 75 sn (üretim en çok 60 sn; ElevenLabs aralığı 1–120,
  `docs/elevenlabs-constraints.md`). Eşitleme betiği aralık dışını göndermeden reddeder.
- Yeni R0 araçları: `get_current_context` (açık sayfadaki kaydın yalnızca ref'i; rolün menüsündeki kayıt türleri),
  `confirm_pending_action`, `cancel_pending_action`.
- ANALYST'e R1 aracı bağlanmaz (uyarıları görür ama sunucu her değişikliği reddeder).

### Sonuçlar ve olay kaydı
- Yeni `outcome` değeri yok. Onaylanan R1: `ok` / `denied` / `error`. İptal, süre dolumu ve yerine yenisinin gelmesi:
  R1 aracı adına `cancelled`. Reddedilen onay `confirm_pending_action` adına: risk R1 değilse ya da kullanıcı turu yoksa
  `denied`, diğerleri `error`.
- 400/409/422 hataları ajana `Bu işlem şu an uygulanamıyor: <kod>` olarak gider; kod sunucu iletisinden sabit bir
  listeyle seçilir (`policy_warning`, `monthly_cap`, `invalid_transition`, `already_done` …), sunucu metni aktarılmaz.
- `/api/assistant/events`: bilinmeyen araç adı ya da kayıttakinden farklı risk 400 döner (Faz 1'de ertelenen
  kayıt karşılaştırması). Bu nedenle R2/R3 olayları Faz 4 araçları kayda girene kadar yazılamaz.

### Bilinen sınırlar (Faz 3)
- **Onay kartı arayüzü** (`voice-assistant/index.tsx`) henüz `onPendingChange`'e bağlı değil; ekran onayı ve sonucun
  `sendContextualUpdate` ile bildirilmesi, oturum kapanınca `dispose()` sonraki adımda.
- **Lead durumu Meta'ya gider:** durum değişikliği, rıza denetiminden geçerse `sendLeadStatusConversion` ile Meta
  CAPI dönüşümü gönderir. Bu bir dış etkidir. Faz 4'te `update_lead_status` R2'ye taşındı (aşağıda "Faz 4").
- İzleyicinin (VIEWER) yetkisiz R1 denemesi denetim kaydına düşmez: olay ucu R1 olayını izleyici için 403 ile
  reddeder (Faz 1'den beri aynı).
- İstemci aracı zaman aşımında ajanın LLM'e ne ilettiği hâlâ belgelenmemiş (2026-10-01'de istemci araçları sayfası
  yeniden okundu). Zaman aşımından sonra onaylanan işlem tamamlanmış olabilir; ajan "yapılmadı" dememeli, sayfayı
  açmayı önermelidir.
- Prompt ve yeni araçlar ElevenLabs ajanına henüz eşitlenmedi (`assistant:sync-agent -- --llm <model>`); e2e
  (`web/e2e/assistant.pw.ts`) yapılandırılmış bir sunucuya karşı çalıştırılmadı. Göç yok.

## Faz 4 — R2/R3 araçları ve yalnızca ekranda onay (2026-10-01)

### Araçlar
- **R2 (dış etki, harcama yok):** `publish_campaign_paused`, `pause_campaign`, `archive_campaign`, `decrease_budget`,
  `sync_meta_review`, `update_lead_status`.
- **R3 (harcama başlatır ya da artırır):** `activate_campaign`, `increase_budget`, `apply_recommendation`.
- Hepsi `screenOnly: true` (`registry.ts`) ve mevcut uçları kullanır: yayın, duraklatma, arşiv ve etkinleştirme
  `POST /api/campaigns/:id/publish {action}`; bütçe `PATCH /api/campaigns/:id/budget`; öneri
  `POST /api/recommendations/:id/apply`; inceleme `POST /api/meta/review-sync`. Yeni sunucu ucu, yeni yetki yolu ve
  göç yok (`web/app/_lib/assistant/tools/screen-actions.ts`).
- `prepare()` kaydı taze okur ve sunucunun ön koşullarını tekrarlar (APPROVED, ACTIVE, PUBLISHED_PAUSED …); bu yalnızca
  erken ve anlaşılır hata içindir. Bütçe ucu "yön" almaz (yeni > mevcut = artış); bu yüzden iki ayrı araç vardır ve
  ters yön `prepare()`'de reddedilir. `execute()` bütçeyi ve öneriyi yeniden okur; pencere gösterildikten sonra
  değiştiyse yazmaz (`changed_meanwhile`).
- `apply_recommendation` her öneri türünde R3'tür (sesle uygulama harcama yetkisi ister); harcama uyarısı yalnızca
  artışta gösterilir. Hedef kampanya önerinin `action.campaignId` alanından gelir; yoksa araç Öneriler sayfasını önerir.
- Yayın `IN_PROGRESS` dönerse araç bunu bildirir ve kampanyanın Yükleme sekmesini önerir; yayını kendisi sürdürmez ve
  yeniden denemez.

### Yalnızca ekranda onay
- R2/R3 aracı bir bekleyen eylem oluşturur ve ajana `{ status: "awaiting_screen_confirmation", pendingId, summary,
  expiresInSeconds, next, instruction }` döner. `pendingId` ajana yalnızca `cancel_pending_action` için verilir.
- Bekleyen eylem `PendingView.confirmation` taşır (başlık, kampanya adı, eski → yeni alanlar, risk etiketi, R3'te
  harcama uyarısı). Tutarlar minor unit'ten biçimlendirilir. Görünümü olmayan R2/R3 bekleyen eylem depoya yazılmaz.
- **Tek çalıştırma yolu** `runtime.pending.confirmOnScreen(pendingId)`'dir (depoda `source: "ui"`) ve yalnızca modal
  onay penceresindeki gerçek tıklamadan çağrılır. `confirm_pending_action` (ajan), sesli "evet" ve R1 onay kartı
  (`source: "card"`) R2/R3 için `not_confirmable` alır ve hiçbir şey yazmaz.
- Pencere odakla **Vazgeç**'te açılır; "Onayla" en az 1 sn sonra etkinleşir. Böylece klavye odağı çalınarak ya da
  basılı Enter ile onay verilemez. Pencere arayüzü sonraki adımda bağlanır (aşağıda "Bilinen sınırlar").
- **Süre risk başına:** `PENDING_TTL_BY_RISK = { R1: 60 sn, R2: 120 sn, R3: 120 sn }`. Ekrandaki parametreleri okumak
  sesli onaydan uzun sürer.
- **Prompt (v3):** ajan özeti aynen okur, R3'te tutarı ve işlemin harcamayı başlattığını ya da artırdığını söyler,
  ardından "Ekrandaki onay penceresinden onaylayabilirsiniz; bu işlem sesle onaylanamaz." der. Bu araçlar için
  `confirm_pending_action`'ı hiçbir koşulda çağırmaz; kullanıcıyı onaylamaya yönlendirmez ve acele ettirmez; sonucu
  yalnızca bağlam iletisi başarılı derse bildirir. R4 listesi değişmedi: yalnızca gezinme. Prompt yine bir güvenlik
  sınırı değildir; kural istemcide ve sunucuda ayrıca uygulanır.

### `update_lead_status` → R2
- Lead aşaması değişikliği, rıza denetiminden geçerse `sendLeadStatusConversion` ile Meta CAPI dönüşümü gönderir. Bu
  geri alınamayan bir dış etkidir ve §2'deki R2 tanımına uyar. Ana oturum bu nedenle aracı R2'ye taşıdı.
- Hasta koordinatörü bu aracı kaybetmesin diye R2 rol sınırı (`riskAllowedFor`) düzenleme rolleri +
  PATIENT_COORDINATOR olarak genişletildi. Kampanya araçlarını aracın kendi rol listesi (`EDIT`) yine kapatır;
  koordinatöre yalnızca `update_lead_status` bağlanır.
- **Geri alınabilir karar:** ürün sahibi sesli onayı yeterli bulursa araç R1'e döndürülebilir (risk alanı, `screenOnly`
  bayrağı, kayıt testi ve prompt birlikte değişir). O durumda CAPI etkisinin kabul edildiği bu ADR'ye yazılmalıdır.

### Harcama yetkisi ve aylık tavan (katmanlar)
1. **İstemci ön süzgeci:** `toolsFor(role, canApproveSpend)` R3 araçlarını harcama yetkisi olmayan kullanıcıya hiç
   bağlamaz. Bu yalnızca kullanım kolaylığıdır.
2. **Sunucu (asıl karar):** publish, budget ve apply uçları her çağrıda `requireSpendAuthority` ve kuruluşun aylık
   bütçe tavanını denetler (ADR-0014). Ses bu denetimleri atlamaz ya da kopyalamaz; aynı uçları kullanıcının
   oturumuyla çağırır.
3. Sunucunun harcama yetkisi 403'ü ajana `spendForbidden` iletisiyle, tavan aşımı `monthly_cap` koduyla gider; ajan
   yeniden denemez. Bütçe düşürme harcama yetkisi istemez.
- Entegrasyon testi (`web/tests/assistant-spend.integration.test.ts`, `STUDIO_DB_TEST=1`): harcama yetkisi olmayan
  MEDIA_BUYER'ın etkinleştirme, bütçe artışı ve BUDGET_INCREASE öneri uygulaması 403 alır (veritabanı ve Meta
  değişmez); bütçe düşürme geçer; OWNER'ın tavanı aşan artışı ve etkinleştirmesi `monthly_cap` ile reddedilir.

### Olay kaydı
- `/api/assistant/events`: araç adı kayıtta olmalı ve risk kayıttakiyle aynı olmalı (400). `ok` / `error` /
  `cancelled` yalnızca rolün (R3'te taze okunan harcama yetkisiyle) bağlayabileceği araç için kabul edilir
  (`toolAllowedFor`: aracın rol listesi + risk sınırı; aksi 403).
- `denied` her rol için kabul edilir: yetkisiz denemeler (izleyicinin R1, harcama yetkisi olmayanın R3 denemesi, ajan
  yolundan R2/R3 onay denemesi) de denetim kaydına düşer. `denied` işlemin yapıldığını göstermez.
- Faz 3'teki "izleyicinin yetkisiz R1 denemesi denetime düşmez" sınırı bu değişiklikle kapandı.

### Bilinen sınırlar (Faz 4)
- **Onay penceresi arayüzü:** `voice-assistant/index.tsx` R2/R3 bekleyen eylemleri henüz modal pencerede göstermiyor;
  bunlar R1 kartında görünür ve "Onayla" güvenli biçimde `not_confirmable` ile başarısız olur. Pencere (odak
  Vazgeç'te, 1 sn kilit, `confirmOnScreen`, sonucun `sendContextualUpdate` ile bildirilmesi) ve
  `SCREEN_ACTION_MESSAGES`'ın bilinen hata listesine eklenmesi sonraki adım.
- **e2e:** `web/e2e/assistant.pw.ts` lead durumunu R1 kartıyla onaylayan senaryoyu içeriyor; bu senaryo ekran
  penceresine taşınmalı. e2e yapılandırılmış bir sunucuya karşı çalıştırılmadı.
- Prompt v3 ve yeni araçlar ElevenLabs ajanına eşitlenmedi (`assistant:sync-agent -- --llm <model>`; dry-run 39
  araçla geçti). Göç yok.

### Açık sorular (güncel)
- `update_lead_status` R2'de mi kalsın (yukarıda; ürün sahibi kararı)?
- Ajan LLM'i (§7) ve aylık dakika/maliyet sınırı.
- KVKK: personel sesinin yurt dışında işlenmesi ve aydınlatma metni (hukuk görüşü bekleniyor).
- VIEWER'a düğme gösterilsin mi; macOS masaüstü kapsamda mı (Faz 5, Tauri mikrofon izni)?
- Uzun yayınların sesle sürdürülmesi (bugün yalnızca Yükleme sekmesine yönlendirilir).

## Faz 5 — masaüstü mikrofon, oturum ve maliyet sınırları, isteğe bağlı araçlar (2026-10-01)

Plan §11 Faz 5'in üç maddesi: (1) masaüstü kabuğunda mikrofon izni, (2) oturum ve maliyet sınırları, (3) isteğe
bağlı araçlar. Göç yok. Faz 4'ten kalan arayüz işi de kapandı: R2/R3 bekleyen eylemler artık modal ekran onay
penceresinde gösterilir (`voice-assistant/screen-confirm-dialog.tsx`, `runtime.pending.confirmOnScreen`); e2e
senaryosu bu pencereye taşındı (çalıştırılmadı).

### Masaüstü mikrofon izni (ADR-0025 kabuğu)
- **Kapsam:** Windows (WebView2) kabuğunda mikrofon yalnızca bağlantı ekranının açtığı sunucu origin'ine (şema +
  ana makine + kapı) verilir. Başka her origin (Meta OAuth, yönlendirme sayfaları, iframe'ler) ya da origin henüz
  bildirilmemişse ret; kamera, konum ve diğer sensörler her yerde ret; geri kalan izinler WebView2 varsayılanında.
  Kararlar profile kaydedilmez (`SavesInProfile = false`; WebView2 çalışma zamanı ≥ 1.0.1661.34), sunucu adresi
  değişince eski izin taşınmaz. Uygulama: `desktop/src-tauri/src/mic_permission.rs` (`decide()` saf işlevi ve
  birim testleri; `install()` yalnızca Windows'ta `PermissionRequested` işleyicisini kurar).
- **Origin Rust'a nasıl ulaşır:** ADR-0025'te origin yalnızca bağlantı ekranının `localStorage`'ındadır. Bağlantı
  ekranı paneli açmadan hemen önce `set_server_origin` komutunu çağırır (`desktop/ui/index.js`); Rust adresi
  `server-url.js` ile aynı kurallarla yeniden doğrular ve bellekte tutar. Komut yalnızca gömülü yerel sayfaya açıktır
  (`allow-set-server-origin`); `remote` yetenek tanımlı değildir, uzak panel ve Meta sayfaları Tauri komutu
  çağıramaz. Bunun için kabuk CSP'sinin `connect-src` listesine `ipc: http://ipc.localhost` eklendi. Çağrı başarısız
  olursa panel yine açılır, mikrofon reddedilir ve asistan yazıyla sürer.
- **macOS / iOS: mikrofon kapalı (bilinçli).** wry 0.55.1'in WKWebView temsilcisi
  (`wry_web_view_ui_delegate.rs`, `requestMediaCapturePermissionForOrigin…`) origin'e, çerçeveye ve türe bakmadan
  her medya yakalama isteğine izin verir (kamera dahil). Kabuk Apple platformlarında origin süzmediği için mikrofon
  yetkisi ve kullanım metni pakete **eklenmedi**: `bundle.macOS.entitlements` yok, `src-tauri/Info.plist` yok. Hazır
  dosyalar `desktop/src-tauri/apple-mic-disabled/` altında bekler; yalnızca kabuk WKWebView temsilcisinde origin
  denetimi yaptıktan sonra (mikrofon yalnızca `ServerOrigin`, kamera her yerde ret; `decide()` aynen) bağlanmalıdır.
  Bu yapılmadan bağlanırsa izin bir kez verildikten sonra panelden gidilen her sayfa (Meta OAuth, yönlendirmeler,
  `allow="microphone"` taşıyan yabancı iframe'ler) mikrofonu sessizce açabilir. Sonuç: Apple kabuğunda asistan
  yazıyla çalışır (panel mikrofon yoksa yazıya geçer). Kullanım metni olmayan iOS uygulamasında WKWebView'in
  `getUserMedia` isteğini çökmeden reddettiği varsayılır (DOĞRULANMADI; Mac/iPhone'da denenmedi).
- Ayrıntı, karar tablosu ve elle deneme adımları: `desktop/README.md` "Mikrofon (sesli asistan)".

### Oturum süresi
- `VOICE_ASSISTANT_MAX_SESSION_SECONDS` (60–1800, varsayılan 300). Değer iki yerde uygulanır:
  - **Ajan:** eşitleme betiği `conversation.max_duration_seconds`, `turn.silence_end_call_timeout = 30` ve Türkçe
    `agent.max_conversation_duration_message` yazar (OpenAPI 2026-10-01; `docs/elevenlabs-constraints.md`).
    `turn_timeout` (7 sn) değişmez. `platform_settings.call_limits` (burst, eşzamanlılık) betikle gönderilmez: kısmi
    `platform_settings` gövdesinin diğer ayarları sıfırlayıp sıfırlamadığı doğrulanmadı; panelden ayarlanır.
  - **Tarayıcı:** oturum yanıtı `maxSessionSeconds` taşır. Bağlantı kurulunca süre işler; son 30 sn panelde
    görünür, 30 ve 10 sn'de kibarca duyurulur. Ajan süre sonu iletisini söyleyip kapatmazsa tarayıcı sınırdan 3 sn
    sonra kapatır. Sınıra 5 sn kala ya da sonra gelen kapanış "süre sınırı" sayılır ve "Oturum süre sınırına (N
    dakika) ulaştı…" duyurulur (i18n tr/en). Bekleyen eylem kapanışta iptal edilir (Faz 3 kuralı).

### Kuruluş sınırları (`/api/assistant/session`)
- Sıra: kullanıcı başına saatlik sınır (`voice:<userId>`, 20) → **aylık dakika bütçesi** → **günlük oturum sınırı** →
  belirteç. Sınırlar `web/app/_lib/assistant-usage.ts` içindedir.
- **Günlük:** `VOICE_ASSISTANT_DAILY_SESSIONS_PER_ORG` (varsayılan 200; 0 = sınırsız), mevcut `quota()` ile
  `voice-org:<orgId>` anahtarı, UTC günü. Aşılınca 429 ve sabit Türkçe ileti (`limits.ts` `VOICE_LIMIT_MESSAGES`);
  tarayıcı iletiyi tanıyıp kendi dilindeki metni gösterir.
- **Aylık:** `VOICE_ASSISTANT_MONTHLY_MINUTES_PER_ORG` (boş/0 = sınırsız). Kuruluşun bu UTC ayı için tek bir
  `RequestQuota` sayacı (`voice-minutes:<orgId>:<YYYY-MM>`, saniye) bütçeye ulaştıysa 429. Sayaç oturum sonu kaydıyla
  aynı işlemde artar; bütçe denetimi tek satır okur (önceki sürüm bu ayın tüm denetim satırlarını tarıyordu:
  `AuditLog` yalnızca `[orgId, createdAt]` ile indekslidir ve `action` ek süzgeçti). Göç gerekmedi. Reddedilen istek
  günlük sayacı tüketmez.
- `VOICE_SESSION_STARTED × en uzun süre` tahmini kullanılmadı (çok kaba: kısa oturumlar bütçeyi hızla tüketirdi).

### Oturum sonu kaydı
- **Oturumun sahibi sunucudur.** `/api/assistant/session` rastgele bir `sessionRef` (32 hex) üretir, açılış kaydına
  (`VOICE_SESSION_STARTED.after.sessionRef`) yazar ve yanıtta döner.
- `POST /api/assistant/events` `{ type: "session_ended", sessionRef, durationSeconds, conversationId? }` →
  `AuditLog` `VOICE_SESSION_ENDED`, `after: { durationSeconds, source: "client", sessionRef }` ve aylık sayaç.
  Şema sıkı: kimlik ve süre zorunlu (tam sayı, 0–86 400), başka alan yok. Konuşma metni yazılmaz. Sunucu
  (`assistant-usage.ts` `recordVoiceSessionEnd`):
  - oturumu aynı kuruluş + aynı kullanıcı + son `max + 1 saat` içindeki açılış kaydında arar; yoksa 404 (oturum
    açmamış bir izleyici ya da başka kullanıcının kimliği bütçeyi şişiremez);
  - her oturumu bir kez kaydeder: tek kullanımlık `RequestQuota` işareti (`voice-session-ended:<orgId>:<ref>`,
    benzersiz anahtar) sayaç ve denetim satırıyla aynı işlemde yazılır; ikinci bildirim 409;
  - süreyi `min(bildirilen, max + 30 sn, açılıştan geçen duvar saati)` sayar.
  - Hız sınırı ayrıdır: `voice-session-end:<userId>` dakikada 10. Araç olayları (`voice-event`, dakikada 30) dolsa
    da oturum sonu düşmez.
- Tarayıcı oturum kapanınca (kullanıcı, ajan, süre sınırı, hata) bir kez gönderir (bekletmez). Sayfa kapanırken
  (`pagehide`, bileşen kalkarken) `fetch(..., { keepalive: true })` kullanılır: `sendBeacon` istenen
  `application/json` içerik türünü her tarayıcıda göndermez, olay ucu ise JSON gövde ve `sameOrigin` (Origin başlığı)
  ister. Keepalive istekleri aynı kaynaktan POST olduğu için Origin taşır (Fetch standardı); WebView2 ve Safari'de
  denenmedi (DOĞRULANMADI).
- **Bu bir bütçe korumasıdır, fatura değildir:** süreyi istemci bildirir; çöken sekme ya da kurcalanmış istemci daha
  az bildirebilir (fazla bildirim yukarıdaki kurallarla oturum başına `max + 30` sn ve gerçek süreyle sınırlıdır). Üst sınırlar ajandaki en uzun süre ve ElevenLabs paneli ayarlarıdır (burst kapalı, eşzamanlılık).
  İzleme ve acil adımlar: `docs/runbook.md` "Maliyet izleme ve sınırlar".

### Araç çağrısı hız sınırı (açık madde kapandı)
- İstemcide oturum başına dakikada 30 (Faz 2–4) aynen kalır. Sunucuda **genel bir araç sınırı eklenmedi**: her yazma
  ucu kendi `requireRole`, tenant, harcama yetkisi, aylık tavan, onay kapısı ve (LLM'de) `ai:<workspaceId>` kotasıyla
  korunur; ses bu uçlara kullanıcının oturumuyla, aynı denetimlerden geçerek gelir. Mevcut uçlara yalnızca ses için
  bir sınır eklemek paneldeki normal kullanımı da yavaşlatırdı. Oturum ve olay uçları zaten sınırlıdır.

### İsteğe bağlı araçlar (plan §3 "İleriye bırakılanlar")
- **Eklendi:** `list_experiments` (R0, menüdeki gibi READ_ADS; `GET /api/experiments`) ve
  `update_experiment_metrics` (R1, EDIT; `GET` + `PATCH /api/experiments/:id`).
  - Manuel A/B ölçümü iç veridir: Meta'ya, hastaya ya da harcamaya etkisi yoktur (`experiments/:id/sync` otomatik
    ölçüm yapmaz). Sunucu `updateExperiment` EDIT_ROLES, sürüm (`version`) ve iş kurallarını denetler.
  - Hazırlarken test taze okunur; sürüm, diğer varyantın metrikleri, gün sayısı ve durum dondurulur. Durum
    değişmez: test başlatma/tamamlama ve öneri üretimi ekrandan. Tamamlanan test, lead > tıklama, azalan gün ve
    okunamayan diğer varyant hazırlıkta reddedilir; sürüm çakışması `changed_meanwhile` kodu olur.
  - Sonuç yalnızca ref, durum, gün ve sayılar taşır; anlık görüntüdeki reklam içeriği ajana gitmez. Yeni ref türü
    `experiment` (`e1`); `get_current_context` `/tests/:id` sayfasında `experimentRef` döner.
- **Eklenmedi — klinik ve hizmet düzenleme:** alanları hastaya giden kanallara akar (hasta yanıt asistanı klinik
  adı, hizmetler, diller ve marka tonunu; giden arama ajanı klinik adını; reklam üretimi marka tonu, hizmetler ve
  yasaklı ifadeleri; politika denetimi yasaklı ifadeleri kullanır). Hizmet fiyatı ve "başlangıç fiyatını göster"
  hastaya yönelik fiyat bilgisidir (prompt fiyat söylemeyi zaten yasaklar) ve klinik kaydı iletişim bilgisi taşır.
  Serbest metin alanlarının sesle doğru yazılması da güvenilir değildir. R2 olarak açılması ayrı karar ister; bugün
  asistan Klinik ve marka sayfasını açar.
- **Hasta mesajı:** hukuk onayı yok; R4 olarak kalır (değişmedi).
- Prompt v4: `update_experiment_metrics` sesle onay listesinde, `list_experiments` okuma örneklerinde; klinik/hizmet
  düzenleme "sesle yapılamayan işlemler"de; oturum süresi bölümü. Ajan eşitlenmedi (dry-run 41 araçla geçti).

### Bilinen sınırlar (Faz 5, 2. ve 3. maddeler)
- Gerçek ElevenLabs hesabıyla denenmedi: süre sınırında ajanın davranışı, kısmi PATCH birleştirmesi, panel kullanım
  sayfası (`docs/elevenlabs-constraints.md`).
- `web/e2e/assistant.pw.ts` süre sınırını ve A/B ölçüm komutunu kapsamıyor; e2e yapılandırılmış sunucuya karşı
  çalıştırılmadı.
- Aylık bütçe UTC takvim ayıdır; kuruluşun saat dilimi kullanılmaz.

### Sınıflandırma özeti (Faz 5 sonrası)
- Yeni araçlar: `list_experiments` R0, `update_experiment_metrics` R1 (yalnızca iç veri; Meta, hasta ve harcama
  etkisi yok). R2/R3 listesi değişmedi.
- R4 (erişilemez) listesi değişmedi: onay/ret, silme ve gizlilik, OAuth/bağlantı, harcama yetkisi, tavan,
  faturalandırma, politika kuralları, canlıya alma, oturum açma/kapama, **hasta mesajı** ve CAPI. Hasta mesajı için
  hukuk onayı yoktur; R4 dışına alınması ayrı ADR ister.
- Klinik ve hizmet düzenleme araç olarak eklenmedi (yukarıda "İsteğe bağlı araçlar").

### Faz 5 — insanın denemesi gerekenler
- **e2e:** `web/e2e/assistant.pw.ts` yapılandırılmış bir sunucuya karşı çalıştırılmalı (ekran onay penceresi
  senaryosu dahil); süre sınırı ve A/B araçları için senaryo yok.
- **Canlı ElevenLabs:** ajan LLM'i seçilip (§7) eşitleme betiği `--llm` ile çalıştırılmalı; ardından kısmi PATCH
  birleştirmesi, süre sonu iletisi ve kapanış, token süresi ve istemci aracı zaman aşımı denenmeli
  (`docs/elevenlabs-constraints.md` "DOĞRULANMADI" maddeleri). Panelde burst kapatılmalı, eşzamanlılık sınırı
  düşük ayarlanmalı.
- **Tarayıcı:** geri sayım ve otomatik kapanış; sekme kapanırken `keepalive` oturum sonu kaydının Chrome, WebView2
  ve Safari'de ulaştığı.
- **Masaüstü:** Windows'ta `desktop/README.md` "Elle deneme" adımları 1–6 (istemsiz izin, başka origin'de ret,
  Windows gizlilik ayarı kapalıyken yazıya düşme). Eski derlemede profile kaydedilmiş "Engelle" kararının bu
  işleyiciyi atlayıp atlamadığı ve profil klasörü yolu DOĞRULANMADI. macOS/iOS hiç derlenmedi; iOS'ta kamera
  isteyen bir sayfanın `NSCameraUsageDescription` olmadığı için uygulamayı kapatıp kapatmayacağı DOĞRULANMADI.
- **Ürün sahibi / hukuk:** aylık dakika bütçesinin değeri; KVKK hukuk görüşü (§4); hasta mesajı kararı. KVKK
  ElevenLabs'teki işlemeyi kabul etmezse seçenek C (Scribe ile metne çevirme → kendi `command-router`'ımız → TTS;
  `packages/llm` için araç çağrısı desteği gerekir) ayrı bir ADR ile ele alınır; bugün uygulanmadı.
