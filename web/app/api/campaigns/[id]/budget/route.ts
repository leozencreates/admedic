import { prisma } from "@admedic/database";
import { z } from "zod";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { applyDailyBudgetChange } from "../../../../_lib/budget-change";

export const maxDuration = 30;
/** `dailyBudget` major (insan) birimdir; sunucu cent'e çevirir ve cent ile karşılaştırır (ADR-0011). */
const BudgetSchema = z.object({
  dailyBudget: z.number().min(0.01).max(1_000_000),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

/**
 * Günlük bütçe değişikliği. Azaltma EDIT rolleri için serbesttir; artış yalnızca Owner veya Owner'ın
 * harcama yetkisi verdiği üye tarafından ve toplam aylık üst sınır içinde yapılabilir (spec 3.3/3.6).
 */
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
      // Artış olup olmadığına karar vermeden önce bütçe düzenlemelerini sıraya sok.
      await tx.$queryRaw`SELECT "id" FROM "Campaign"
        WHERE "id" = ${id} AND "workspaceId" = ${actor.workspaceId} FOR UPDATE`;
      const campaign = await tx.campaign.findFirst({
        where: { id, workspaceId: actor.workspaceId, adAccount: { orgId: actor.orgId } },
        include: { adAccount: { select: { currency: true, connectionId: true } } },
      });
      if (!campaign) throw new HttpError(404, "Kampanya bulunamadı.");
      if (campaign.status === "DELETED" || campaign.workflowStatus === "ARCHIVED")
        throw new HttpError(409, "Arşivlenmiş veya silinmiş kampanyanın bütçesi değiştirilemez.");
      if (campaign.budgetType === "LIFETIME" || campaign.lifetimeBudget != null)
        throw new HttpError(409, "Bu uç yalnızca günlük bütçeli kampanyalar içindir.");
      const currentCents = campaign.dailyBudget ?? 0;
      if (dailyBudgetCents === campaign.dailyBudget)
        return { campaign: { id, dailyBudgetCents: currentCents, dailyBudget: currentCents / 100 } };

      const outcome = await applyDailyBudgetChange(tx, actor, campaign, dailyBudgetCents);
      const updated = await tx.campaign.update({
        where: { id },
        data: { dailyBudget: dailyBudgetCents, budgetType: "DAILY", ...(outcome.metaLevel ? { syncedAt: new Date() } : {}) },
      });
      await logAudit({
        actor, action: "CAMPAIGN_BUDGET_CHANGED", entityType: "CAMPAIGN", entityId: id,
        before: { dailyBudgetCents: campaign.dailyBudget, budgetType: campaign.budgetType },
        after: {
          dailyBudgetCents: updated.dailyBudget,
          budgetType: updated.budgetType,
          reason: input.reason ?? null,
          increase: outcome.increase,
          metaLevel: outcome.metaLevel,
          ...(Object.keys(outcome.adSetBudgets).length ? { adSetBudgetsCents: outcome.adSetBudgets } : {}),
        },
      }, tx);
      return {
        campaign: {
          id,
          dailyBudgetCents: updated.dailyBudget,
          dailyBudget: (updated.dailyBudget ?? 0) / 100,
          ...(Object.keys(outcome.adSetBudgets).length ? { adSetBudgetsCents: outcome.adSetBudgets } : {}),
        },
      };
    }, { timeout: 20_000 });
  });
}
