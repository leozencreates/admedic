import { prisma, Prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../_lib/http";
import { createMetaClient } from "@admedic/meta-api";
import { loadEnv } from "@admedic/config";
import { decrypt } from "../../../_lib/encrypt";
import { z } from "zod";
import { logAudit } from "../../../_lib/audit";
export const maxDuration = 30;
const SyncSchema = z.object({ campaignId: z.string().optional() }).strict();

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, SyncSchema);
    const campaigns = await prisma.campaign.findMany({
      where: {
        workspaceId: actor.workspaceId,
        ...(input.campaignId ? { id: input.campaignId } : {}),
        metaCampaignId: { not: null },
      },
      include: { adAccount: true },
    });
    const meta = createMetaClient();
    const mockMode = loadEnv().META_MOCK_MODE;
    const results: Array<Record<string, unknown>> = [];
    for (const campaign of campaigns) {
      if (!campaign.adAccount?.connectionId) continue;
      const conn = await prisma.metaConnection.findUnique({
        where: { id: campaign.adAccount.connectionId },
      });
      if (!conn || conn.status !== "CONNECTED") continue;
      const token = mockMode ? "mock-token" : decrypt(conn.tokenCiphertext ?? "");
      try {
        const { review } = await meta.getAdReview(campaign.metaCampaignId!, token);
        if (!review) {
          results.push({
            campaignId: campaign.id,
            name: campaign.name,
            metaReviewStatus: "UNKNOWN",
            error: "Meta inceleme verisi döndürmedi.",
          });
          continue;
        }
        const globalKeys = Object.keys(review.reviewFeedbackGlobal ?? {});
        const rejected = review.effectiveStatus === "DISAPPROVED";
        const pending =
          review.effectiveStatus === "IN_REVIEW" || review.effectiveStatus === "PENDING";
        const status = review.effectiveStatus
          ? review.effectiveStatus
          : rejected
            ? "DISAPPROVED"
            : pending
              ? "PENDING"
              : "ACTIVE";
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: {
            metaReviewStatus: status,
            metaRejectionReason:
              rejected || pending
                ? {
                    global: review.reviewFeedbackGlobal ?? {},
                    placements: review.reviewFeedbackPlacements ?? {},
                    effectiveStatus: review.effectiveStatus,
                    configuredStatus: review.configuredStatus,
                  }
                : Prisma.JsonNull,
            syncedAt: new Date(),
          },
        });
        results.push({
          campaignId: campaign.id,
          name: campaign.name,
          metaReviewStatus: status,
          globalIssueCount: globalKeys.length,
        });
      } catch (e) {
        results.push({
          campaignId: campaign.id,
          name: campaign.name,
          metaReviewStatus: "ERROR",
          error: e instanceof Error ? e.message : "Meta sorgusu başarısız.",
        });
      }
    }
    await logAudit({
      actor,
      action: "META_REVIEW_SYNC",
      entityType: "WORKSPACE",
      entityId: actor.workspaceId,
      after: {
        count: results.length,
        campaigns: results,
      } as unknown as Prisma.InputJsonValue,
    });
    return { synced: results.length, campaigns: results };
  });
}