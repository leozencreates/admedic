import type {
  EngineSettings,
  PosteriorStats,
  ScaleVerdict,
} from "./types";
import type { FatigueLevel } from "./stop";
import { winnerClass } from "./stop";

export interface ScaleInput {
  stats: PosteriorStats;
  settings: EngineSettings;
  trackingAnomaly: boolean;
  inCooldown: boolean;
  fatigue: FatigueLevel;
  strongDeclining: boolean;
  /** risk duyarlıdır: P10 >= minimumAcceptableRoas kontrolü */
  minimumAcceptableRoas: number;
  consecutivePositiveEvaluations: number;
}

/**
 * §44 — güven bazlı ölçeklendirme boyutu (configurable eşikler).
 */
export function scalePctForConfidence(
  probabilityAboveTarget: number,
  s: Pick<EngineSettings, "winnerProb" | "strongWinnerProb" | "veryStrongWinnerProb" | "maxIncreasePct">,
): number {
  if (probabilityAboveTarget >= s.veryStrongWinnerProb) return Math.min(0.2, s.maxIncreasePct);
  if (probabilityAboveTarget >= s.strongWinnerProb) return Math.min(0.15, s.maxIncreasePct);
  if (probabilityAboveTarget >= s.winnerProb) return Math.min(0.1, s.maxIncreasePct);
  return 0;
}

/**
 * §51 — exact scale logic.
 * Güvenlik: anomaly / cooldown / critical fatigue / strong-declining → NO_SCALE.
 */
export function evaluateScale(input: ScaleInput): ScaleVerdict {
  const { stats, settings: s } = input;

  if (input.trackingAnomaly) {
    return { action: "NO_ACTION", reasonCode: "NO_SCALE_TRACKING_ANOMALY", proposedBudgetPct: 0 };
  }
  if (input.inCooldown) {
    return { action: "NO_ACTION", reasonCode: "NO_SCALE_COOLDOWN", proposedBudgetPct: 0 };
  }
  if (input.fatigue === "CRITICAL") {
    return { action: "NO_ACTION", reasonCode: "NO_SCALE_CRITICAL_FATIGUE", proposedBudgetPct: 0 };
  }
  if (input.strongDeclining) {
    return { action: "NO_ACTION", reasonCode: "NO_SCALE_STRONG_DECLINING", proposedBudgetPct: 0 };
  }

  const pct = scalePctForConfidence(stats.probabilityAboveTarget, s);
  const wc = winnerClass(stats.probabilityAboveTarget, s);

  if (
    stats.probabilityAboveTarget >= s.winnerProb &&
    stats.evidenceTarget >= s.evidenceTargetWinner &&
    stats.quantiles.p10 >= input.minimumAcceptableRoas &&
    pct > 0
  ) {
    return {
      action: "SCALE",
      reasonCode: "SCALE_CONFIDENCE_TIER",
      proposedBudgetPct: pct,
      winnerClass: wc,
    };
  }

  return { action: "NO_ACTION", reasonCode: "NO_SCALE_INSUFFICIENT_EVIDENCE", proposedBudgetPct: 0 };
}