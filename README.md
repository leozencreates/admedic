# Admedic — AI Sağlık Turizmi Meta Reklam Ajanı (monorepo)

Türkiye'deki sağlık turizmi klinikleri ve acenteleri için **insan onaylı** Meta reklam ajanı platformu:
çok dilli kreatif üretimi, politika uyum kontrolü, onay akışı, lead yakalama/CRM ve performans raporlama.
"Admedic" çalışma adıdır; ürün adı kodda sabit yazılmaz, `APP_NAME` ortam değişkeninden okunur.

Ana bağlam dosyası **`docs/spec.md`**'dir; mimari kararlar `docs/decisions/` (ADR), Meta API kısıt notları
`docs/meta-constraints.md`, stüdyo/onay akışı `docs/ad-studio.md`, kalan işler `docs/remaining-work.md`.

## Mimari

```txt
web/                 Next.js 16 App Router paneli; API = route handler'lar (web/app/api/**), Zod doğrulama,
                     oturum çerezi + RBAC + audit log, tenant izolasyonu (orgId/workspaceId)
workers/meta-sync    Zamanlanmış worker (5 dk): Meta token yenileme, insight çekimi, anomali uyarıları,
                     bağlantı kopma webhook'u, haftalık PDF/e-posta raporu, lead saklama süresi anonimleştirme
apps/api             Fastify v5 salt okunur REST (/v1/overview, /v1/campaigns, /v1/decisions, /v1/alerts);
                     Bearer API_TOKEN ile korunur; kabuk artık bunu kullanmaz (ADR-0025)
desktop/             Tauri v2 Windows/iOS kabuğu: sunucudaki web panelini saran ince istemci; desktop/ui yalnızca
                     sunucu adresini soran bağlantı ekranıdır (ADR-0025)
packages/voice       ElevenLabs sesli ajanla giden arama: istemci, deneme modu, webhook imzası, "müsait lead"
                     kuralı ve arama akışı (ADR-0026)
packages/lead-team   50 ajanlık lead takımı: kadro, hiyerarşik çalıştırma, çıktı şemaları (ADR-0029)
packages/config      loadEnv() (Zod ile doğrulanmış ortam), alan seviyesi şifreleme, LLM/Graph sürüm yardımcıları
packages/database    Prisma şeması, migration'lar, seed, tenant ve gizlilik yardımcıları (PostgreSQL)
packages/shared      Ortak tipler, enum'lar, hata sınıfları, para/zaman yardımcıları
packages/meta-api    Meta Marketing/Graph/Lead/CAPI istemcisi + deterministik mock (META_MOCK_MODE)
packages/llm         Anthropic sağlayıcı soyutlaması, sürümlü prompt'lar, çağrı günlüğü (model ortamdan)
packages/policy      Kural tabanlı politika motoru (TR/EN/DE/RU/AR/FR/NL/PL kalıpları, sürümlü kural seti)
packages/agent-engine / bayesian-engine   Deney değerlendirme, Thompson örnekleme, onay kapılı executor (ADR-0002)
packages/recommendation   Tamamlanan deneylerden bütçe/yayın önerileri
packages/reporting   Haftalık rapor sorgusu, pdfmake PDF, Resend e-posta (ADR-0010)
packages/stripe      Abonelik plan tablosu + Stripe API sürümü (tek kaynak) ve Stripe istemci yardımcıları
packages/platforms   Google Ads / TikTok için platform soyutlaması (P2, iskelet)
legacy/              Arşiv (eski uygulama); derleme/lint kapsamı dışında
```

Ürün dili Türkçe: kullanıcıya görünen metinler ve yorumlar Türkçe, tanımlayıcılar İngilizce. UI dili TR/EN
(`ui-lang` çerezi, `web/app/_lib/i18n.ts`); kreatif dilleri ayrıdır (ADR-0009).

Para birimi kuralı (ADR-0011): veritabanında her tutar minor unit (kuruş/cent); API girdileri insan birimi,
yanıtlar `…Cents` alanları. Meta API sürümü `META_API_VERSION`/`META_GRAPH_API_VERSION` ile gelir, koda yazılmaz.

## Kurulum

Gereksinimler: Node ≥ 20, pnpm 11 (`packageManager` alanı), PostgreSQL 17 (yerel veya `docker compose up -d`).

Windows'ta tek adım: `scripts\dev-up.cmd` (çift tıklanabilir) — bağımlılıklar, Prisma client, migration'lar,
demo seed, paket derlemesi ve `pnpm web:dev`'i sırayla çalıştırır; `-NoSeed`, `-WithApi`, `-WithWorker`,
`-SkipInstall` seçenekleri `scripts\dev-up.ps1` başlığında açıklanır. Elle kurulum:

```sh
pnpm install
cp .env.example .env           # DATABASE_URL, AUTH_SECRET, ENCRYPTION_KEY vb. doldurun (tablo aşağıda)
pnpm db:generate               # Prisma client
pnpm --filter @admedic/database build
pnpm db:deploy                 # migration'ları uygular (geliştirmede: pnpm db:migrate)
pnpm db:seed                   # demo kiracı + kampanya/insight verisi (isteğe bağlı)
pnpm --filter @admedic/web user:create   # BOOTSTRAP_EMAIL/PASSWORD/CLINIC ile ilk kullanıcı; ardından e-posta ve parolayla giriş
pnpm web:dev                   # http://localhost:3000 → /login
```

Diğer süreçler:

```sh
pnpm worker:sync     # workers/meta-sync — 5 dakikada bir senkron/uyarı/rapor döngüsü
pnpm api:dev         # apps/api — http://127.0.0.1:3001 (PORT / API_HOST ile değiştirilebilir)
pnpm desktop:dev     # Tauri kabuğu (Rust toolchain gerekir; bkz. desktop/README.md)
```

`META_MOCK_MODE=true` iken Meta/WhatsApp çağrıları deterministik mock ile döner; `STRIPE_SECRET_KEY` yoksa
(production dışında) faturalandırma ödeme simülasyonu modundadır. Production'da `AUTH_SECRET`, `ENCRYPTION_KEY`
ve (mock kapalıysa) `META_API_VERSION` zorunludur; `loadEnv()` eksikse başlatmayı reddeder.

## Bu turda değişenler (2026-10-01) — nereye bakmalı

- **Windows uygulaması** (`desktop/`): sunucudaki panelin tamamını açan kurulabilir uygulama. Derleme:
  `pnpm --filter @admedic/desktop build:ci`; çıktı `desktop/src-tauri/target/release/bundle/`. İlk açılışta sunucu
  adresi sorulur (yerelde `localhost:3000`). **iOS:** panel Safari'den ana ekrana eklenebilir; mağaza paketi Mac'te
  derlenir ve henüz denenmedi (`desktop/README.md` "iOS", ADR-0025).
- **Sesli asistan araması** (`/leads/[id]` → Lead bilgileri): telefonla aranma rızası kaydı, "Ajan arasın" düğmesi,
  arama geçmişi. Otomatik arama **Klinik ve marka → Yapay zekâ ayarları**'ndan açılır (yalnızca hesap sahibi;
  varsayılan kapalı). Kurulum: `docs/runbook.md` "Sesli arama"; canlı aramadan önce `docs/elevenlabs-constraints.md`
  "Şartlar" (ADR-0026).
- **Asistana üslup örnekleri** (aynı ayar kartı): randevuya dönüşen Instagram konuşmalarında ekibin yazdığı
  yanıtlar karşılama asistanına örnek olur; hastanın yazdıkları ve adı girmez (ADR-0027).
- **Lead takımı** (`/lead-team`): 50 ajan (1 direktör, 7 lider, 42 uzman) lead reklamı planı önerir; nihai kararı
  direktör verir, öneriler **Onaylar**'da insan onayını bekler. Onay kampanya oluşturmaz (ADR-0029).
- **Lead saklama süresi** düzeltildi: iş daha önce hiçbir normal lead'i seçmiyordu; artık süresi dolan lead'leri
  gerçekten anonimleştirir (geri alınamaz). Canlı veride önce deneme sayımı: `docs/remaining-work.md` §0 madde 13.
- Yeni göçler ve yeniden başlatma: `docs/remaining-work.md` §0 madde 12.

## Önceki tur (2026-09-27, ikinci tur) — panelde nereye bakmalı

- **Lead CRM** (`/leads`, `/leads/[id]`): Instant Form'daki rıza kutusu artık lead ile birlikte **rıza kaydı** olarak
  saklanır (formda gösterilen metin, tarih ve dayanakla; lead detayında "Rıza kayıtları"). Form yanıtları Meta'dan
  çekilemeyen lead'ler için uyarı ve **"Meta'dan yeniden çek"** düğmesi; bağlantı yenilenince ve yeni lead gelince
  otomatik yeniden denenir.
- **Kampanya Planlayıcı**: yayınlanan kampanyada reklam düzeyinde **Meta inceleme durumu** (reddedildi / sorunlu /
  incelemede / sorun yok) ve red gerekçeleri; "İncelemeyi yenile". Reddedilen reklam **Uyarılar**'a düşer
  ("Meta reklamı reddetti"); worker durumu düzenli yeniler.
- Tüm Meta sunucu çağrıları `appsecret_proof` gönderir (Meta panelinde "Require App Secret" açılabilir).
  Ayrıntı: ADR-0015; yeni migration için `docs/remaining-work.md` §0.

## Önceki tur (2026-09-27) — tam yayın ve harcama yetkisi

- **Kampanya Planlayıcı** (`/campaign-planner`): onaylı stüdyo taslakları ve reklam görseli kampanyaya bağlanır;
  "Yayınla" Meta'da kampanya → ad set (pazar × dil) → lead formu → kreatif → reklamı **PAUSED** kurar, yarım kalırsa
  kaldığı yerden sürer. "Aktifleştir" ve bütçe artışı yalnızca **Owner veya Owner'ın yetki verdiği** ADMIN/MEDIA_BUYER
  üyeye açık (**Harcama yetkisi** kartı). Aylık üst sınır artık aktif kampanyaların toplamı + yeni bütçe ile denetlenir;
  sınırı yükseltmek/kaldırmak yalnızca Owner. Ayrıntı: ADR-0014.
- **Klinik & Marka** (`/clinic`): Instant Form için https **gizlilik politikası bağlantısı** alanı.
- Yükseltme adımları ve canlı doğrulama listesi: `docs/remaining-work.md` §0 ve §4.

## Önceki tur (2026-09-26)

- **Lead CRM** (`/leads`, `/leads/[id]`): dil/hizmet/kaynak kampanya sütunları, kayıp nedeni zorunlu LOST akışı,
  rıza ver/geri çek, sohbette şablon gönderimi ve koordinatör devralması; VIEWER/ANALYST için maskeli iletişim bilgisi.
- **Kampanya Planlayıcı** (`/campaign-planner`): pazar→dil eşlemesi, "neden" alanları, pazar başına reklam seti,
  aylık üst sınır kartı (OWNER/ADMIN), reddetme gerekçesi, politika uyarıları; bütçeler kuruş bazında (ADR-0011).
- **Reklam Oluştur / Kütüphane** (`/studio`, `/library`, `/creative`): sunucu politika sonucu (kural + LLM gerekçesi
  ve düzeltilmiş metin), orta risk onay kutusu, Meta CTA seçimi, dil başına üretim ve RTL önizleme.
- **Meta Bağlantılar** (`/meta-connections`): bağlantı sonrası durum/eksik izin özeti, Pixel/WhatsApp/Sayfa kimlik
  eşleme formu; webhook adresi artık `/api/webhooks/meta`.
- **İçgörüler / Uyarılar / Öneriler** (`/insights`, `/alerts`, `/recommendations`): CPM ve pazar/dil kırılımı,
  haftalık PDF bağlantısı, uyarı "Görüldü/Çözüldü", öneri onayla/uygula (kampanya seçimiyle).
- **Klinik & Marka** (`/clinic`): klinik oluşturma, şehir alanı, hizmet düzenleme/arşivleme, pazar hedefi düzenleme.
- **Faturalar** (`/billing`): plan seçimi Stripe Checkout'a yönlendirir (anahtar yoksa simülasyon).
- **Dil** (sol menü): TR/EN anahtarı. Ayrıntılı liste ve kalan işler: `docs/remaining-work.md`.

## Test ve doğrulama

```sh
pnpm verify                                       # typecheck + lint + test (masaüstü hariç, turbo)
# Windows PowerShell: $env:STUDIO_DB_TEST="1"; pnpm verify   (veritabanlı entegrasyon testleri dahil)
pnpm turbo run typecheck lint --filter='!@admedic/desktop' --env-mode=loose   # Rust toolchain olmayan makinede
pnpm --filter @admedic/<paket> test               # tek paket (policy, llm, meta-api, reporting, api …)
cd web && STUDIO_DB_TEST=1 npx vitest run         # veritabanlı web entegrasyon testleri (migration uygulanmış test DB'si)
pnpm --filter @admedic/web exec playwright install chromium && STUDIO_E2E=1 pnpm test:e2e
pnpm --filter @admedic/web build
```

DB/E2E testleri açık opt-in ister; benzersiz test kiracıları oluşturur ve yalnızca kendi kayıtlarını temizler.
Ayrıntı: `docs/ad-studio.md` "Doğrulama".

## Ortam değişkenleri

Tek kaynak `packages/config/src/env.ts` (`loadEnv()`); kök `.env` dosyası cwd'den yukarı aranarak yüklenir.
Boş bırakılan alanlar `undefined` sayılır.

| Değişken | Zorunlu | Açıklama |
| --- | --- | --- |
| `APP_NAME` | — (varsayılan Admedic) | Ürün adı; panel, API servis adı ve masaüstü ürün adı |
| `DATABASE_URL` | Evet | PostgreSQL bağlantısı |
| `AUTH_URL` | Evet | Panelin tam origin'i; yazma isteklerinde origin eşleşmesi ve API CORS |
| `AUTH_SECRET` | Evet (prod) | Oturum gizli anahtarı; geliştirme varsayılanı production'da reddedilir |
| `ENCRYPTION_KEY` | Evet (prod) | 64 hex karakter; token/telefon/e-posta alan şifrelemesi (ADR-0011) |
| `META_MOCK_MODE` | — (varsayılan true) | Meta/WhatsApp/Stripe-webhook mock davranışı |
| `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` | Canlı Meta | Business Login (OAuth) |
| `META_API_VERSION` / `META_GRAPH_API_VERSION` | Canlı Meta | Graph sürümü (örn. v26.0); ikincisi önceliklidir |
| `META_WEBHOOK_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Webhook | X-Hub-Signature-256 imzası ve abonelik doğrulaması |
| `META_DISCONNECTED_WEBHOOK_URL` | — | Bağlantı koptuğunda bilgilendirilecek dış URL |
| `WHATSAPP_API_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_GREETING_TEMPLATE` | WhatsApp | Cloud API ve pencere dışı şablon |
| `ANTHROPIC_API_KEY`, `LLM_MODEL` | AI | LLM sağlayıcı anahtarı ve model kimliği (varsayılan model yok) |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID` | Sesli arama | ElevenLabs anahtarı, ajan ve numara kimliği; üçü de yoksa sesli arama kapalı (ADR-0026) |
| `ELEVENLABS_WEBHOOK_SECRET` | Sesli arama | Arama sonu webhook'unun HMAC gizli anahtarı; yoksa webhook 401 döner |
| `ELEVENLABS_TELEPHONY`, `ELEVENLABS_API_BASE` | — | `twilio` (varsayılan) ya da `sip_trunk`; API kökü (varsayılan `https://api.elevenlabs.io`) |
| `API_URL`, `API_TOKEN` | apps/api | REST adresi ve Bearer belirteci (belirteç yoksa yalnızca mock modda açık) |
| `PORT`, `API_HOST` | — | apps/api dinleme adresi (varsayılan 127.0.0.1:3001; EnvSchema dışında) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Faturalandırma | Stripe gizli anahtarı ve webhook imza gizli anahtarı |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_PRICE_ENTERPRISE` | Faturalandırma | Plan başına Stripe Price kimliği |
| `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | — | Checkout dönüş adresleri (varsayılan `AUTH_URL/billing?status=…`) |
| `RESEND_API_KEY`, `RESEND_FROM`, `WEEKLY_REPORT_RECIPIENT`, `WEEKLY_REPORT_DAY` | Haftalık rapor | E-posta gönderimi ve gün (0–6, UTC) |
| `REDIS_URL` | — | Kuyruk altyapısı (henüz kullanılmıyor) |
| `LOG_LEVEL`, `NODE_ENV` | — | pino seviyesi; ortam |
| `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD`, `BOOTSTRAP_CLINIC` | İlk kullanıcı | `user:create` CLI'ı; işlem sonrası parolayı ortamdan kaldırın |

## Dokümantasyon

- `docs/spec.md` — ürün spesifikasyonu (zorunlu bağlam)
- `docs/ad-studio.md` — stüdyo, onay akışı, API tablosu, doğrulama
- `docs/meta-constraints.md` — Meta API kısıtları ve tarihli bulgular
- `docs/elevenlabs-constraints.md` — ElevenLabs Agents kısıtları, şartlar ve tarihli bulgular
- `docs/decisions/` — ADR'ler (0001 Fastify, 0002 onay kapılı executor, 0003 masaüstü, 0009 kreatif dilleri, 0010 haftalık rapor, 0011 para birimleri, 0012 Stripe akışı, 0013 LLM katmanı, 0014 tam PAUSED yayın + harcama yetkisi, 0025 Windows/iOS ince istemci, 0026 sesli arama,
  0027 asistana üslup örnekleri, 0029 lead takımı)
- `desktop/README.md` — Windows/iOS kabuğu kurulum, paketleme ve iOS adımları
- `docs/remaining-work.md` — kalan işler ve bilinen riskler
