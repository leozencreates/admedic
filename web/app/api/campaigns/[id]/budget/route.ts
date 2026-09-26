import { prisma } from "@admedic/database";
import { createMetaClient } from "@admedic/meta-api";
import { loadEnv } from "@admedic/config";
import { z } from "zod";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { decrypt } from "../../../../_lib/encrypt";

export const maxDuration = 30;
/** `dailyBudget` major (insan) birimdir; sunucu cent'e çevirir ve cent ile karşılaştırır (ADR-0011). */
const BudgetSchema = z.object({
  dailyBudget: z.number().min(0.01).max(1_000_000),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const input = await body(request, BudgetSchema);
    const dailyBudgetCents = Math.round(input.dailyBudget * 100);
    if (dailyBudgetCents < 1) throw new HttpError(400, "Günlük bütçe en az 0,01 olmalıdır.");
    return prisma.$transaction(async (tx) => {
      // Serialize budget edits before deciding whether this is an increase.
      await tx.$queryRaw`SELECT "id" FROM "Campaign"
        WHERE "id" = ${id} AND "workspaceId" = ${actor.workspaceId} FOR UPDATE`;
      const campaign = await tx.campaign.findFirst({
        where: { id, workspaceId: actor.workspaceId, adAccount: { orgId: actor.orgId } },
        include: { adAccount: { include: { connection: true } } },
      });
      if (!campaign) throw new HttpError(404, "Kampanya bulunamadı.");
      if (campaign.status === "DELETED" || campaign.workflowStatus === "ARCHIVED")
        throw new HttpError(409, "Arşivlenmiş veya silinmiş kampanyanın bütçesi değiştirilemez.");
      if (campaign.budgetType === "LIFETIME" || campaign.lifetimeBudget != null)
        throw new HttpError(409, "Bu uç yalnızca günlük bütçeli kampanyalar içindir.");
      const currentCents = campaign.dailyBudget ?? 0;
      // Bütçe artışı yalnızca OWNER/ADMIN (spec 3.6).
      if (dailyBudgetCents > currentCents)
        requireRole(actor, ["OWNER", "ADMIN"]);
      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId } });
      if (org.monthlyAdBudgetCap != null && dailyBudgetCents * 30 > org.monthlyAdBudgetCap)
        throw new HttpError(422, "Yeni bütçe kuruluşun aylık üst sınırını aşıyor.");
      if (dailyBudgetCents === campaign.dailyBudget)
        return { campaign: { id, dailyBudgetCents: currentCents, dailyBudget: currentCents / 100 } };

      const published = ["ACTIVE", "PUBLISHED_PAUSED"].includes(campaign.workflowStatus);
      if (published !== Boolean(campaign.metaCampaignId))
        throw new HttpError(409, "Kampanyanın yayın durumu ile Meta bağlantısı tutarsız.");
      if (published) {
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
            entityId: campaign.metaCampaignId!,
            // Minor unit doğrudan gider; ×100 yok (ADR-0011).
            dailyBudgetCents,
          }, mock ? "mock-token" : decrypt(conn.tokenCiphertext!));
          if (!result.success) throw new Error("Meta update failed");
        } catch {
          throw new HttpError(502, "Meta bütçe güncellemesi başarısız. Yerel bütçe değiştirilmedi.");
        }
      }
      const updated = await tx.campaign.update({
        where: { id },
        data: { dailyBudget: dailyBudgetCents, budgetType: "DAILY", ...(published ? { syncedAt: new Date() } : {}) },
      });
      await logAudit({
        actor, action: "CAMPAIGN_BUDGET_CHANGED", entityType: "CAMPAIGN", entityId: id,
        before: { dailyBudgetCents: campaign.dailyBudget, budgetType: campaign.budgetType },
        after: { dailyBudgetCents: updated.dailyBudget, budgetType: updated.budgetType, reason: input.reason ?? null },
      }, tx);
      return { campaign: { id, dailyBudgetCents: updated.dailyBudget, dailyBudget: (updated.dailyBudget ?? 0) / 100 } };
    }, { timeout: 20_000 });
  });
}
