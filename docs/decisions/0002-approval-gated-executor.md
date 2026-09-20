# ADR-0002: Onay-gated executor (ajanlar Meta'ya doğrudan yazamaz)

- **Durum:** Kabul edildi
- **Tarih:** 2026-09-16
- **Karar veren:** Proje sahibi (spec §4/§6 ile uyumlu)

## Bağlam
Spec §4: "Ajanlar Meta'ya doğrudan yazamaz; yalnızca 'önerilen aksiyon' nesnesi üretir; onay servisinden 
geçen ayrı bir executor uygular." Spec §6: "Para harcatan veya reklamı yayına alan hiçbir kod yolu insan 
onayı kontrolü olmadan birleştirilemez; bu kontrol için test yaz." (§3.6: her bütçe artışı yalnızca Tenant Owner.)

## Karar
Üç katmanlı kural:
1. **Üretici (önerme):** `@admedic/agent-engine` yalnızca `AgentDecisionOut` üretir; işlem yapmaz.
   - `KEEP` → `approval: NOT_REQUIRED` (işlem yok).
   - Bütçe/status değiştiren **her** aksiyon (`SPEND_AFFECTING_ACTIONS`, `STATUS_AFFECTING_ACTIONS`) → `approval: PENDING`. `AUTOPILOT` modu bile bunu gevşetmez; otonom auto-execute yok.
2. **Gate:** `buildExecutionPlan(decision, evidence)` yalnızca `evidence.status === "APPROVED"` ise Meta'da
   uygulanabilir `ExecutionPlan` üretir; aksi halde `PERMISSION_ERROR` fırlatır.
3. **Executor:** `executePlan(plan, client, token)` PLAN içindeki `evidenceStatus`'u bir kez daha doğrular
   (kalıcı katmanlardan yüklenen/geregince oluşturulan planlarda dahi). Bu, onaysız planın Meta'ya hiçbir
   çağrı yapamayacağının ikinci güvenlik katmanıdır.

Kritik savunma testi `packages/agent-engine/src/approval.test.ts` içinde: onaysız karar → plan üretilemez;
evidenceStatus PENDING olan plan → client çağrılmadan reddedilir.

## Sonuçlar
- Meta hesabındaki bütçe/status yazmaları tek yerden (executor) geçer; denetim/trace kolaydır.
- Onay akışı (Approval modeli, kimlik doğrulama, audit log) faz 1'de `apps/api` içinde executor'ın önüne bağlanacak.