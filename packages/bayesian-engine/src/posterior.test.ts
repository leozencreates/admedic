import { describe, expect, it } from "vitest";

import { BetaPrime, betainc } from "../src/index";
import { computePosterior, posteriorStats } from "../src/posterior";

const BUCKET_NOW = new Date("2026-09-16T12:00:00Z");

function hour(h: number): number {
  return h; // ageHours = yaş (saat); BUCKET_NOW referansı yalnızca timeNow parametresi için
}

describe("computePosterior — conjugate güncelleme", () => {
  it("tek bucket tam ağırlıklı posterior güncellemesi", () => {
    const p = computePosterior(
      [
        {
          ageHours: hour(1),
          spendMajor: 100,
          revenueMajor: 300,
          purchases: 3,
        },
      ],
      {
        cpaPrior: 200,
        aovPrior: 800,
        nPrior: 2,
        mPrior: 2,
        k: 2,
        halfLifeDays: 7,
        timeNow: BUCKET_NOW,
      },
    );
    // 1 saatlik bucket attribution ağırlığı 0.1, time-decay ≈ 0.996
    const w = Math.pow(2, -1 / 168) * 0.1;
    expect(p.a).toBeCloseTo(2 + 3 * w, 6);
    expect(p.b).toBeCloseTo(400 + 100 * w, 6);
    expect(p.c).toBeCloseTo(5 + 2 * 3 * w, 6);
    expect(p.d).toBeCloseTo(1600 + 300 * w, 6);
    expect(p.k).toBe(2);
  });

  it("attribution olgunluk adımları ve time decay", () => {
    const p = computePosterior(
      [
        { ageHours: 2, spendMajor: 100, revenueMajor: 300, purchases: 3 },
        { ageHours: 96, spendMajor: 100, revenueMajor: 300, purchases: 3 },
      ],
      {
        cpaPrior: 200,
        aovPrior: 800,
        nPrior: 2,
        mPrior: 2,
        k: 2,
        halfLifeDays: 7,
        timeNow: BUCKET_NOW,
      },
    );
    // age=2: wAttr=0.1, wTime=2^(-2/168) → w≈0.0992
    // age=96: wAttr=1.0, wTime=2^(-96/168) → w≈0.6729
    const wNew = 0.1 * Math.pow(2, -2 / 168);
    const wOld = 1.0 * Math.pow(2, -96 / 168);
    expect(p.effectivePurchases).toBeCloseTo(3 * wNew + 3 * wOld, 6);
    expect(p.maturedSpend).toBeCloseTo(100 * wOld, 6); // yalnızca tam attribution
  });
});

describe("posteriorStats — formüller", () => {
  it("E[ROAS] = a·k·d / (b·(c−1))", () => {
    const p = computePosterior(
      [
        { ageHours: hour(1), spendMajor: 100, revenueMajor: 300, purchases: 3 },
      ],
      { cpaPrior: 200, aovPrior: 800, nPrior: 2, mPrior: 2, k: 2, timeNow: BUCKET_NOW },
    );
    const stats = posteriorStats(p, 4, 0.4);
    expect(stats.expectedRoas).toBeCloseTo(
      (p.a * p.k * p.d) / (p.b * (p.c - 1)),
      6,
    );
  });

  it("P(ROAS < T) = I_x(a,c), x = z/(1+z), z = Tb/(kd)", () => {
    const p = computePosterior(
      [{ ageHours: hour(72), spendMajor: 800, revenueMajor: 2300, purchases: 6 }],
      { cpaPrior: 200, aovPrior: 800, nPrior: 2, mPrior: 2, k: 2, timeNow: BUCKET_NOW },
    );
    const T = 4;
    const z = (T * p.b) / (p.k * p.d);
    const x = z / (1 + z);
    const stats = posteriorStats(p, T, 0.4);
    expect(stats.probabilityBelowTarget).toBeCloseTo(betainc(x, p.a, p.c), 6);
    expect(stats.probabilityAboveTarget).toBeCloseTo(1 - stats.probabilityBelowTarget, 6);
  });

  it("break-even ROAS = 1/M", () => {
    const p = computePosterior([], { cpaPrior: 200, aovPrior: 800 });
    const stats = posteriorStats(p, 4, 0.4);
    expect(stats.breakEvenRoas).toBeCloseTo(2.5, 6);
    expect(stats.probabilityBelowBreakEven).toBeGreaterThanOrEqual(0);
    expect(stats.probabilityBelowBreakEven).toBeLessThanOrEqual(1);
  });

  it("prior ile bile c>1, E[ROAS] sonlu", () => {
    const p = computePosterior([], { cpaPrior: 200, aovPrior: 800, nPrior: 2, mPrior: 2, k: 2 });
    const stats = posteriorStats(p, 4, 0.4);
    expect(p.c).toBeGreaterThan(1);
    expect(stats.expectedRoas).not.toBeNull();
    expect(stats.expectedRoas).toBeCloseTo((p.a * p.k * p.d) / (p.b * (p.c - 1)), 6);
  });
});

describe("BetaPrime quantile & variance", () => {
  it("mean & variance kapalı form", () => {
    const dist = new BetaPrime(2, 5, 1);
    expect(dist.mean).toBeCloseTo(0.5, 6); // a/(c-1)
    expect(dist.variance).toBeCloseTo(0.25, 6); // a(a+c-1)/((c-1)^2(c-2))
  });

  it("quantile monotonic", () => {
    const dist = new BetaPrime(4, 9, 3);
    expect(dist.quantile(0.05)).toBeLessThan(dist.quantile(0.5));
    expect(dist.quantile(0.5)).toBeLessThan(dist.quantile(0.95));
  });
});