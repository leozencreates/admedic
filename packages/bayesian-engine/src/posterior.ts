import { BetaPrime } from "./distributions";
import type { ObservationBucket, Posterior, PosteriorConfig, PosteriorStats } from "./types";

const DEFAULT_ATTRIBUTION_MATURITY = [
  { maxAgeHours: 6, weight: 0.1 },
  { maxAgeHours: 12, weight: 0.25 },
  { maxAgeHours: 24, weight: 0.5 },
  { maxAgeHours: 48, weight: 0.8 },
  { maxAgeHours: Number.POSITIVE_INFINITY, weight: 1.0 },
] as const;

export function attributionWeightFor(
  ageHours: number,
  steps: readonly { maxAgeHours: number; weight: number }[],
): number {
  for (const s of steps) {
    if (ageHours <= s.maxAgeHours) return s.weight;
  }
  return steps[steps.length - 1]!.weight;
}

export function timeDecayWeight(ageHours: number, halfLifeDays: number): number {
  return Math.pow(2, -ageHours / (24 * halfLifeDays));
}

/** Purchase value Gamma shape (Method of Moments): k = μ²/σ² */
export function estimatePurchaseValueShape(
  aovMean?: number,
  aovVariance?: number,
  fallback = 2,
): number {
  if (!aovMean || aovMean <= 0) return fallback;
  if (!aovVariance || aovVariance <= 0) return fallback;
  const safeVar = Math.max(aovVariance, aovMean * aovMean * 1e-6);
  return (aovMean * aovMean) / safeVar;
}

/**
 * §17 — weighted posterior:
 *   a = a0 + Σ(w·N),  b = b0 + Σ(w·S)
 *   c = c0 + k·Σ(w·N), d = d0 + Σ(w·R)
 * Priorlar (§12–13):
 *   a0 = nPrior, b0 = nPrior · CPA_prior
 *   c0 = k·mPrior + 1, d0 = AOV_prior · mPrior
 */
export function computePosterior(
  buckets: ObservationBucket[],
  cfg: PosteriorConfig,
): Posterior {
  const nPrior = cfg.nPrior ?? 2;
  const mPrior = cfg.mPrior ?? 2;
  const halfLifeDays = cfg.halfLifeDays ?? 7;
  const maturity = cfg.attributionMaturity ?? DEFAULT_ATTRIBUTION_MATURITY;
  const k = cfg.k ?? estimatePurchaseValueShape(cfg.aovMean, cfg.aovVariance);

  const a0 = nPrior;
  const b0 = nPrior * cfg.cpaPrior;
  const c0 = k * mPrior + 1;
  const d0 = cfg.aovPrior * mPrior;

  let sumWN = 0;
  let sumWS = 0;
  let sumWR = 0;
  let maturedSpend = 0;
  let rawSpend = 0;
  let rawPurchases = 0;
  let rawRevenue = 0;

  for (const bucket of buckets) {
    const wAttr = attributionWeightFor(bucket.ageHours, maturity);
    const wTime = timeDecayWeight(bucket.ageHours, halfLifeDays);
    const w = wTime * wAttr;
    sumWN += w * bucket.purchases;
    sumWS += w * bucket.spendMajor;
    sumWR += w * bucket.revenueMajor;
    if (wAttr >= 1) maturedSpend += wTime * bucket.spendMajor;
    rawSpend += bucket.spendMajor;
    rawPurchases += bucket.purchases;
    rawRevenue += bucket.revenueMajor;
  }

  return {
    a: a0 + sumWN,
    b: b0 + sumWS,
    c: c0 + k * sumWN,
    d: d0 + sumWR,
    k,
    effectiveSpend: sumWS,
    effectivePurchases: sumWN,
    effectiveRevenue: sumWR,
    maturedSpend,
    rawSpend,
    rawPurchases,
    rawRevenue,
  };
}

/**
 * §8–11, §19–20 — posterior istatistikleri.
 * ROAS dağılımı: (k·d/b) · BetaPrime(a, c).
 */
export function posteriorStats(
  p: Posterior,
  targetRoas: number,
  contributionMarginRatio: number,
): PosteriorStats {
  const scale = (p.k * p.d) / p.b;
  const dist = new BetaPrime(p.a, p.c, scale);
  const mean = dist.mean;
  const variance = dist.variance;

  // Break-even ROAS = 1 / M (§18)
  const breakEvenRoas = contributionMarginRatio > 0 ? 1 / contributionMarginRatio : Number.POSITIVE_INFINITY;

  // Posteriorlarda c her zaman > 1 (c0 = k·mPrior+1 garantisi).
  const expectedAov = (p.k * p.d) / (p.c - 1);

  const targetCpa = expectedAov / targetRoas;
  const breakEvenCpa = Number.isFinite(breakEvenRoas)
    ? expectedAov / breakEvenRoas
    : Number.POSITIVE_INFINITY;

  const probabilityBelowTarget = dist.cdf(targetRoas);
  const probabilityBelowBreakEven = Number.isFinite(breakEvenRoas)
    ? dist.cdf(breakEvenRoas)
    : 1;

  return {
    expectedRoas: mean,
    expectedRoasBottom: mean ?? 0,
    sd: variance !== null ? Math.sqrt(variance) : null,
    expectedAov,
    targetCpa,
    breakEvenRoas,
    breakEvenCpa,
    probabilityBelowTarget,
    probabilityAboveTarget: 1 - probabilityBelowTarget,
    probabilityBelowBreakEven,
    evidenceTarget: targetCpa > 0 ? p.effectiveSpend / targetCpa : 0,
    evidenceBreakEven: Number.isFinite(breakEvenCpa) && breakEvenCpa > 0
      ? p.effectiveSpend / breakEvenCpa
      : 0,
    quantiles: {
      p5: dist.quantile(0.05),
      p10: dist.quantile(0.1),
      p50: dist.quantile(0.5),
      p90: dist.quantile(0.9),
      p95: dist.quantile(0.95),
    },
    zeroConversionMaturedSpend: p.maturedSpend,
  };
}