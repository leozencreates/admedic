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
                     masaüstü kabuğunun veri kaynağı, Bearer API_TOKEN ile korunur (ADR-0001 durum notu)
desktop/             Tauri v2 masaüstü kabuğu; desktop/ui statik paneli apps/api'yi tüketir (ADR-0003 rev. 2)
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
pnpm --filter @admedic/web user:create   # BOOTSTRAP_EMAIL/PASSWORD/CLINIC ile ilk kullanıcı; çalışma alanı ID'sini yazar
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

## Bu turda değişenler (2026-09-26) — panelde nereye bakmalı

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
- `docs/decisions/` — ADR'ler (0001 Fastify, 0002 onay kapılı executor, 0003 masaüstü, 0009 kreatif dilleri, 0010 haftalık rapor, 0011 para birimleri, 0012 Stripe akışı, 0013 LLM katmanı)
- `desktop/README.md` — masaüstü kabuğu kurulum/paketleme
- `docs/remaining-work.md` — kalan işler ve bilinen riskler
