import { clamp as clampNumber } from "@admedic/shared";

import type { Posterior } from "./types";
import { gammaSample, makeRng } from "./sampling";

export interface ThompsonArmInput {
  id: string;
  posterior: Posterior;
  currentBudgetMajor: number;
  minBudgetMajor?: number;
  maxBudgetMajor?: number;
  /** Soft-loser cap (ör. 0.1 → maks %10) */
  allocationCapPct?: number;
  saturationFactor?: number;
  fatigueMultiplier?: number;
  /** profit modunda contribution margin (0..1) */
  utilityMargin?: number;
  paused?: boolean;
}

export interface ThompsonAllocationConfig {
  totalBudgetMajor: number;
  epsilon: number; // keşif payı (0.15)
  gamma: number; // konsantrasyon (1.5)
  samples: number; // Monte Carlo (5000)
  seed?: number;
  smoothingEta: number;
  maxIncreasePct: number;
  maxDecreasePct: number;
  minimumBudgetFloor?: number;
  objective: "ROAS" | "PROFIT";
}

export interface ThompsonAllocationResult {
  armId: string;
  probBest: number;
  desiredBudget: number;
  proposedBudget: number;
  share: number;
  clampedToFloor: boolean;
  clampedToCap: boolean;
  smoothed: boolean;
  winner: boolean;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * §35–38 — Monte Carlo Batch Thompson Sampling.
 * Her sim'de her arm posterior'ından ROAS (veya profit utility) örneklenir,
 * argmax sayılır → P_best ≈ Wins/M.
 */
export function batchThompson(
  arms: ThompsonArmInput[],
  config: ThompsonAllocationConfig,
): {
  samples: number;
  counts: Map<string, number>;
  probBest: Map<string, number>;
} {
  const eligible = arms.filter((a) => !a.paused);
  const counts = new Map<string, number>();
  const probBest = new Map<string, number>();
  const rng = makeRng(config.seed);

  for (const a of eligible) counts.set(a.id, 0);

  for (let s = 0; s < config.samples; s++) {
    let bestId: string | null = null;
    let bestUtility = Number.NEGATIVE_INFINITY;

    for (const arm of eligible) {
      const u = sampleUtility(arm, config, rng);
      if (u > bestUtility) {
        bestUtility = u;
        bestId = arm.id;
      }
    }
    if (bestId) counts.set(bestId, (counts.get(bestId) ?? 0) + 1);
  }

  for (const a of eligible) {
    probBest.set(a.id, (counts.get(a.id) ?? 0) / config.samples);
  }

  return { samples: config.samples, counts, probBest };
}

function sampleUtility(arm: ThompsonArmInput, config: ThompsonAllocationConfig, rng: () => number): number {
  const { posterior: p } = arm;
  const lambda = gammaSample(p.a, p.b, rng);
  const rho = Math.max(gammaSample(p.c, p.d, rng), 1e-12);
  const roas = (p.k * lambda) / rho;
  if (config.objective === "PROFIT" && arm.utilityMargin !== undefined) {
    return arm.utilityMargin * roas - 1; // ProfitUtility = M·θ − 1
  }
  return roas;
}

/**
 * §37–43 — P_best ile bütçe dağılımı.
 *   Q_i = P_best^γ · sat · fatigue (normalize)
 *   W_i = ε/K + (1−ε)·Q_i
 * Smoothing: B_smooth = C·(D/C)^η; clamp: [0.75C, 1.20C]
 */
export function allocateBudget(
  arms: ThompsonArmInput[],
  config: ThompsonAllocationConfig,
): ThompsonAllocationResult[] {
  const eligible = arms.filter((a) => !a.paused);
  if (eligible.length === 0) return [];
  const total = config.totalBudgetMajor;
  const K = eligible.length;
  const { probBest } = batchThompson(arms, config);

  // Q_i
  const raw: Map<string, number> = new Map();
  let qSum = 0;
  for (const arm of eligible) {
    const sat = arm.saturationFactor ?? 1;
    const fat = arm.fatigueMultiplier ?? 1;
    const pb = probBest.get(arm.id) ?? 0;
    const q = Math.pow(pb, config.gamma) * sat * fat;
    raw.set(arm.id, q);
    qSum += q;
  }

  const desired = new Map<string, number>();
  for (const arm of eligible) {
    const q = (raw.get(arm.id) ?? 0) / Math.max(qSum, 1e-12);
    const share = config.epsilon / K + (1 - config.epsilon) * q;
    let d = total * share;
    // per-arm alloc cap (soft loser maskesi)
    if (arm.allocationCapPct !== undefined) d = Math.min(d, total * arm.allocationCapPct);
    desired.set(arm.id, d);
  }

  const budgets = waterfillBudget(eligible, desired, config, total);

  const results: ThompsonAllocationResult[] = [];
  for (const arm of eligible) {
    const pb = probBest.get(arm.id) ?? 0;
    const d = desired.get(arm.id) ?? 0;
    const final = budgets.get(arm.id) ?? 0;

    const proposed = round2(final);
    const isWinner = pb >= 0.5 && proposed >= d - 1e-9;

    results.push({
      armId: arm.id,
      probBest: round2(pb),
      desiredBudget: round2(d),
      proposedBudget: proposed,
      share: round2(proposed / Math.max(total, 1e-12)),
      clampedToFloor: proposed <= round2(floorFor(arm, config.minimumBudgetFloor)) + 1e-6,
      clampedToCap: proposed >= round2(capFor(arm, total)) - 1e-6,
      smoothed: arm.currentBudgetMajor > 0 && Math.abs(proposed - round2(d)) > 0.01,
      winner: isWinner,
    });
  }

  return results;
}

function floorFor(arm: ThompsonArmInput, globalFloor?: number): number {
  if (arm.minBudgetMajor !== undefined) return arm.minBudgetMajor;
  if (globalFloor !== undefined) return globalFloor;
  return 0;
}

function capFor(arm: ThompsonArmInput, total: number): number {
  if (arm.maxBudgetMajor !== undefined && arm.allocationCapPct !== undefined) {
    return Math.min(arm.maxBudgetMajor, total * arm.allocationCapPct);
  }
  if (arm.maxBudgetMajor !== undefined) return arm.maxBudgetMajor;
  if (arm.allocationCapPct !== undefined) return total * arm.allocationCapPct;
  return Number.POSITIVE_INFINITY;
}

/**
 * §42–43 — belirlenen hedefleri smoothing (B=C·(D/C)^η) ile yumuşatır,
 * §37 clamp [0.75C, 1.20C] uygular ve toplamı TOTAL'a water-filling ile korur.
 */
function waterfillBudget(
  eligible: ThompsonArmInput[],
  target: Map<string, number>,
  config: ThompsonAllocationConfig,
  total: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const arm of eligible) out.set(arm.id, 0);

  // 1) smoothing + per-arm clamp (cari bütçesi olan arm'larda)
  for (const arm of eligible) {
    const d = target.get(arm.id) ?? 0;
    let b: number;
    if (arm.currentBudgetMajor > 0) {
      const ratio = d / arm.currentBudgetMajor;
      const smoothed = arm.currentBudgetMajor * Math.pow(ratio, config.smoothingEta);
      const lo = arm.currentBudgetMajor * (1 - config.maxDecreasePct);
      const hi = arm.currentBudgetMajor * (1 + config.maxIncreasePct);
      b = clampNumber(smoothed, lo, hi);
    } else {
      b = d;
    }
    out.set(arm.id, b);
  }

  // 2) normalize → TOTAL
  const sum0 = eligible.reduce((s, a) => s + (out.get(a.id) ?? 0), 0);
  if (sum0 > 1e-9) {
    const scale = total / sum0;
    for (const arm of eligible) out.set(arm.id, (out.get(arm.id) ?? 0) * scale);
  }

  // 3) clamp + water-fill (korumalı toplam, iteratif)
  for (let iter = 0; iter < 80; iter++) {
    for (const arm of eligible) {
      const lo = boundLo(arm, config);
      const hi = boundHi(arm, config, total);
      out.set(arm.id, clampNumber(out.get(arm.id) ?? 0, lo, hi));
    }
    const sum = eligible.reduce((s, a) => s + (out.get(a.id) ?? 0), 0);
    const deficit = total - sum;
    if (Math.abs(deficit) < 1e-6) break;

    // headroom'u olan arm'lara (deficit∈{+,−}) orantılı dağıt
    const movers = eligible.filter((arm) => {
      const v = out.get(arm.id) ?? 0;
      return deficit > 0 ? v < boundHi(arm, config, total) - 1e-9 : v > boundLo(arm, config) + 1e-9;
    });
    if (movers.length === 0) break;
    let headroom = 0;
    for (const arm of movers) {
      const v = out.get(arm.id) ?? 0;
      headroom += deficit > 0 ? boundHi(arm, config, total) - v : v - boundLo(arm, config);
    }
    if (headroom < 1e-9) break;
    for (const arm of movers) {
      const v = out.get(arm.id) ?? 0;
      const share = (deficit > 0 ? (boundHi(arm, config, total) - v) : (v - boundLo(arm, config))) / headroom;
      out.set(arm.id, v + deficit * share);
    }
  }

  return out;
}

/**
 * §43 — tek döngü başına hareket sınırı [0.75C, 1.20C] + mutlak floor/cap.
 */
function boundLo(arm: ThompsonArmInput, config: ThompsonAllocationConfig): number {
  const floor = floorFor(arm, config.minimumBudgetFloor);
  if (arm.currentBudgetMajor > 0) {
    return Math.max(floor, arm.currentBudgetMajor * (1 - config.maxDecreasePct));
  }
  return floor;
}

function boundHi(arm: ThompsonArmInput, config: ThompsonAllocationConfig, total: number): number {
  const cap = capFor(arm, total);
  if (arm.currentBudgetMajor > 0) {
    return Math.min(cap, arm.currentBudgetMajor * (1 + config.maxIncreasePct));
  }
  return cap;
}