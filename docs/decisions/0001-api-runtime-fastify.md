# ADR-0001: HTTP API çalışma zamanı olarak Fastify

- **Durum:** Kabul edildi
- **Tarih:** 2026-09-16
- **Karar veren:** Proje sahibi (onaylandı)

## Bağlam
Spec §4: "Web: Next.js (App Router)... API: Next.js route handlers veya ayrı Fastify". 
Restful API uçları (onay akışı, Meta bağlantısı, raporlar, webhook) panel arayüzünden ayrı, 
dalga geçmeyen, Zod ile doğrulanan bir API katmanı istiyor.

## Karar
`apps/api` için **Fastify** kullanılacak (Next.js route handlers yerine). 
`apps/web` (Next.js) yalnızca UI sunar; API çağrılarını Fastify servisine yapar.
Webhook imzaları (X-Hub-Signature-256) Fastify katmanında doğrulanır.

## Gerekçe
- Sanitize edilmiş, açık yaşam döngüsüne sahip hızlı HTTP çalışma zamanı; iş mantığı (agent-engine, meta-api)
  çerçeveden bağımsız saf paketlerde kalır.
- Webhook/queue worker'ları (BullMQ) API'den bağımsız çalışabilir — Fastify ayrımı bunu korur.
- Zod ile giriş doğrulama kolayca eklenir.

## Sonuçlar
- `apps/api` şu an boş; bu ADR ilerideki faz 1 çalışmasında uygulanacak (bu oturumda kod yazılmadı).

## Durum notu (2026-09-26)

- Panel API'si fiilen **Next.js route handler'ları** (`web/app/api/**`) ile yazıldı: Zod doğrulama, oturum çerezi,
  RBAC, audit log ve tenant izolasyonu bu katmandadır; Meta webhook imzası (`X-Hub-Signature-256`) da
  `web/app/api/webhooks/meta` içinde doğrulanır.
- `apps/api` (Fastify v5) **salt okunur masaüstü API'sidir** (`/v1/overview`, `/v1/campaigns`, `/v1/decisions`,
  `/v1/alerts`): Tauri kabuğunun veri kaynağı (ADR-0003 rev. 2). `API_TOKEN` Bearer belirteci ister
  (belirteç yoksa yalnızca `META_MOCK_MODE=true` iken açık, aksi halde 503), CORS yalnızca `AUTH_URL` ve
  Tauri kaynaklarına açıktır, pino logları belirteç/çerez/e-posta/telefon alanlarını redakte eder.
- Bu ADR'nin "web yalnızca UI sunar, API çağrılarını Fastify'a yapar" cümlesi geçerli değildir; karar
  "iş mantığı paketlerde, HTTP katmanı ince" ilkesi bakımından korunmuştur.
