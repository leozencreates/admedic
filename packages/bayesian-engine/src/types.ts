import type { AgentTargetType, TrendDirection } from "@admedic/shared";

/** Zaman ağırlıklandırılmış gözlem kovası (örn. bir gün). */
export interface ObservationBucket {
  ageHours: number; // şimdiden geriye saat cinsinden
  spendMajor: number; // harcama (büyük/birim)
  revenueMajor: number; // conversion value (büyük/birim)
  purchases: number;
}

export interface AttributionMaturityStep {
  maxAgeHours: number; // bu saatten küçük yaşlar bu ağırlığı alır
  weight: number;
}

export interface PosteriorConfig {
  /** Historical CPA prior (büyük/birim) */
  cpaPrior: number;
  /** Historical Average Order Value prior (büyük/birim) */
  aovPrior: number;
  /** Prior eşdeğer purchase sayısı (λ) — default 2 */
  nPrior?: number;
  /** Prior eşdeğer purchase sayısı (ρ) — default 2 */
  mPrior?: number;
  /** Historical AOV dağılımı → k shape tahmini (MoM) */
  aovMean?: number;
  aovVariance?: number;
  /** k override (purchase value gamma shape) */
  k?: number;
  /** time-decay yarı ömrü (gün) — default 7 */
  halfLifeDays?: number;
  /** attribution olgunluk adımları (saat → ağırlık) */
  attributionMaturity?: AttributionMaturityStep[];
  /** referans "şimdi" (test için) */
  timeNow?: Date;
}

export interface Posterior {
  a: number;
  b: number;
  c: number;
  d: number;
  k: number;
  /** Σ w·S */
  effectiveSpend: number;
  /** Σ w·N */
  effectivePurchases: number;
  /** Σ w·R */
  effectiveRevenue: number;
  /** Attribution tam olgunluğa ulaşmış (w_attr=1) harcama (w_time ile) */
  maturedSpend: number;
  rawSpend: number;
  rawPurchases: number;
  rawRevenue: number;
}

export interface PosteriorStats {
  /** Bayesian expected ROAS = a·k·d / (b·(c−1)) */
  expectedRoas: number | null;
  expectedRoasBottom: number; // null yerine 0
  sd: number | null;
  /** Bayesian expected AOV = k·d/(c−1) */
  expectedAov: number;
  targetCpa: number;
  breakEvenRoas: number;
  breakEvenCpa: number;
  /** P(ROAS < T) = I_{x}(a,c); x = z/(1+z), z = Tb/(kd) */
  probabilityBelowTarget: number;
  probabilityAboveTarget: number;
  probabilityBelowBreakEven: number;
  /** Finansal kanıt skorları (§20) */
  evidenceTarget: number;
  evidenceBreakEven: number;
  quantiles: { p5: number; p10: number; p50: number; p90: number; p95: number };
  /** weight ortalamasıyla güncel effective mature spend */
  zeroConversionMaturedSpend: number;
}

export interface EngineSettings {
  /** P(winner) eşikleri */
  winnerProb: number;
  strongWinnerProb: number;
  veryStrongWinnerProb: number;
  /** loser eşikleri */
  softLoserProb: number;
  strongLoserProb: number;
  pauseBelowBreakevenProb: number;
  extremePauseProb: number;
  /** kanıt eşikleri */
  evidenceTargetSoft: number;
  evidenceTargetStrong: number;
  evidenceTargetWinner: number;
  evidenceBreakEvenHard: number;
  evidenceBreakEvenExtreme: number;
  /** zero-conversion multiplier'ları */
  zeroConvWarningMultiple: number; // 2.996
  zeroConvHardMultiple: number; // 4.605
  /** zaman kuralları */
  minRuntimeHours: number;
  minMatureHours: number;
  cooldownHours: number;
  optimizationIntervalHours: number;
  /** keşif/sömürü */
  explorationPct: number;
  thompsonSamples: number;
  thompsonGamma: number;
  /** değişim sınırları */
  maxIncreasePct: number; // 0.20
  maxDecreasePct: number; // 0.25
  maxChangePer24hPct: number; // 0.50
  smoothingEta: number; // 0.5
  /** trend eşikleri */
  strongRising: number; // 1.15
  rising: number; // 1.05
  declining: number; // 0.95
  strongDeclining: number; // 0.80
}

export type StopReasonCode =
  | "FREEZE_TRACKING_ANOMALY"
  | "PAUSE_ABSOLUTE_STOP_LOSS"
  | "OBSERVE_WARM_UP"
  | "PAUSE_ZERO_CONVERSION_99"
  | "DOWNSCALE_ZERO_CONVERSION_95"
  | "PAUSE_EXTREME_CONFIDENCE"
  | "PAUSE_CONFIRMED_LOSER"
  | "DOWNSCALE_25_PERCENT"
  | "DOWNSCALE_15_PERCENT"
  | "KEEP_RUNNING";

export type ScaleReasonCode =
  | "NO_SCALE_TRACKING_ANOMALY"
  | "NO_SCALE_COOLDOWN"
  | "NO_SCALE_CRITICAL_FATIGUE"
  | "NO_SCALE_STRONG_DECLINING"
  | "NO_SCALE_INSUFFICIENT_EVIDENCE"
  | "SCALE_CONFIDENCE_TIER"
  | "SCALE_THOMPSON_ALLOCATE";

export type AgentActionValue = "NO_ACTION" | "SCALE" | "DOWNSCALE" | "PAUSE" | "FREEZE" | "ALLOCATE";

export interface StopVerdict {
  action: "FREEZE" | "PAUSE" | "DOWNSCALE" | "OBSERVE";
  reasonCode: StopReasonCode;
  proposedBudgetPct: number; // −0.15 / −0.25 ... (scale yoksa 0)
}

export interface ScaleVerdict {
  action: "SCALE" | "NO_ACTION";
  reasonCode: ScaleReasonCode;
  proposedBudgetPct: number; // +0.10 / +0.15 / +0.20
  winnerClass?: "PROBABLE" | "STRONG" | "VERY_STRONG";
}

export type EntityState =
  | "NEW"
  | "LEARNING"
  | "STABLE"
  | "PROBABLE_WINNER"
  | "STRONG_WINNER"
  | "SOFT_LOSER"
  | "STRONG_LOSER"
  | "PAUSED"
  | "FROZEN"
  | "COOLDOWN";

/** §57 — OptimizationDecision (agent-engine tarafından tamamlanır). */
export type OptimizationDecision = {
  entityId: string;
  entityType: AgentTargetType;
  action: AgentActionValue;
  reasonCode: StopReasonCode | ScaleReasonCode | "THOMPSON_ALLOCATE" | string;
  currentBudget?: number;
  proposedBudget?: number;
  observedRoas: number;
  expectedBayesianRoas: number | null;
  roasP10: number;
  roasP50: number;
  roasP90: number;
  targetRoas: number;
  breakEvenRoas: number;
  probabilityAboveTarget: number;
  probabilityBelowBreakEven: number;
  evidenceTarget: number;
  evidenceBreakEven: number;
  trend: TrendDirection;
  fatigue: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: number;
  explanation: string;
  algorithmVersion: string;
  policyVersion: string;
};