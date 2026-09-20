import type { PosteriorStats } from "./types";

const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "—");
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** §53 — duraklatma açıklaması. */
export function explainPause(
  action: string,
  stats: PosteriorStats,
  targetRoas: number,
  effectiveSpend: number,
  evidenceMultiplier: number,
): string {
  return [
    `ACTION: ${action}`,
    `Confirmed unprofitable performance`,
    `Observed ROAS: ${f2(stats.expectedRoasBottom)}`,
    `Bayesian Expected ROAS: ${f2(stats.expectedRoas ?? 0)}`,
    `Break-even ROAS: ${f2(stats.breakEvenRoas)}`,
    `Target ROAS: ${f2(targetRoas)}`,
    `Probability ROAS is below break-even: ${pct(stats.probabilityBelowBreakEven)}`,
    `Effective Spend: €${f2(effectiveSpend)}`,
    `Break-even CPA: €${f2(stats.breakEvenCpa)}`,
    `Evidence: ${f2(evidenceMultiplier)}×`,
    `Purchases: 0`,
    `Decision Confidence: HIGH`,
  ].join("\n");
}

/** §54 — scale açıklaması. */
export function explainScale(
  stats: PosteriorStats,
  targetRoas: number,
  currentBudget: number,
  newBudget: number,
  trendLabel: string,
  fatigueLabel: string,
): string {
  return [
    `ACTION: SCALE ${newBudget > currentBudget ? `+${(((newBudget - currentBudget) / Math.max(currentBudget, 1e-9)) * 100).toFixed(0)}%` : ""}`,
    `Observed ROAS: ${f2(stats.expectedRoasBottom)}`,
    `Bayesian Expected ROAS: ${f2(stats.expectedRoas ?? 0)}`,
    `Target: ${f2(targetRoas)}`,

    `Probability ROAS > Target: ${pct(stats.probabilityAboveTarget)}`,
    `P10 ROAS: ${f2(stats.quantiles.p10)}`,
    `Trend: ${trendLabel}`,
    `Fatigue: ${fatigueLabel}`,
    `Current Budget: €${f2(currentBudget)}`,
    `New Budget: €${f2(newBudget)}`,
    ``,
    "This ad set has a strong posterior probability of exceeding the target ROAS. The lower 10% Bayesian credible bound remains above the account's minimum acceptable ROAS, and recent performance is rising.",
  ].join("\n");
}

/** §55 — allocation açıklaması (Thompson). */
export function explainThompson(
  lines: { id: string; probBest: number; budget: number }[],
  total: number,
  epsilon: number,
): string {
  const header = [
    "BUDGET ALLOCATION",
    `Total Daily Budget: €${f2(total)}`,
  ];
  const detail = lines.map(
    (l) => `${l.id}\nProbability Best: ${pct(l.probBest)}\nBudget: €${f2(l.budget)}`,
  );
  return [
    ...header,
    ...detail,
    "",
    `The allocation includes a ${pct(epsilon)} exploration reserve, so lower-confidence arms continue receiving enough traffic to discover potential winners.`,
  ].join("\n");
}