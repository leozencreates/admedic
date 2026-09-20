import { describe, expect, it } from "vitest";

import { allocateBudget, batchThompson } from "../src/thompson";
import { computePosterior } from "../src/posterior";

const NOW = new Date("2026-09-16T12:00:00Z");

function arm(id: string, opts: { spend: number; revenue: number; purchases: number; days?: number; current?: number }) {
  const days = opts.days ?? 7;
  const buckets = [];
  for (let d = 0; d < days; d++) {
    buckets.push({
      ageHours: (d + 1) * 24,
      spendMajor: opts.spend / days,
      revenueMajor: opts.revenue / days,
      purchases: opts.purchases / days,
    });
  }
  const posterior = computePosterior(buckets, {
    cpaPrior: 200,
    aovPrior: 800,
    nPrior: 2,
    mPrior: 2,
    k: 2,
    halfLifeDays: 7,
    timeNow: NOW,
  });
  return { id, posterior, currentBudgetMajor: opts.current ?? 1000 };
}

const TOTAL = 10000;
const CFG = {
  totalBudgetMajor: TOTAL,
  epsilon: 0.15,
  gamma: 1.5,
  samples: 5000,
  seed: 42,
  smoothingEta: 0.5,
  maxIncreasePct: 0.2,
  maxDecreasePct: 0.25,
  objective: "ROAS" as const,
};

describe("batchThompson — Monte Carlo P_best", () => {
  it("güçlü arm çok daha yüksek P_best alır", () => {
    const arms = [
      arm("A", { spend: 1000, revenue: 7000, purchases: 28 }), // ROAS 7
      arm("B", { spend: 1000, revenue: 2500, purchases: 7 }), // ROAS 2.5
      arm("C", { spend: 1000, revenue: 900, purchases: 3 }), // ROAS 0.9
    ];
    const { probBest } = batchThompson(arms, CFG);
    expect(probBest.get("A")!).toBeGreaterThan(0.85);
    expect(probBest.get("A")!).toBeGreaterThan(probBest.get("B")!);
    expect(probBest.get("B")!).toBeGreaterThan(probBest.get("C")!);
    const sum = arms.map((a) => probBest.get(a.id)!).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1, 2);
  });

  it("deterministik: aynı seed aynı sonuç", () => {
    const arms = [arm("A", { spend: 1000, revenue: 5000, purchases: 20 }), arm("B", { spend: 1000, revenue: 2000, purchases: 5 })];
    const a = batchThompson(arms, CFG);
    const b = batchThompson(arms, { ...CFG, seed: 42 });
    expect(a.counts.get("A")).toBe(b.counts.get("A"));
    expect(a.counts.get("B")).toBe(b.counts.get("B"));
  });
});

describe("allocateBudget — Thompson dağılımı", () => {
  it("toplam bütçe (havuz) tam kullanılır (floor/cap/smoothing sonrası)", () => {
    const arms = [
      arm("A", { spend: 1000, revenue: 7000, purchases: 28, current: 4000 }),
      arm("B", { spend: 1000, revenue: 2500, purchases: 7, current: 3000 }),
      arm("C", { spend: 1000, revenue: 900, purchases: 3, current: 3000 }),
    ];
    const res = allocateBudget(arms, CFG);
    const sum = res.reduce((s, r) => s + r.proposedBudget, 0);
    expect(sum).toBeCloseTo(CFG.totalBudgetMajor, 0);
    for (const r of res) expect(r.proposedBudget).toBeGreaterThan(0);
  });

  it("güçlü kazanan dominant payı alır (havuz korunur)", () => {
    const arms = [
      arm("A", { spend: 1000, revenue: 7000, purchases: 28, current: 1000 }),
      arm("B", { spend: 1000, revenue: 2500, purchases: 7, current: 1000 }),
    ];
    const res = allocateBudget(arms, { ...CFG, totalBudgetMajor: 2000 });
    const a = res.find((r) => r.armId === "A")!;
    const b = res.find((r) => r.armId === "B")!;
    expect(a.proposedBudget).toBeGreaterThan(b.proposedBudget);
    expect(a.proposedBudget).toBeGreaterThanOrEqual(0.6 * 2000 - 1);
    expect(a.proposedBudget + b.proposedBudget).toBeCloseTo(2000, 0);
  });

  it("per-arm hareket sınırı ±%20/%25 aşılmaz ve toplam korunur", () => {
    const arms = [
      arm("A", { spend: 1000, revenue: 7000, purchases: 28, current: 200 }),
      arm("B", { spend: 1000, revenue: 2500, purchases: 7, current: 300 }),
      arm("C", { spend: 1000, revenue: 900, purchases: 3, current: 500 }),
    ];
    const res = allocateBudget(arms, { ...CFG, totalBudgetMajor: 1000 });
    const sum = res.reduce((s, r) => s + r.proposedBudget, 0);
    expect(sum).toBeCloseTo(1000, 0);
    for (const r of res) {
      const current = arms.find((a) => a.id === r.armId)!.currentBudgetMajor;
      const delta = current > 0 ? (r.proposedBudget - current) / current : 0;
      expect(delta).toBeLessThanOrEqual(0.2 + 0.02);
      expect(delta).toBeGreaterThanOrEqual(-0.25 - 0.02);
    }
  });

  it("soft-loser allocationCapPct ile sınırlanır (§38 mask)", () => {
    const arms = [
      arm("A", { spend: 1000, revenue: 7000, purchases: 28, current: 1850 }),
      { ...arm("B", { spend: 1000, revenue: 900, purchases: 3, current: 150 }), allocationCapPct: 0.1 },
    ];
    const res = allocateBudget(arms, { ...CFG, totalBudgetMajor: 2000 });
    const b = res.find((r) => r.armId === "B")!;
    expect(b.proposedBudget).toBeLessThanOrEqual(2000 * 0.1 + 1);
  });

  it("paused arm danışlamaya girmez", () => {
    const arms = [
      arm("A", { spend: 1000, revenue: 7000, purchases: 28 }),
      { ...arm("B", { spend: 1000, revenue: 900, purchases: 3 }), paused: true },
    ];
    const res = allocateBudget(arms, CFG);
    expect(res).toHaveLength(1);
    expect(res[0]!.armId).toBe("A");
  });
});