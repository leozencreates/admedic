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