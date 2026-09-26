import { prisma } from "@admedic/database";
import { createMetaClient } from "@admedic/meta-api";
import { loadEnv } from "@admedic/config";
import { EDIT_ROLES, requireActor, requireRole } from "../../../../_lib/auth";
import { body, HttpError, respond, sameOrigin } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { decrypt } from "../../../../_lib/encrypt";
import { isApplicableRecommendation, recommendationKind } from "../../../../_lib/recommendation-kinds";
import { z } from "zod";

export const maxDuration = 15;
const ApplySchema = z.object({ campaignId: z.string().min(1).max(64).optional() }).strict();

/**
 * Onaylanmış (APPROVED) öneriyi hedef kampanyaya uygular. Bütçe her zaman minor unit (ADR-0011):
 * BUDGET_INCREASE → ×1.2 (OWNER/ADMIN; spec 3.6), BUDGET_REALLOCATION → kazanan payı (%70),
 * BUDGET_DECREASE → −pct. Hedef kampanya `action.campaignId` (veya istek gövdesinde açıkça
 * verilen `campaignId`); ilk kampanyaya düşme yoktur.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const hasJson = request.headers.get("content-type")?.startsWith("application/json") ?? false;
    const input: z.infer<typeof ApplySchema> = hasJson ? await body(request, ApplySchema) : {};
    const rec = await prisma.recommendation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!rec) throw new HttpError(404, "Öneri bulunamadı.");
    if (rec.status === "APPLIED") throw new HttpError(409, "Bu öneri zaten uygulanmış.");
    if (rec.status !== "APPROVED")
      throw new HttpError(409, "Öneri uygulanmadan önce onaylanmalı (OWNER/ADMIN).");

    const action = ((rec.action as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    const kind = recommendationKind(rec);
    if (!isApplicableRecommendation(kind))
      throw new HttpError(422, `Bu öneri türü otomatik uygulanamaz (${kind}); değerlendirme notu olarak kalır.`);
    if (kind === "BUDGET_INCREASE") requireRole(actor, ["OWNER", "ADMIN"]);

    const targetCampaignId =
      (typeof action.campaignId === "string" && action.campaignId.trim()) || input.campaignId?.trim() || null;
    if (!targetCampaignId) throw new HttpError(422, "Uygulanacak kampanya belirtilmedi (action.campaignId).");

    let metaSynced = false;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Campaign"
        WHERE "id" = ${targetCampaignId} AND "workspaceId" = ${actor.workspaceId} FOR UPDATE`;
      const campaign = await tx.campaign.findFirst({
        where: { id: targetCampaignId, workspaceId: actor.workspaceId, adAccount: { orgId: actor.orgId } },
        include: { adAccount: { include: { connection: true } } },
      });
      if (!campaign) throw new HttpError(404, "Kampanya bulunamadı.");
      if (campaign.workflowStatus === "ARCHIVED") throw new HttpError(409, "Arşivlenmiş kampanyaya uygulanamaz.");
      const currentCents = campaign.dailyBudget;
      if (currentCents === null || currentCents === undefined || currentCents <= 0)
        throw new HttpError(422, "Kampanyanın günlük bütçesi tanımlı değil; önce bütçe girin.");

      let newCents: number;
      if (kind === "BUDGET_INCREASE") {
        newCents = Math.round(currentCents * 1.2);
      } else if (kind === "BUDGET_REALLOCATION") {
        const split = Number((action.budgetSplit as unknown[] | undefined)?.[0] ?? 70);
        if (!Number.isFinite(split) || split <= 0 || split > 100)
          throw new HttpError(422, "Bütçe dağıtım oranı geçersiz.");
        newCents = Math.round((currentCents * split) / 100);
      } else {
        const pct = Number(action.pct ?? 20);
        if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) throw new HttpError(422, "Bütçe azaltma oranı geçersiz.");
        newCents = Math.round(currentCents * (1 - pct / 100));
      }
      if (newCents < 1) throw new HttpError(422, "Bütçe çok küçük.");
      if (newCents > currentCents) {
        requireRole(actor, ["OWNER", "ADMIN"]);
        const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { monthlyAdBudgetCap: true } });
        if (org.monthlyAdBudgetCap != null && newCents * 30 > org.monthlyAdBudgetCap)
          throw new HttpError(422, "Yeni bütçe kuruluşun aylık üst sınırını aşıyor.");
      }

      const published = ["ACTIVE", "PUBLISHED_PAUSED"].includes(campaign.workflowStatus ?? "");
      if (published && campaign.metaCampaignId && newCents !== currentCents) {
        const conn = campaign.adAccount.connection;
        if (!conn || conn.orgId !== actor.orgId || conn.status !== "CONNECTED" ||
            (conn.expiresAt && conn.expiresAt <= new Date()))
          throw new HttpError(400, "Meta bağlantısı aktif değil.");
        const mock = loadEnv().META_MOCK_MODE;
        if (!mock && !conn.tokenCiphertext) throw new HttpError(400, "Meta erişim token'ı bulunamadı.");
        try {
          const meta = await createMetaClient().updateBudget(
            { entityType: "campaign", entityId: campaign.metaCampaignId, dailyBudgetCents: newCents },
            mock ? "mock-token" : decrypt(conn.tokenCiphertext!),
          );
          if (!meta.success) throw new Error("Meta update failed");
          metaSynced = true;
        } catch {
          throw new HttpError(502, "Meta bütçe güncellemesi başarısız. Bütçe değiştirilmedi.");
        }
      }

      const updated = await tx.campaign.update({
        where: { id: campaign.id },
        data: { dailyBudget: newCents, budgetType: "DAILY", ...(metaSynced ? { syncedAt: new Date() } : {}) },
      });
      const now = new Date();
      const applied = await tx.recommendation.updateMany({
        where: { id, workspaceId: actor.workspaceId, status: "APPROVED" },
        data: {
          status: "APPLIED",
          appliedAt: now,
          action: { ...action, campaignId: campaign.id, appliedCampaignId: campaign.id, appliedDailyBudgetCents: newCents },
        },
      });
      if (!applied.count) throw new HttpError(409, "Öneri bu sırada değişti; sayfayı yenileyin.");
      await logAudit(
        {
          actor,
          action: "RECOMMENDATION_APPLIED",
          entityType: "RECOMMENDATION",
          entityId: id,
          before: { status: rec.status, campaignId: campaign.id, dailyBudgetCents: currentCents },
          after: { status: "APPLIED", campaignId: campaign.id, dailyBudgetCents: updated.dailyBudget, metaSynced, kind },
        },
        tx,
      );
      return { campaignId: campaign.id, previousDailyBudgetCents: currentCents, dailyBudgetCents: updated.dailyBudget };
    }, { timeout: 20_000 });

    return { ok: true, status: "APPLIED", appliedCampaignId: result.campaignId, ...result, metaSynced };
  });
}
