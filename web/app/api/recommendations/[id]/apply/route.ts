import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "@/app/_lib/auth";
import { body, respond, sameOrigin, HttpError } from "@/app/_lib/http";
import { logAudit } from "@/app/_lib/audit";
import { z } from "zod";

export const maxDuration = 15;
const ApplySchema = z.object({ campaignId: z.string().optional() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN", "MEDIA_BUYER"]);
    const { id } = await params;
    const input = await body(request, ApplySchema).catch(() => ({}));
    const rec = await prisma.recommendation.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      include: { experiment: { include: { draft: { include: { workspace: { include: { adAccounts: { include: { campaigns: true } } } } } } } } },
    });
    if (!rec) throw new HttpError(404, "Öneri bulunamadı.");
    if (rec.status !== "PENDING" && rec.status !== "APPROVED") throw new HttpError(409, "Bu öneri zaten işlenmiş.");
    const action = rec.action as Record<string, unknown> ?? {};
    let appliedCampaignId: string | null = null;
    if (action.type === "BUDGET_REALLOCATION" || action.type === "BUDGET_INCREASE") {
      const accounts = (rec.experiment.draft.workspace.adAccounts as any[]) ?? [];
      const campaigns = (accounts[0]?.campaigns as any[]) ?? [];
      const primaryCampaignId = ((input as any).campaignId as string | undefined) ?? campaigns[0]?.id ?? undefined;
      if (primaryCampaignId) {
        const campaign = await prisma.campaign.findUnique({ where: { id: primaryCampaignId, workspaceId: actor.workspaceId } });
        if (campaign) {
          const split = ((action.budgetSplit as number[]) ?? [50])[0] ?? 50;
          const newBudget = action.type === "BUDGET_INCREASE"
            ? Math.round((campaign.dailyBudget ?? 1000) * 1.2)
            : Math.round((campaign.dailyBudget ?? 1000) * (split / 100));
          await prisma.campaign.update({ where: { id: primaryCampaignId }, data: { dailyBudget: Math.min(newBudget, 1000000) } });
          appliedCampaignId = primaryCampaignId;
        }
      }
    }
    await prisma.recommendation.update({ where: { id }, data: { status: "APPLIED", appliedAt: new Date(), ...(appliedCampaignId ? { action: { ...action, appliedCampaignId } } : {}) } });
    await logAudit({ actor, action: "RECOMMENDATION_APPLIED", entityType: "RECOMMENDATION", entityId: id, after: { status: "APPLIED", appliedCampaignId } });
    return { ok: true, status: "APPLIED", appliedCampaignId };
  });
}