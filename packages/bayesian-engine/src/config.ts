import type { EngineSettings } from "./types";

/**
 * §52 — conservative production varsayılanları.
 * Tümü DB'de OptimizationPolicy altında override edilebilir.
 */
export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  winnerProb: 0.9, // PROBABLE winner
  strongWinnerProb: 0.95,
  veryStrongWinnerProb: 0.99,
  softLoserProb: 0.8,
  strongLoserProb: 0.9,
  pauseBelowBreakevenProb: 0.97,
  extremePauseProb: 0.995,
  evidenceTargetSoft: 1.5,
  evidenceTargetStrong: 2.5,
  evidenceTargetWinner: 2,
  evidenceBreakEvenHard: 3,
  evidenceBreakEvenExtreme: 2,
  zeroConvWarningMultiple: 2.996, // ln(1/0.05) ≈ 2.996
  zeroConvHardMultiple: 4.605, // ln(1/0.01) ≈ 4.605
  minRuntimeHours: 24,
  minMatureHours: 12,
  cooldownHours: 12,
  optimizationIntervalHours: 6,
  explorationPct: 0.15,
  thompsonSamples: 5000,
  thompsonGamma: 1.5,
  maxIncreasePct: 0.2,
  maxDecreasePct: 0.25,
  maxChangePer24hPct: 0.5,
  smoothingEta: 0.5,
  strongRising: 1.15,
  rising: 1.05,
  declining: 0.95,
  strongDeclining: 0.8,
};

export const ATTRIBUTION_MATURITY_DEFAULT = [
  { maxAgeHours: 6, weight: 0.1 },
  { maxAgeHours: 12, weight: 0.25 },
  { maxAgeHours: 24, weight: 0.5 },
  { maxAgeHours: 48, weight: 0.8 },
  { maxAgeHours: Number.POSITIVE_INFINITY, weight: 1.0 },
];