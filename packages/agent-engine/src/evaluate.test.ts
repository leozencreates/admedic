import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_MATURITY_DEFAULT,
  DEFAULT_ENGINE_SETTINGS,
} from "@admedic/bayesian-engine";

import { evaluateAccount, evaluateAdSet } from "./evaluate";
import { fromOptimizationPolicyRow } from "./policy";
import type { AdSetAgentInput } from "./types";

const NOW = new Date("2026-09-16T10:00:00Z");

function baseInput(over: Partial<AdSetAgentInput> = {}): AdSetAgentInput {
  const policy = fromOptimizationPolicyRow({
    workspaceId: "ws_1",
    accountDailyMaxCents: 400000,
  });
  return {
    workspaceId: "ws_1",
    runId: "run_1",
    entityId: "as_mock_1_0",
    targetType: "ADSET",
    currentBudgetCents: 20000,
    status: "ACTIVE",
    policy,
    settings: DEFAULT_ENGINE_SETTINGS,
    posterior: {
      cpaPrior: 25,
      aovPrior: 100,
      k: 2,
      halfLifeDays: 7,
      attributionMaturity: ATTRIBUTION_MATURITY_DEFAULT,
    },
    targetRoas: 4,
    contributionMarginRatio: 0.5,
    minimumAcceptableRoas: 3,
    now: NOW,
    buckets: Array.from({ length: 10 }, (_, i) => ({
      ageHours: 240 - i * 24,
      spendMajor: 120,
      revenueMajor: 660,
      purchases: 9,
    })),
    ...over,
  };
}

describe("evaluateAdSet", () => {
  it("güçlü performans → INCREASE_BUDGET önerisi (onay PENDING, clamp uygulanır)", () => {
    const d = evaluateAdSet(baseInput());
    expect(d.action).toBe("INCREASE_BUDGET");
    expect(d.approval).toBe("PENDING");
    expect(d.proposedBudgetCents).toBeGreaterThan(d.currentBudgetCents);
    expect(d.metrics.bayesianRoas).toBeGreaterThan(d.metrics.targetRoas ?? 0);
    expect(d.metrics.probabilityAboveTarget).toBeGreaterThan(0.9);
  });

  it("zero-conversion + yeterli mature spend → PAUSE önerisi (onay PENDING)", () => {
    const d = evaluateAdSet(
      baseInput({
        buckets: [
          { ageHours: 216, spendMajor: 400, revenueMajor: 0, purchases: 0 },
          { ageHours: 192, spendMajor: 400, revenueMajor: 0, purchases: 0 },
          { ageHours: 168, spendMajor: 500, revenueMajor: 0, purchases: 0 },
          { ageHours: 144, spendMajor: 500, revenueMajor: 0, purchases: 0 },
          { ageHours: 120, spendMajor: 500, revenueMajor: 0, purchases: 0 },
        ],
      }),
    );
    expect(d.action).toBe("PAUSE");
    expect(d.statusAfter).toBe("PAUSED");
    expect(d.proposedBudgetCents).toBe(0);
    expect(d.changePct).toBe(-1);
    expect(d.approval).toBe("PENDING");
  });

  it("cooldown içinde → KEEP (approval NOT_REQUIRED)", () => {
    const d = evaluateAdSet(
      baseInput({ lastDecisionAt: new Date("2026-09-16T08:00:00Z") }), // 2 saat önce
    );
    expect(d.action).toBe("KEEP");
    expect(d.approval).toBe("NOT_REQUIRED");
    expect(d.reason).toContain("cooldown");
  });

  it("min spend altında → KEEP", () => {
    const d = evaluateAdSet(
      baseInput({
        buckets: [
          { ageHours: 96, spendMajor: 0.2, revenueMajor: 0.1, purchases: 0 },
          { ageHours: 48, spendMajor: 0.1, revenueMajor: 0, purchases: 0 },
        ],
      }),
    );
    expect(d.action).toBe("KEEP");
  });

  it("artifact: karar key'i deterministik ve gün bazlı", () => {
    const a = evaluateAdSet(baseInput());
    const b = evaluateAdSet(baseInput());
    expect(a.decisionKey).toBe(b.decisionKey);
    expect(a.decisionKey).toContain("as_mock_1_0");
    expect(a.decisionKey).toContain("adset");
  });
});

describe("evaluateAccount", () => {
  it("projeksiyon ve uyarıları üretir", () => {
    const policy = fromOptimizationPolicyRow({
      workspaceId: "ws_1",
      accountDailyMaxCents: 1000000,
    });
    const winner = baseInput({
      entityId: "as_winner",
      currentBudgetCents: 30000,
    });
    const loser = baseInput({
      entityId: "as_loser",
      currentBudgetCents: 30000,
      buckets: [
        { ageHours: 216, spendMajor: 500, revenueMajor: 0, purchases: 0 },
        { ageHours: 192, spendMajor: 500, revenueMajor: 0, purchases: 0 },
        { ageHours: 168, spendMajor: 600, revenueMajor: 0, purchases: 0 },
        { ageHours: 144, spendMajor: 600, revenueMajor: 0, purchases: 0 },
        { ageHours: 120, spendMajor: 600, revenueMajor: 0, purchases: 0 },
      ],
    });
    const report = evaluateAccount("ws_1", "run_1", [winner, loser], policy, {
      now: NOW,
    });

    expect(report.decisions).toHaveLength(2);
    expect(report.decisions[0]!.action).toBe("INCREASE_BUDGET");
    expect(report.decisions[1]!.action).toBe("PAUSE");
    expect(report.projectedDailySpendCents).toBeGreaterThan(0);
    expect(report.alerts.some((a) => a.type === "WINNER_DETECTED")).toBe(true);
    expect(report.alerts.some((a) => a.type === "ROAS_DROP")).toBe(true);
    expect(report.overBudgetCents).toBe(0);
  });

  it("hesap günlük limit aşımını raporlar", () => {
    const policy = fromOptimizationPolicyRow({
      workspaceId: "ws_1",
      accountDailyMaxCents: 50000,
    });
    // İki ad set de 60.000: kazanan +%10 → 66.000; kaybeden pause → 0; cap 50.000.
    const winner = baseInput({
      entityId: "as_winner",
      currentBudgetCents: 60000,
    });
    const loser = baseInput({
      entityId: "as_loser",
      currentBudgetCents: 60000,
    });
    const report = evaluateAccount("ws_1", "run_1", [winner, loser], policy, {
      now: NOW,
    });

    expect(report.overBudgetCents).toBeGreaterThan(0);
    expect(report.projectedDailySpendCents).toBeGreaterThan(50000);
  });
});
