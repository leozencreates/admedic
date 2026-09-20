import type {
  EngineSettings,
  Posterior,
  PosteriorStats,
  StopVerdict,
} from "./types";

export type FatigueLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** §47 — fatigue allocation multiplier (pause nedeni değildir). */
export function fatigueMultiplier(fatigue: FatigueLevel): number {
  switch (fatigue) {
    case "LOW":
      return 1.0;
    case "MEDIUM":
      return 0.9;
    case "HIGH":
      return 0.65;
    case "CRITICAL":
      return 0.3;
  }
}

/** §46 — saturation factor: marginal ROAS hedefle oranlanır. */
export function saturationFactor(marginalRoas: number, targetRoas: number): number {
  const ratio = marginalRoas / targetRoas;
  if (ratio >= 1) return 1.0;
  if (ratio >= 0.9) return 0.75;
  if (ratio >= 0.75) return 0.5;
  return 0.2;
}

/** §48 — trend oranından sinyal. TR = recentExpected / baselineExpected. */
export function classifyTrendRatio(
  ratio: number,
  s: Pick<EngineSettings, "strongRising" | "rising" | "declining" | "strongDeclining">,
): { label: "STRONG_RISING" | "RISING" | "STABLE" | "DECLINING" | "STRONG_DECLINING"; strongDeclining: boolean } {
  if (ratio >= s.strongRising) return { label: "STRONG_RISING", strongDeclining: false };
  if (ratio >= s.rising) return { label: "RISING", strongDeclining: false };
  if (ratio <= s.strongDeclining) return { label: "STRONG_DECLINING", strongDeclining: true };
  if (ratio <= s.declining) return { label: "DECLINING", strongDeclining: false };
  return { label: "STABLE", strongDeclining: false };
}

export interface StopInput {
  posterior: Posterior;
  stats: PosteriorStats;
  settings: EngineSettings;
  /** tracking bozukluğu (pixel, insight kesilmesi vb.) */
  trackingAnomaly: boolean;
  /** net (raw) purchases = 0 */
  zeroPurchases: boolean;
  minRuntimeReached: boolean;
  minMatureReached: boolean;
  /** ardışık loser evaluation sayısı (§29) */
  consecutiveLoserEvaluations: number;
  /** mutlak stop-loss (contribution loss) */
  absoluteLoss?: number;
  maxAbsoluteLoss?: number;
}

/**
 * §50 — exact stop logic.
 * Sıra önemlidir: anomaly → absolute stop loss → warm-up → zero-conversion → Bayesian.
 */
export function evaluateStop(input: StopInput): StopVerdict {
  const { posterior, stats, settings: s } = input;

  // §28 — veri anomalisi performans kararını override eder
  if (input.trackingAnomaly) {
    return { action: "FREEZE", reasonCode: "FREEZE_TRACKING_ANOMALY", proposedBudgetPct: 0 };
  }

  // §27 — mutlak stop loss: posterior ne derse desin
  if (input.absoluteLoss !== undefined && input.maxAbsoluteLoss !== undefined) {
    if (input.absoluteLoss >= input.maxAbsoluteLoss) {
      return { action: "PAUSE", reasonCode: "PAUSE_ABSOLUTE_STOP_LOSS", proposedBudgetPct: -100 };
    }
  }

  // §21 — warm-up asla kesilmesin
  if (!input.minRuntimeReached || !input.minMatureReached) {
    return { action: "OBSERVE", reasonCode: "OBSERVE_WARM_UP", proposedBudgetPct: 0 };
  }

  // §26 — zero-conversion kuralları (formül-spend bazlı, hard-code € kullanma)
  if (input.zeroPurchases) {
    const hard = s.zeroConvHardMultiple * stats.breakEvenCpa;
    const soft = s.zeroConvWarningMultiple * stats.targetCpa;
    if (posterior.maturedSpend >= hard) {
      return { action: "PAUSE", reasonCode: "PAUSE_ZERO_CONVERSION_99", proposedBudgetPct: -100 };
    }
    if (posterior.maturedSpend >= soft) {
      return { action: "DOWNSCALE", reasonCode: "DOWNSCALE_ZERO_CONVERSION_95", proposedBudgetPct: -0.15 };
    }
  }

  // §24 — extreme confidence stop (2 evaluation beklemez)
  if (stats.probabilityBelowBreakEven >= s.extremePauseProb && stats.evidenceBreakEven >= s.evidenceBreakEvenExtreme) {
    return { action: "PAUSE", reasonCode: "PAUSE_EXTREME_CONFIDENCE", proposedBudgetPct: -100 };
  }

  // §23/24 — confirmed loser pause (2 ardışık değerlendirme gerektirir)
  if (
    stats.probabilityBelowBreakEven >= s.pauseBelowBreakevenProb &&
    stats.evidenceBreakEven >= s.evidenceBreakEvenHard &&
    input.consecutiveLoserEvaluations >= 2
  ) {
    return { action: "PAUSE", reasonCode: "PAUSE_CONFIRMED_LOSER", proposedBudgetPct: -100 };
  }

  // §23 — strong loser: medium downscale −25%
  if (stats.probabilityBelowTarget >= s.strongLoserProb && stats.evidenceTarget >= s.evidenceTargetStrong) {
    return { action: "DOWNSCALE", reasonCode: "DOWNSCALE_25_PERCENT", proposedBudgetPct: -0.25 };
  }

  // §22 — soft loser: −15%
  if (stats.probabilityBelowTarget >= s.softLoserProb && stats.evidenceTarget >= s.evidenceTargetSoft) {
    return { action: "DOWNSCALE", reasonCode: "DOWNSCALE_15_PERCENT", proposedBudgetPct: -0.15 };
  }

  return { action: "OBSERVE", reasonCode: "KEEP_RUNNING", proposedBudgetPct: 0 };
}

/** §31 — winner sınıflandırması. */
export function winnerClass(
  probabilityAboveTarget: number,
  s: Pick<EngineSettings, "winnerProb" | "strongWinnerProb" | "veryStrongWinnerProb">,
): "PROBABLE" | "STRONG" | "VERY_STRONG" | undefined {
  if (probabilityAboveTarget >= s.veryStrongWinnerProb) return "VERY_STRONG";
  if (probabilityAboveTarget >= s.strongWinnerProb) return "STRONG";
  if (probabilityAboveTarget >= s.winnerProb) return "PROBABLE";
  return undefined;
}