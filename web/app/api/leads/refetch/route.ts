import { prisma } from "@admedic/database";
import { z } from "zod";
import { CARE_ROLES, requireActor, requireRole } from "../../../_lib/auth";
import { body, HttpError, respond, sameOrigin } from "../../../_lib/http";
import { countPendingLeadFetches, refetchPendingLeads } from "../../../_lib/lead-refetch";
export const maxDuration = 30;

/**
 * Alanları Meta'dan çekilemeyen Lead Ads lead'leri (ADR-0015).
 * - GET: çalışma alanında bekleyen lead sayısı.
 * - POST `{ leadId? }`: bekleyenleri (ya da tek lead'i) şimdi yeniden çeker; geri çekilme süresi uygulanmaz.
 */
const RefetchSchema = z.object({ leadId: z.string().trim().min(1).max(64).optional() }).strict();

export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    return { pending: await countPendingLeadFetches(actor.orgId, actor.workspaceId) };
  });
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, CARE_ROLES);
    const input = await body(request, RefetchSchema);
    if (input.leadId) {
      const lead = await prisma.lead.findFirst({
        where: { id: input.leadId, workspaceId: actor.workspaceId },
        select: { metadata: true },
      });
      if (!lead) throw new HttpError(404, "Lead bulunamadı.");
      const metadata = lead.metadata as Record<string, unknown> | null;
      if (metadata?.pendingFetch !== true) throw new HttpError(409, "Bu lead'in alanları zaten çekilmiş.");
    }
    const summary = await refetchPendingLeads({
      orgId: actor.orgId,
      workspaceId: actor.workspaceId,
      leadIds: input.leadId ? [input.leadId] : undefined,
      limit: input.leadId ? 1 : 25,
      force: true,
      budgetMs: 20_000,
      userId: actor.userId,
    });
    return {
      attempted: summary.attempted,
      recovered: summary.recovered,
      failed: summary.failed,
      skipped: summary.skipped,
      remaining: summary.remaining,
      results: summary.results,
    };
  });
}
