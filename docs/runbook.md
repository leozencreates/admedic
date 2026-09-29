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
   Komut çalışma alanı kimliğini yazar; giriş sayfasında bu kimlik istenir.
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
