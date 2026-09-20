import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_SETTINGS } from "../src/config";
import { computePosterior, posteriorStats } from "../src/posterior";
import { evaluateScale, scalePctForConfidence } from "../src/scale";
import { evaluateStop, winnerClass } from "../src/stop";

const NOW = new Date("2026-09-16T12:00:00Z");

const BASE_CFG = {
  cpaPrior: 200,
  aovPrior: 800,
  nPrior: 2,
  mPrior: 2,
  k: 2,
  halfLifeDays: 7,
  timeNow: NOW,
};
const SETTINGS = DEFAULT_ENGINE_SETTINGS;

function buckets(totalSpend: number, revenue: number, purchases: number, days = 7): { ageHours: number; spendMajor: number; revenueMajor: number; purchases: number }[] {
  const out: { ageHours: number; spendMajor: number; revenueMajor: number; purchases: number }[] = [];
  const perDay = totalSpend / days;
  const revPerDay = revenue / days;
  const purPerDay = purchases / days;
  for (let d = 0; d < days; d++) {
    out.push({
      ageHours: 24 * (d + 1),
      spendMajor: perDay,
      revenueMajor: revPerDay,
      purchases: purPerDay,
    });
  }
  return out;
}

describe("evaluateStop — durdurma kuralları (§52 pseudo-code)", () => {
  it("tracking anomaly → FREEZE (performans ne olursa olsun)", () => {
    const p = computePosterior(buckets(1000, 2500, 3), BASE_CFG);
    const stats = posteriorStats(p, 4, 0.4);
    const verdict = evaluateStop({
      posterior: p, stats, settings: SETTINGS,
      trackingAnomaly: true,
      zeroPurchases: false,
      minRuntimeReached: true,
      minMatureReached: true,
      consecutiveLoserEvaluations: 1,
    });
    expect(verdict.action).toBe("FREEZE");
    expect(verdict.reasonCode).toBe("FREEZE_TRACKING_ANOMALY");
  });

  it("warm-up bitmeden ASLA kesilmez", () => {
    const p = computePosterior(buckets(1000, 100, 0, 7), BASE_CFG);
    const stats = posteriorStats(p, 4, 0.4);
    const verdict = evaluateStop({
      posterior: p, stats, settings: SETTINGS,
      trackingAnomaly: false,
      zeroPurchases: true,
      minRuntimeReached: false, // < 24h
      minMatureReached: false,
      consecutiveLoserEvaluations: 1,
    });
    expect(verdict.action).toBe("OBSERVE");
    expect(verdict.reasonCode).toBe("OBSERVE_WARM_UP");
  });

  it("zero-conversion: maturedSpend >= 4.605·BE_CPA → PAUSE", () => {
    // purchases = 0, yaşı 72h (tam attribution), spend 5000
    const p = computePosterior(
      [{ ageHours: 72, spendMajor: 5000, revenueMajor: 0, purchases: 0 }],
      BASE_CFG,
    );
    const stats = posteriorStats(p, 4, 0.4);
    // k=2, d=1600, c=5 → expectedAov=2*1600/4=800; BE_CPA = 800/2.5 = 320
    // maturedSpend = 5000 * 2^(-72/168) ≈ 3714 >> 4.605*320 ≈ 1474
    expect(stats.breakEvenCpa).toBeCloseTo(320, 1);
    const verdict = evaluateStop({
      posterior: p, stats, settings: SETTINGS,
      trackingAnomaly: false,
      zeroPurchases: true,
      minRuntimeReached: true,
      minMatureReached: true,
      consecutiveLoserEvaluations: 1,
    });
    expect(verdict.action).toBe("PAUSE");
    expect(verdict.reasonCode).toBe("PAUSE_ZERO_CONVERSION_99");
  });

  it("teyitli kaybeden: probBE≥0.97 && evidence≥3 && 2 ardışık → PAUSE; 1 değerlendirme → PAUSE değil", () => {
    // aştığı volume: posterior kesin ama sınır bandı içinde [0.97, 0.995)
    const p = computePosterior(buckets(3000, 3000, 30), BASE_CFG); // ROAS 1.0
    const stats = posteriorStats(p, 4, 0.4);
    expect(stats.probabilityBelowBreakEven).toBeGreaterThanOrEqual(0.97);
    expect(stats.probabilityBelowBreakEven).toBeLessThan(0.995);
    const verdict = evaluateStop({
      posterior: p, stats, settings: SETTINGS,
      trackingAnomaly: false,
      zeroPurchases: false,
      minRuntimeReached: true,
      minMatureReached: true,
      consecutiveLoserEvaluations: 2,
    });
    expect(verdict.action).toBe("PAUSE");
    expect(verdict.reasonCode).toBe("PAUSE_CONFIRMED_LOSER");

    // yalnızca 1 ardışık değerlendirme → henüz PAUSE yok (downscale yoluna gider)
    const oneShot = evaluateStop({
      posterior: p, stats, settings: SETTINGS,
      trackingAnomaly: false,
      zeroPurchases: false,
      minRuntimeReached: true,
      minMatureReached: true,
      consecutiveLoserEvaluations: 1,
    });
    expect(oneShot.reasonCode).toBe("DOWNSCALE_25_PERCENT");
  });

  it("soft/strong loser → bütçe düşer, ama veri örneği yetersizken PAUSE yok", () => {
    // (a) yetersiz sample: AC için "pause değil" — küçük spend, düşük kanıt
    const weak = computePosterior(buckets(60, 1, 0, 1), BASE_CFG); // çok az veri
    const statsWeak = posteriorStats(weak, 4, 0.4);
    const verdictWeak = evaluateStop({
      posterior: weak, stats: statsWeak, settings: SETTINGS,
      trackingAnomaly: false, zeroPurchases: true,
      minRuntimeReached: true, minMatureReached: true,
      consecutiveLoserEvaluations: 1,
    });
    expect(verdictWeak.action).not.toBe("PAUSE");

    // (b) orta kaybeden: P(ROAS<T)≥0.9 && evidence≥2.5 → −25% downscale
    const loser = computePosterior(buckets(800, 900, 8), BASE_CFG); // ROAS 1.125
    const statsLoser = posteriorStats(loser, 4, 0.4);
    expect(statsLoser.probabilityBelowTarget).toBeGreaterThanOrEqual(0.9);
    const verdictLoser = evaluateStop({
      posterior: loser, stats: statsLoser, settings: SETTINGS,
      trackingAnomaly: false, zeroPurchases: false,
      minRuntimeReached: true, minMatureReached: true,
      consecutiveLoserEvaluations: 1,
    });
    expect(verdictLoser.reasonCode).toBe("DOWNSCALE_25_PERCENT");
    expect(verdictLoser.proposedBudgetPct).toBe(-0.25);
  });
});

describe("evaluateScale — ölçeklendirme", () => {
  it("kabul senaryosu: kazanan A scale edilir (ROAS 7 vs hedef 4)", () => {
    const winner = computePosterior(buckets(10000, 70000, 280), BASE_CFG); // ROAS 7.0, yüksek hacim
    const stats = posteriorStats(winner, 4, 0.4);
    expect(stats.expectedRoas).toBeGreaterThan(5);
    expect(stats.probabilityAboveTarget).toBeGreaterThan(0.95);
    const verdict = evaluateScale({
      stats, settings: SETTINGS,
      trackingAnomaly: false,
      inCooldown: false,
      fatigue: "LOW",
      strongDeclining: false,
      minimumAcceptableRoas: stats.breakEvenRoas,
      consecutivePositiveEvaluations: 2,
    });
    expect(verdict.action).toBe("SCALE");
    expect(verdict.proposedBudgetPct).toBeGreaterThan(0);
  });

  it("güvenli scale: P10 >= minAcceptable koşulu", () => {
    // düşük evidencer: yüksek ROAS ama az satın alma → p10 zayıf olsa bile
    // P10'u çok yüksek olan güçlü kazanan scale alır
    const strong = computePosterior(buckets(5000, 40000, 80), BASE_CFG);
    const stats = posteriorStats(strong, 4, 0.4);
    const verdict = evaluateScale({
      stats, settings: SETTINGS,
      trackingAnomaly: false, inCooldown: false, fatigue: "LOW",
      strongDeclining: false,
      minimumAcceptableRoas: 2.5, // BE
      consecutivePositiveEvaluations: 2,
    });
    expect(verdict.action).toBe("SCALE");
  });

  it("CRITICAL fatigue scale engeller", () => {
    const winner = computePosterior(buckets(1000, 7000, 28), BASE_CFG);
    const stats = posteriorStats(winner, 4, 0.4);
    const verdict = evaluateScale({
      stats, settings: SETTINGS, trackingAnomaly: false, inCooldown: false,
      fatigue: "CRITICAL", strongDeclining: false,
      minimumAcceptableRoas: 2.5, consecutivePositiveEvaluations: 2,
    });
    expect(verdict.action).toBe("NO_ACTION");
    expect(verdict.reasonCode).toBe("NO_SCALE_CRITICAL_FATIGUE");
  });

  it("güven-bazlı scale boyutu tier'e göre artar", () => {
    const s = SETTINGS;
    expect(scalePctForConfidence(0.93, s)).toBeCloseTo(0.1, 6);
    expect(scalePctForConfidence(0.97, s)).toBeCloseTo(0.15, 6);
    expect(scalePctForConfidence(0.999, s)).toBeCloseTo(0.2, 6);
  });
});

describe("winnerClass", () => {
  it("eşikler", () => {
    expect(winnerClass(0.91, SETTINGS)).toBe("PROBABLE");
    expect(winnerClass(0.96, SETTINGS)).toBe("STRONG");
    expect(winnerClass(0.995, SETTINGS)).toBe("VERY_STRONG");
    expect(winnerClass(0.5, SETTINGS)).toBeUndefined();
  });
});