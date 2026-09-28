import { prisma, Prisma } from "@admedic/database";
import { z } from "zod";
import { requireActor, requireRole, EDIT_ROLES } from "../../../_lib/auth";
import { body, HttpError, respond, sameOrigin } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";
import { syncCampaignAdReviews } from "../../../_lib/ad-review-sync";
export const maxDuration = 30;
const SyncSchema = z.object({ campaignId: z.string().optional() }).strict();

/**
 * Meta inceleme durumunu reklam düzeyinde yeniler (spec 3.5; ADR-0015). Kampanya nesnesinde inceleme geri
 * bildirimi yoktur: durum, kampanyanın Meta'daki reklamlarından (`effective_status`, `ad_review_feedback`,
 * `issues_info`) toplanır. Yeni reddedilen reklam AD_DISAPPROVED uyarısı üretir. Worker aynı senkronu
 * zamanlanmış olarak yapar.
 */
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const input = await body(request, SyncSchema);
    const campaigns = await prisma.campaign.findMany({
      where: {
        workspaceId: actor.workspaceId,
        adAccount: { orgId: actor.orgId },
        ...(input.campaignId ? { id: input.campaignId } : { workflowStatus: { in: ["PUBLISHED_PAUSED", "ACTIVE"] } }),
        metaCampaignId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, name: true, adAccount: { select: { connectionId: true } } },
    });
    if (input.campaignId && campaigns.length === 0) throw new HttpError(404, "Meta'da yayınlanmış kampanya bulunamadı. Önce kampanyayı yayınlayın.");
    const results = [];
    for (const campaign of campaigns) results.push(await syncCampaignAdReviews(campaign, actor.orgId));
    await logAudit({
      actor,
      action: "META_REVIEW_SYNC",
      entityType: "WORKSPACE",
      entityId: actor.workspaceId,
      after: { count: results.length, campaigns: results } as unknown as Prisma.InputJsonValue,
    });
    return { synced: results.length, campaigns: results };
  });
}
