import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../../../_lib/audit";
import { lockCampaignRow, ownedCampaign } from "../../../../_lib/campaign-workflow";

export const maxDuration = 15;

const RejectSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const input = await body(request, RejectSchema);
    return prisma.$transaction(async (tx) => {
      await lockCampaignRow(tx, actor, id);
      const campaign = await ownedCampaign(actor, id, tx);
      if (campaign.workflowStatus !== "IN_REVIEW")
        throw new HttpError(409, "Yalnızca incelemedeki kampanya reddedilebilir.");
      const moved = await tx.campaign.updateMany({
        where: { id, workspaceId: actor.workspaceId, workflowStatus: "IN_REVIEW" },
        data: {
          workflowStatus: "REJECTED",
          rejectionBy: actor.userId,
          rejectionReason: input.reason,
        },
      });
      if (moved.count !== 1)
        throw new HttpError(409, "Kampanya durumu eşzamanlı olarak değişti; yenileyip tekrar deneyin.");
      await logAudit({
        actor,
        action: "CAMPAIGN_REJECTED",
        entityType: "CAMPAIGN",
        entityId: campaign.id,
        before: { workflowStatus: campaign.workflowStatus },
        after: { workflowStatus: "REJECTED", reason: input.reason, rejectionBy: actor.userId },
      }, tx);
      return { campaign: { id: campaign.id, workflowStatus: "REJECTED" } };
    });
  });
}
