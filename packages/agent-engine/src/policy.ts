import { DEFAULT_ENGINE_SETTINGS } from "@admedic/bayesian-engine";

import type { PolicyGuardrails } from "./types";

const pct = (v: number) => v / 100;

/**
 * DB'deki OptimizationPolicy satırı → guardrail yapısı.
 * Girdi yapısal (structural); Prisma satırını doğrudan kabul eder.
 */
export function fromOptimizationPolicyRow(
  row: Partial<{
    workspaceId: string;
    enabled: boolean;
    mode: string;
    accountDailyMaxCents: number | null;
    accountMonthlyMaxCents: number | null;
    campaignDailyMaxCents: number | null;
    adSetDailyMaxCents: number | null;
    minDailyBudgetCents: number | null;
    maxDailyBudgetCents: number | null;
    maxIncreasePct: number | null;
    maxDecreasePct: number | null;
    maxChangePer24hPct: number | null;
    minHoursBetweenChanges: number | null;
    minSpendBeforeDecisionCents: number | null;
    minPurchasesBeforeScaling: number | null;
    minTestDurationHours: number | null;
    targetRoas: number | null;
    maxCpaCents: number | null;
    stopLossSpendCents: number | null;
    attributionWindowDays: number | null;
  }>,
): PolicyGuardrails {
  const s = DEFAULT_ENGINE_SETTINGS;
  return {
    workspaceId: row.workspaceId ?? "ws_default",
    enabled: row.enabled ?? true,
    mode: (row.mode ?? "APPROVAL") as PolicyGuardrails["mode"],
    accountDailyMaxCents: row.accountDailyMaxCents ?? undefined,
    accountMonthlyMaxCents: row.accountMonthlyMaxCents ?? undefined,
    campaignDailyMaxCents: row.campaignDailyMaxCents ?? undefined,
    adSetDailyMaxCents: row.adSetDailyMaxCents ?? undefined,
    minDailyBudgetCents: row.minDailyBudgetCents ?? 2000,
    maxDailyBudgetCents: row.maxDailyBudgetCents ?? undefined,
    maxIncreasePct: row.maxIncreasePct ?? Math.round(s.maxIncreasePct * 100),
    maxDecreasePct: row.maxDecreasePct ?? Math.round(s.maxDecreasePct * 100),
    maxChangePer24hPct:
      row.maxChangePer24hPct ?? Math.round(s.maxChangePer24hPct * 100),
    minHoursBetweenChanges: row.minHoursBetweenChanges ?? s.cooldownHours,
    minSpendBeforeDecisionCents: row.minSpendBeforeDecisionCents ?? 5000,
    minPurchasesBeforeScaling: row.minPurchasesBeforeScaling ?? 10,
    minTestDurationHours: row.minTestDurationHours ?? s.minRuntimeHours,
    targetRoas: row.targetRoas ?? 4,
    maxCpaCents: row.maxCpaCents ?? undefined,
    stopLossSpendCents: row.stopLossSpendCents ?? undefined,
    attributionWindowDays: row.attributionWindowDays ?? 7,
  };
}

export interface BudgetClampContext {
  currentBudgetCents: number;
  proposedBudgetCents: number;
  policy: PolicyGuardrails;
  /** Son 24 saatte net yakılan budget değişim payı (cents). */
  used24hChangeCents?: number;
}

export interface BudgetClampResult {
  budgetCents: number;
  capped: boolean;
  reason: string | null;
}

/**
 * Guardrail'ler:
 *  1) min günlük bütçe (alt sınır)
 *  2) adset günlük üst limit (policy.adSetDailyMaxCents)
 *  3) kampanya günlük üst limit (policy.campaignDailyMaxCents)
 *  4) global günlük üst limit (policy.maxDailyBudgetCents)
 *  5) tek adım artış %maxIncreasePct
 *  6) tek adım azalış %maxDecreasePct
 *  7) 24 saat içinde %maxChangePer24hPct
 */
export function clampBudgetChange(ctx: BudgetClampContext): BudgetClampResult {
  const { currentBudgetCents: cur, proposedBudgetCents: prop, policy: p } = ctx;
  if (prop <= 0) return { budgetCents: prop, capped: false, reason: null };

  let budget = prop;
  const reasons: string[] = [];

  const min = p.minDailyBudgetCents;
  if (budget < min) {
    budget = min;
    reasons.push(`min_daily_${min}`);
  }

  const caps = [
    p.adSetDailyMaxCents,
    p.campaignDailyMaxCents,
    p.maxDailyBudgetCents,
  ];
  for (const cap of caps) {
    if (cap !== undefined && cap > 0 && budget > cap) {
      budget = cap;
      reasons.push(`max_daily_${cap}`);
    }
  }

  const increaseCap = cur * (1 + pct(p.maxIncreasePct));
  if (budget > increaseCap) {
    budget = Math.max(increaseCap, 0);
    reasons.push(`max_increase_${p.maxIncreasePct}pct`);
  }

  const decreaseFloor = cur * (1 - pct(p.maxDecreasePct));
  if (budget < decreaseFloor) {
    budget = Math.max(decreaseFloor, min);
    reasons.push(`max_decrease_${p.maxDecreasePct}pct`);
  }

  if (ctx.used24hChangeCents !== undefined && ctx.used24hChangeCents > 0) {
    const allowed = Math.max(0, p.maxChangePer24hPct); // yüzde
    const base24h = cur; // son 24h içindeki net değişim cari bütçeyle ölçülür
    const headroom = Math.max(
      0,
      base24h * pct(allowed) - ctx.used24hChangeCents,
    );
    const over = budget - cur;
    if (over > headroom) {
      budget = Math.max(cur, cur + headroom);
      reasons.push(`24h_cap_${p.maxChangePer24hPct}pct`);
    }
  }

  return {
    budgetCents: Math.round(budget),
    capped: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join("+") : null,
  };
}

/** Cooldown: son karardan bu yana minHoursBetweenChanges geçmemişse bloke. */
export function inCooldown(
  lastDecisionAt: Date | undefined,
  now: Date,
  minHours: number,
): boolean {
  if (!lastDecisionAt) return false;
  const diffHours = (now.getTime() - lastDecisionAt.getTime()) / 3_600_000;
  return diffHours < minHours;
}

export function hoursSince(date: Date | undefined, now: Date): number {
  if (!date) return Number.POSITIVE_INFINITY;
  return (now.getTime() - date.getTime()) / 3_600_000;
}

/** Son 24 saatte uygulanmış bütçe değişimlerinin mutlak toplamı. */
export function used24hBudgetChangeCents(
  items: { budgetBeforeCents: number; budgetAfterCents: number }[],
): number {
  let total = 0;
  for (const it of items) {
    total += Math.abs(it.budgetAfterCents - it.budgetBeforeCents);
  }
  return total;
}
