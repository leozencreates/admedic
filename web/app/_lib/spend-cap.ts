import type { Prisma } from "@admedic/database";
import { HttpError } from "./http";
import { formatPlanMoney } from "./campaign-plan";

/** Aylık projeksiyonda kullanılan gün sayısı (günlük bütçe × 30). */
export const MONTH_DAYS = 30;

type BudgetRow = { dailyBudget: number | null; lifetimeBudget: number | null; budgetType: string | null };

/**
 * Bir kampanyanın aylık harcama projeksiyonu (minor unit, ADR-0011). Günlük bütçede ×30; ömür boyu
 * bütçede tamamı (temkinli: kalan süreye yayılmaz).
 */
export function monthlyProjectionCents(row: BudgetRow): number {
  if (row.budgetType === "LIFETIME" || (row.dailyBudget == null && row.lifetimeBudget != null))
    return Math.max(0, row.lifetimeBudget ?? 0);
  return Math.max(0, (row.dailyBudget ?? 0) * MONTH_DAYS);
}

/**
 * Kuruluşun şu an harcama yapabilecek kampanyalarının aylık toplamı: `status=ACTIVE` olan (Admedic'te
 * etkinleştirilen — etkinleştirme sırasında rezerve edilenler dahil — ve Meta senkronuyla aktif görülen)
 * arşivlenmemiş kampanyalar. Kur dönüşümü yapılmaz: yalnızca aynı para birimindeki reklam hesaplarının
 * kampanyaları toplanır.
 */
export async function activeMonthlyCommitmentCents(
  db: Prisma.TransactionClient,
  orgId: string,
  currency: string,
  excludeCampaignId?: string,
): Promise<number> {
  const rows = await db.campaign.findMany({
    where: {
      adAccount: { orgId, currency },
      status: "ACTIVE",
      NOT: { workflowStatus: "ARCHIVED" },
      ...(excludeCampaignId ? { id: { not: excludeCampaignId } } : {}),
    },
    select: { dailyBudget: true, lifetimeBudget: true, budgetType: true },
  });
  return rows.reduce((sum, row) => sum + monthlyProjectionCents(row), 0);
}

export interface MonthlyCapCheck {
  capCents: number | null;
  /** Diğer aktif kampanyaların aylık toplamı. */
  committedCents: number;
  /** Bu işlemin (yeni/taslak kampanyanın) aylık projeksiyonu. */
  projectedCents: number;
  totalCents: number;
  exceeds: boolean;
  currency: string;
}

/**
 * Spec 3.3 kabul kriteri ("toplam bütçe tenant'ın aylık üst limitini aşarsa bloklanır"):
 * aktif kampanyaların aylık toplamı + bu kampanyanın günlük bütçesi × 30, kuruluş üst sınırıyla karşılaştırılır.
 */
export async function checkMonthlyCap(
  db: Prisma.TransactionClient,
  input: {
    orgId: string;
    currency: string;
    dailyBudgetCents: number;
    /** Kendisi toplamda ikinci kez sayılmasın (güncellenen/etkinleştirilen kampanya). */
    excludeCampaignId?: string;
    /** Önceden okunmuş sınır; verilmezse kuruluştan okunur. */
    capCents?: number | null;
  },
): Promise<MonthlyCapCheck> {
  const capCents =
    input.capCents !== undefined
      ? input.capCents
      : (
          await db.organization.findUniqueOrThrow({
            where: { id: input.orgId },
            select: { monthlyAdBudgetCap: true },
          })
        ).monthlyAdBudgetCap;
  const projectedCents = Math.max(0, Math.round(input.dailyBudgetCents)) * MONTH_DAYS;
  if (capCents == null)
    return { capCents: null, committedCents: 0, projectedCents, totalCents: projectedCents, exceeds: false, currency: input.currency };
  const committedCents = await activeMonthlyCommitmentCents(db, input.orgId, input.currency, input.excludeCampaignId);
  const totalCents = committedCents + projectedCents;
  return { capCents, committedCents, projectedCents, totalCents, exceeds: totalCents > capCents, currency: input.currency };
}

export function monthlyCapMessage(check: MonthlyCapCheck): string {
  const fmt = (cents: number) => formatPlanMoney(cents, check.currency);
  const committed = check.committedCents > 0 ? `aktif kampanyalar ${fmt(check.committedCents)} + ` : "";
  return (
    `Aylık bütçe üst sınırı aşılıyor: ${committed}bu kampanya ${fmt(check.projectedCents)} = ` +
    `${fmt(check.totalCents)} > kuruluş sınırı ${fmt(check.capCents ?? 0)}.`
  );
}

export async function assertWithinMonthlyCap(
  db: Prisma.TransactionClient,
  input: Parameters<typeof checkMonthlyCap>[1],
): Promise<MonthlyCapCheck> {
  const check = await checkMonthlyCap(db, input);
  if (check.exceeds) throw new HttpError(422, monthlyCapMessage(check));
  return check;
}
