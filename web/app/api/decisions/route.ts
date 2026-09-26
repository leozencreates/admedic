import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { respond } from "../../_lib/http";
export const maxDuration = 15;
/**
 * Ajan kararları salt okunurdur: agent-engine kararları otomatik uygulanmaz ve bu uç
 * yalnızca GET sunar. Onay/red için ayrı bir `/api/decisions/[id]/approve|reject` ucu
 * bilinçli olarak yoktur (ADR-0002: harcamayı değiştiren aksiyonlar öneri → insan onayı
 * → `PATCH /api/campaigns/[id]/budget` / `POST /api/recommendations/[id]/apply` yoluyla
 * uygulanır). Para alanları (`budgetBefore/After`) minor unit'tir; panel `formatMoney(cents)` ile gösterir.
 */
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const decisions = await prisma.agentDecision.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, take: 20 });
    return { decisions };
  });
}
