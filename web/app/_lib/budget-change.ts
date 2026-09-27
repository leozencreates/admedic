import { createMetaClient } from "@admedic/meta-api";
import type { Prisma } from "@admedic/database";
import type { Actor } from "./auth";
import { HttpError } from "./http";
import { requireSpendAuthority } from "./spend-authority";
import { assertWithinMonthlyCap } from "./spend-cap";
import { isAdSetBudgetPlan, pushBudgetToMeta, scaleAdSetBudgets } from "./campaign-budget";
import { requireLiveMetaConnection } from "./meta-connection";

/** Meta'da yayında sayılan iş akışı durumları. */
export const PUBLISHED_WORKFLOW_STATUSES: readonly string[] = ["ACTIVE", "PUBLISHED_PAUSED"];

export interface BudgetTarget {
  id: string;
  workflowStatus: string;
  metaCampaignId: string | null;
  dailyBudget: number | null;
  plan: Prisma.JsonValue | null;
  adAccount: { currency: string; connectionId: string | null };
}

export interface BudgetChangeOutcome {
  increase: boolean;
  /** Meta'ya hangi seviyede yazıldı; `null` → Meta'ya yazılmadı (yayında değil ya da Meta'da ad set yok). */
  metaLevel: "campaign" | "adset" | null;
  /** ABO'da yeni ad set payları (minor unit; yerel kayıtlara yazıldı). */
  adSetBudgets: Record<string, number>;
}

/**
 * Günlük bütçe değişikliğinin kurallarını uygular; kampanya satırını kilitlemek, kampanyanın
 * kendisini güncellemek ve denetim kaydı yazmak çağırana aittir.
 * - Artış: harcama yetkisi (Owner veya Owner'ın yetki verdiği üye; spec 3.6) + toplam aylık üst sınır
 *   (diğer aktif kampanyaların aylık toplamı + bu kampanyanın yeni bütçesi × 30; spec 3.3).
 *   Azalış her zaman serbesttir (harcamayı düşürür).
 * - Yayındaysa önce Meta güncellenir (CBO: kampanya, ABO: ad set payları); Meta başarısızsa 502 ve
 *   yerel kayıt değişmez. ABO'da yerel ad set payları yeni toplama göre ölçeklenir.
 */
export async function applyDailyBudgetChange(
  tx: Prisma.TransactionClient,
  actor: Actor,
  campaign: BudgetTarget,
  newCents: number,
  opts: { failureMessage?: string } = {},
): Promise<BudgetChangeOutcome> {
  const currentCents = campaign.dailyBudget ?? 0;
  const increase = newCents > currentCents;
  if (increase) {
    await requireSpendAuthority(actor, tx);
    await assertWithinMonthlyCap(tx, {
      orgId: actor.orgId,
      currency: campaign.adAccount.currency,
      dailyBudgetCents: newCents,
      excludeCampaignId: campaign.id,
    });
  }

  const published = PUBLISHED_WORKFLOW_STATUSES.includes(campaign.workflowStatus);
  if (!published && campaign.metaCampaignId) {
    if (campaign.workflowStatus === "APPROVED")
      throw new HttpError(
        409,
        "Meta yayını yarım kaldı; bütçeyi değiştirmeden önce yayını tamamlayın veya kampanyayı arşivleyin.",
      );
    throw new HttpError(409, "Kampanyanın yayın durumu ile Meta bağlantısı tutarsız.");
  }
  if (published && !campaign.metaCampaignId)
    throw new HttpError(409, "Kampanyanın yayın durumu ile Meta bağlantısı tutarsız.");

  const abo = isAdSetBudgetPlan(campaign.plan);
  const adSets = abo
    ? await tx.adSet.findMany({
        where: { campaignId: campaign.id },
        select: { id: true, metaAdSetId: true, dailyBudget: true },
        orderBy: { createdAt: "asc" },
      })
    : [];
  let metaLevel: BudgetChangeOutcome["metaLevel"] = null;
  if (published && newCents !== currentCents) {
    if (!campaign.adAccount.connectionId) throw new HttpError(400, "Meta bağlantısı yapılandırılmadı.");
    const live = await requireLiveMetaConnection(campaign.adAccount.connectionId, actor.orgId);
    try {
      const pushed = await pushBudgetToMeta({
        meta: createMetaClient(),
        token: live.token,
        metaCampaignId: campaign.metaCampaignId!,
        plan: campaign.plan,
        adSets,
        // Minor unit doğrudan gider; ×100 yok (ADR-0011).
        newDailyCents: newCents,
      });
      metaLevel = pushed.level === "none" ? null : pushed.level;
    } catch {
      throw new HttpError(502, opts.failureMessage ?? "Meta bütçe güncellemesi başarısız. Yerel bütçe değiştirilmedi.");
    }
  }

  const shares = abo ? scaleAdSetBudgets(adSets, newCents) : new Map<string, number>();
  for (const [adSetId, cents] of shares) {
    await tx.adSet.update({
      where: { id: adSetId },
      data: { dailyBudget: cents, ...(metaLevel === "adset" ? { syncedAt: new Date() } : {}) },
    });
  }
  return { increase, metaLevel, adSetBudgets: Object.fromEntries(shares) };
}
