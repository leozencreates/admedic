# Sunucu kurulumu ve işletim kılavuzu

- İlgili karar: ADR-0023 (sunucu merkezli mimari, Türkiye'de barındırma)
- Hedef: tek Linux sunucu (Ubuntu 24.04 LTS önerilir), Docker ve Docker Compose eklentisi
- Son güncelleme: 2026-09-29

## Neler çalışır

| Hizmet | Görevi | Dışarıya açık mı |
|---|---|---|
| `caddy` | HTTPS (Let's Encrypt), panele yönlendirme | Evet: 80, 443 |
| `web` | Panel, API, Meta webhook ucu, webhook yeniden deneme süpürücüsü | Hayır (Caddy arkasında) |
| `worker` | Meta senkronu (5 dk), anomali uyarıları, asistan turu, haftalık rapor, KVKK saklama süresi | Hayır |
| `postgres` | Veritabanı (PostgreSQL 17) | Hayır |
| `migrate` | Her kurulumda bir kez: veritabanı göçleri | Hayır |

## Sunucu gereksinimleri

- **Konum:** Türkiye'de bir veri merkezi (sağlık verisi; ADR-0023). Yedekler de Türkiye'de tutulur.
- **Boyut:** Pilot için 2 vCPU, 4 GB bellek, 40 GB SSD yeterli. İmaj derlemesi sırasında 4 GB belleğin altı yetersiz kalabilir.
- **Alan adı:** Panel için bir alt alan adı (ör. `panel.alanadi.com.tr`). A kaydı sunucunun IP adresine yönlenmeli.
- **Güvenlik duvarı:** Yalnızca 22 (SSH, tercihen yalnızca sizin IP'niz), 80 ve 443 açık.

## İlk kurulum

1. **Docker kurun:** `curl -fsSL https://get.docker.com | sh` (Docker'ın resmi kurulum betiği).
2. **Kodu alın:** `git clone <depo adresi> /opt/admedic && cd /opt/admedic/deploy`
3. **Ortam dosyası:** `cp .env.production.example .env` ve değerleri doldurun.
   - `AUTH_SECRET`, `ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `META_WEBHOOK_VERIFY_TOKEN` için: `openssl rand -hex 32`.
   - **`ENCRYPTION_KEY` kaybolursa** şifreli kişisel veri ve Meta anahtarları okunamaz. Parola yöneticisinde,
     yedeklerden ayrı saklayın.
   - `chmod 600 .env`
4. **Başlatın:** `docker compose -f docker-compose.prod.yml up -d --build`
   - İlk derleme 5–15 dakika sürer. `migrate` göçleri uygular ve kapanır; ardından `web` ve `worker` başlar.
5. **Denetleyin:** `curl https://<alan adı>/api/health` → `{"status":"ok",...}`
6. **İlk hesap sahibi:**
   ```
   docker compose -f docker-compose.prod.yml run --rm \
     -e BOOTSTRAP_EMAIL=siz@ornek.com -e BOOTSTRAP_PASSWORD='en-az-12-karakter' -e BOOTSTRAP_CLINIC='Klinik adı' \
     migrate sh -c "cd /app/web && pnpm user:create"
   ```
   Ardından bu e-posta ve parolayla giriş yapın.
7. **Canlıya geçiş sayfası:** Panelde Ayarlar → Canlıya geçiş. Engel kalmayana kadar sunucu ayarlarını düzeltin.

## Meta uygulaması ayarları

Meta Uygulama Panelinde (developers.facebook.com → uygulamanız):

- **Facebook Girişi → Geçerli OAuth yönlendirme URI'leri:** `https://<alan adı>/api/meta/oauth/callback`
  (`META_REDIRECT_URI` ile birebir aynı).
- **Webhook'lar:**
  - Geri çağırma URL'si: `https://<alan adı>/api/webhooks/meta`
  - Doğrulama belirteci: `META_WEBHOOK_VERIFY_TOKEN` değeri
  - Abonelikler: Sayfa → `leadgen`, `messages`; Instagram → `messages`; WhatsApp Business Account → `messages`.
- **Uygulama gizli anahtarı:** `META_APP_SECRET`. Webhook imzası ve `appsecret_proof` bununla hesaplanır.
- Başvuru ve izinler: `docs/app-review.md`.

## Sesli arama (ElevenLabs) — isteğe bağlı

İlgili karar: ADR-0026. Dış kısıtlar: `docs/elevenlabs-constraints.md`. Bu kurulum gerçek hesapla denenmedi; ilk
kurulumda aşağıdaki "Deneme" adımı atlanmamalıdır.

**Canlı aramadan önce (ürün sahibi):**
- ElevenLabs ile sağlık verisi için yazılı anlaşma. Şartlara göre sağlık bilgisi, yazılı kabul olmadan yasak veridir;
  anlaşma yalnızca Enterprise planda verilir.
- Aydınlatma metni, sesin ve transkriptin yurt dışındaki sağlayıcıda işlenmesini kapsamalı (hukuki inceleme).

**ElevenLabs tarafı:**
1. **Ajan:** ElevenLabs panelinde bir ajan oluşturun. İstemde `{{lead_first_name}}`, `{{clinic_name}}` ve
   `{{language}}` kullanılabilir. Ajan tıbbi tavsiye, teşhis ve fiyat vermemeli; bunları koordinatöre bırakmalıdır.
2. **Geçersiz kılmalar:** Ajanın Security sekmesinde **First message** ve **Language** geçersiz kılmalarını açın.
   Panel açılış cümlesini (yapay zekâ ve kayıt bildirimi) her aramada kendisi gönderir; bunlar kapalıysa arama
   başlamaz.
3. **Diller:** Ajanın ek diller listesine kullanacağınız dilleri ekleyin (Türkçe, İngilizce, Almanca, Arapça vb.).
4. **Saklama:** Ajan ayarında saklama süresini kısaltın; ses kaydını saklamayacaksanız kapatın.
5. **Numara:** Twilio numaranızı ya da SIP trunk'ınızı ElevenLabs'e aktarın; numaranın kimliğini (`phone_number_id`)
   not alın.
6. **Webhook:** Arama sonu webhook'u oluşturun.
   - Adres: `https://<alan adı>/api/webhooks/elevenlabs`
   - Kimlik doğrulama: HMAC. Verilen gizli anahtarı not alın.
   - Olaylar: yalnızca `transcript` ve `call_initiation_failure`. `audio` olayını **seçmeyin**.
   - Yeniden denemeyi açın.

**Sunucu tarafı (`deploy/.env`):**
```
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_PHONE_NUMBER_ID=...
ELEVENLABS_WEBHOOK_SECRET=...
ELEVENLABS_TELEPHONY=twilio        # ya da sip_trunk
```
Ardından `docker compose -f docker-compose.prod.yml up -d` (web ve worker yeniden başlar). Güncellemeyle gelen göç
(`20261001090000_voice_calls_and_assistant_examples`) `migrate` hizmetiyle kendiliğinden uygulanır.

**Denetim:** Panelde Ayarlar → Canlıya geçiş → "Sesli arama" satırı yeşil olmalı.

**Deneme (kendi numaranızla):**
1. Kendi adınıza bir lead oluşturun; telefonu ülke koduyla yazın (`+90…`).
2. Lead sayfası → Lead bilgileri → Sesli asistan araması → **Arama rızasını kaydet**.
3. **Ajan arasın.** Telefonunuz çalmalı; asistan klinik adına aradığını, yapay zekâ olduğunu ve görüşmenin
   kaydedildiğini söylemeli.
4. Görüşme bitince arama geçmişinde "Görüşüldü" ve özet görünmeli. Görünmüyorsa webhook teslimi başarısızdır:
   ElevenLabs tarafındaki teslim sonucuna bakın. Yanıt 401 ise gizli anahtar ya da imza biçimi uyuşmuyor
   (`docs/elevenlabs-constraints.md` "Webhook imzası"); 5xx ise `docker compose -f docker-compose.prod.yml logs web`.

**Otomatik arama:** Varsayılan kapalıdır. Hesap sahibi Klinik ve marka → Yapay zekâ ayarları'ndan açar. Açıkken işçi
5 dakikada bir müsait lead'leri arar: yalnızca arama rızası kayıtlı, koordinatörün devralmadığı lead'ler; lead'in
yerel saatiyle 09:00–20:00; lead başına en fazla 3 deneme; aynı anda 3, günde 50 arama.

| Belirti | Neden / çözüm |
|---|---|
| "Sesli arama hizmeti isteği reddetti" | Ajanda First message / Language geçersiz kılmaları kapalı ya da dil ajanın listesinde yok |
| "Sesli ajan ya da telefon numarası bulunamadı" | `ELEVENLABS_AGENT_ID` ya da `ELEVENLABS_PHONE_NUMBER_ID` yanlış |
| Arama "Aranıyor"da kalıyor, 2 saat sonra "Başlatılamadı" | Webhook ulaşmıyor: adres, gizli anahtar, güvenlik duvarı (ElevenLabs çıkış IP'leri) |
| "Numaranın ülkesi için arama saatleri tanımlı değil" | Ülke kodu tabloda yok (`packages/voice/src/eligibility.ts`); eklenmesi kod değişikliğidir |

## Sesli komut asistanı (ElevenLabs) — ajanı oluşturma ve eşitleme

İlgili karar: ADR-0028. Dış kısıtlar: `docs/elevenlabs-constraints.md` (2026-10-01, sesli komut asistanı). Gerçek
hesapla denenmedi; ilk kurulumda ajan panelden geri okunup denetlenmelidir.

**Bir kez, ElevenLabs panelinde:**
1. Telefon ajanından **ayrı** yeni bir ajan oluşturun; kimliğini `ELEVENLABS_ASSISTANT_AGENT_ID` olarak yazın.
2. Security: `enable_auth` açık, izinli host listesi **boş** (ikisi birlikte kullanılmaz). Geçersiz kılmalardan yalnızca
   `agent.language`, `conversation.text_only` ve (ses seçilecekse) `tts.voice_id` açılır. **Prompt geçersiz kılması
   açılmaz.**
3. Ek dillere Türkçe eklenir. Gizlilik: `record_voice` kapalı, saklama süresi açıkça kısa (ZRM yoksa `0`), post-call
   webhook kapalı.

**Prompt ve araçları eşitleme** (prompt, LLM, dil `tr`, TTS `eleven_flash_v2_5`, istemci araçları):

```bash
# Önce ağa çıkmadan gönderilecek gövdeleri görün
pnpm assistant:sync-agent --llm <model> --dry-run
# Sonra gerçek eşitleme (ELEVENLABS_API_KEY, ELEVENLABS_API_BASE, ELEVENLABS_ASSISTANT_AGENT_ID gerekir)
pnpm assistant:sync-agent --llm <model>
```

- `--llm` zorunludur; varsayılan yoktur (ADR-0013 §2, ADR-0028 §7). Model panelde Türkçe komutlarla denenip seçilir
  ve ADR-0028 §7'ye yazılır. Veri konumu kullanılıyorsa model o bölgede bulunmalıdır.
- `ELEVENLABS_API_KEY` yoksa ya da `META_MOCK_MODE=true` ise betik kendiliğinden dry-run çalışır. Anahtar hiçbir
  zaman yazdırılmaz.
- Araçlar `app/_lib/assistant/registry.ts` kaydından üretilir ve ada göre eşlenir: yoksa oluşturulur, farklıysa
  güncellenir, aynıysa dokunulmaz; ajana `tool_ids` ile bağlanır. Betik tekrar çalıştırılabilir.
- Prompt dosyası: `packages/voice/agent/assistant.prompt.tr.md`. Asistanın adı koda yazılmaz; `{{assistant_name}}`
  ve `{{user_role}}` dinamik değişkenleri tarayıcı oturumundan gelir (panelde test için yer tutucu:
  `ASSISTANT_NAME`, yoksa `APP_NAME`).
- **Araç kaydı ya da prompt her değiştiğinde** eşitleme yeniden çalıştırılır. Ad uyuşmazlığında (büyük/küçük harf
  dahil) ajan aracı çağıramaz.

| Belirti | Neden / çözüm |
|---|---|
| "--llm zorunludur" | Model seçilmeden eşitleme yapılmaz; `--llm <model>` verin |
| "… adlı birden fazla istemci aracı var" | Panelde aynı adda iki araç; fazlasını silip yeniden çalıştırın |
| "yanıttaki tool_ids/llm beklenenle aynı değil" | Ajanın sürümleme/dal ayarı ya da PATCH davranışı; ajanı panelde açıp araç listesini denetleyin |
| ElevenLabs 401/403 | Anahtar yanlış ya da `ELEVENLABS_API_BASE` başka bölgeyi gösteriyor (AB hesabı ayrıdır) |

## Güncelleme

```
cd /opt/admedic && git pull
cd deploy && APP_VERSION=$(git rev-parse --short HEAD) docker compose -f docker-compose.prod.yml up -d --build
```

Göçler `migrate` hizmetiyle otomatik uygulanır. Güncellemeden önce yedek alın (aşağıda).

**Geri alma:** Önceki sürüme dönün (`git checkout <önceki commit>`) ve aynı komutu çalıştırın. Göç geri alınmaz;
şema değiştiyse yedekten dönün.

## Yedekleme ve geri dönüş

- **Günlük yedek:** `crontab -e` → `30 3 * * * cd /opt/admedic/deploy && ./backup.sh >> backups/backup.log 2>&1`
  - 14 gün saklanır (`KEEP_DAYS`).
  - Yedekleri sunucu dışına da kopyalayın; hedef Türkiye'de olmalı.
- **Geri dönüş:** `./restore.sh backups/admedic-<zaman>.dump`
  - Web ve işçiyi durdurur, veritabanının üzerine yazar, yeniden başlatır.
- **Deneme:** Ayda bir, yedeği ayrı bir test sunucusuna geri yükleyip açılışı denetleyin.

## İzleme

- **Sağlık:** `GET /api/health`. Bir dış izleme hizmetinin 1–5 dakikada bir yoklaması önerilir.
  - `ok`: sorun yok.
  - `degraded`: webhook birikmesi ya da kalıcı başarısız teslim var.
  - `down` (503): veritabanına ulaşılamıyor.
- **Günlükler:**
  - Komut: `docker compose -f docker-compose.prod.yml logs -f web worker`
  - Satırlar tek satırlık JSON'dur.
  - Kişisel veri alanları `[gizli]` olarak maskelenir.
- **Webhook kuyruğu:**
  - İşlenemeyen Meta bildirimleri 1, 5, 30, 120 ve 360 dakika sonra yeniden denenir. Ardından `FAILED` olur ve sağlık ucu `degraded` der.
  - İnceleme: `docker compose -f docker-compose.prod.yml exec postgres psql -U admedic -c 'SELECT id, attempts, "lastError" FROM "WebhookDelivery" WHERE status = $$FAILED$$;'`

## Sık karşılaşılan sorunlar

| Belirti | Neden / çözüm |
|---|---|
| `web` açılmıyor, günlükte "Üretim ortamı yapılandırması eksik" | `.env` içindeki eksik değer iletide yazar; düzeltip `up -d` |
| Sertifika alınamıyor | Alan adı sunucuya yönlenmemiş ya da 80/443 kapalı |
| Meta bağlantısı "Meta'ya dönüş adresi uyuşmuyor" | `META_REDIRECT_URI` ile Meta panelindeki URI birebir aynı olmalı |
| Lead gelmiyor | Webhook aboneliği, sayfanın uygulamaya bağlı olması (`leadgen`), `leads_retrieval` izni; Canlıya geçiş sayfası |
