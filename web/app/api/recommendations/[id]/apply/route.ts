import { prisma } from "@admedic/database";
import { createMetaClient } from "@admedic/meta-api";
import { loadEnv } from "@admedic/config";
import { requireActor, requireRole } from "@/app/_lib/auth";
import { body, respond, sameOrigin, HttpError } from "@/app/_lib/http";
import { logAudit } from "@/app/_lib/audit";
import { decrypt } from "@/app/_lib/encrypt";
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
    const action = rec.action as Record<string, unknown> ?? {} as Record<string, unknown>;
    let appliedCampaignId: string | null = null;
    let metaSynced = false;
    if (action.type === "BUDGET_REALLOCATION" || action.type === "BUDGET_INCREASE") {
      const accounts = (rec.experiment.draft.workspace.adAccounts as any[]) ?? [];
      const campaigns = (accounts[0]?.campaigns as any[]) ?? [];
      const candidateId = ((input as any).campaignId as string | undefined) ?? campaigns[0]?.id ?? undefined;
      if (!candidateId) throw new HttpError(422, "Uygulanacak kampanya belirtilmedi.");
      appliedCampaignId = candidateId;
      const split = ((action.budgetSplit as number[]) ?? [50])[0] ?? 50;
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Campaign"
          WHERE "id" = ${candidateId} AND "workspaceId" = ${actor.workspaceId} FOR UPDATE`;
        const campaign = await tx.campaign.findFirst({
          where: { id: candidateId, workspaceId: actor.workspaceId, adAccount: { orgId: actor.orgId } },
          include: { adAccount: { include: { connection: true } } },
        });
        if (!campaign) throw new HttpError(404, "Kampanya bulunamadı.");
        const newBudget = action.type === "BUDGET_INCREASE"
          ? Math.round((campaign.dailyBudget ?? 1000) * 1.2)
          : Math.round((campaign.dailyBudget ?? 1000) * (split / 100));
        if (newBudget < 1) throw new HttpError(422, "Bütçe çok küçük.");
        if (action.type === "BUDGET_INCREASE") {
          const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId } });
          if (org.monthlyAdBudgetCap != null && newBudget * 30 > org.monthlyAdBudgetCap)
            throw new HttpError(422, "Yeni bütçe kuruluşun aylık üst sınırını aşıyor.");
        }
        const published = ["ACTIVE", "PUBLISHED_PAUSED"].includes(campaign.workflowStatus ?? "");
        if (published && campaign.metaCampaignId) {
          const conn = campaign.adAccount.connection;
          if (!conn || conn.orgId !== actor.orgId || conn.status !== "CONNECTED" ||
              (conn.expiresAt && conn.expiresAt <= new Date()))
            throw new HttpError(400, "Meta bağlantısı aktif değil.");
          const mock = loadEnv().META_MOCK_MODE;
          if (!mock && !conn.tokenCiphertext)
            throw new HttpError(400, "Meta erişim token'ı bulunamadı.");
          try {
            const result = await createMetaClient().updateBudget({
              entityType: "campaign",
              entityId: campaign.metaCampaignId,
              dailyBudgetCents: newBudget * 100,
            }, mock ? "mock-token" : decrypt(conn.tokenCiphertext!));
            if (!result.success) throw new Error("Meta update failed");
            metaSynced = true;
          } catch {
            throw new HttpError(502, "Meta bütçe güncellemesi başarısız. Bütçe değiştirilmedi.");
          }
        }
        const updated = await tx.campaign.update({
          where: { id: candidateId },
          data: { dailyBudget: Math.min(newBudget, 1000000), budgetType: "DAILY", ...(published ? { syncedAt: new Date() } : {}) },
        });
        await tx.recommendation.update({
          where: { id },
          data: { status: "APPLIED", appliedAt: new Date(), action: { ...action, appliedCampaignId } },
        });
        await logAudit({
          actor, action: "RECOMMENDATION_APPLIED", entityType: "RECOMMENDATION", entityId: id,
          before: { status: rec.status },
          after: { status: "APPLIED", appliedCampaignId, dailyBudget: updated.dailyBudget, metaSynced },
        }, tx);
      }, { timeout: 20_000 });
    } else {
      await prisma.recommendation.update({ where: { id }, data: { status: "APPLIED", appliedAt: new Date() } });
      await logAudit({
        actor, action: "RECOMMENDATION_APPLIED", entityType: "RECOMMENDATION", entityId: id,
        before: { status: rec.status }, after: { status: "APPLIED" },
      });
    }
    return { ok: true, status: "APPLIED", appliedCampaignId, metaSynced };
  });
}