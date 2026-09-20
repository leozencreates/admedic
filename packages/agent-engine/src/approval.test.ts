import { describe, expect, it, vi } from "vitest";
import {
  AdmedicError,
  type AgentDecisionAction,
  type ApprovalStatus,
} from "@admedic/shared";
import {
  ATTRIBUTION_MATURITY_DEFAULT,
  DEFAULT_ENGINE_SETTINGS,
} from "@admedic/bayesian-engine";

import {
  SPEND_AFFECTING_ACTIONS,
  STATUS_AFFECTING_ACTIONS,
  buildExecutionPlan,
  requiredApproval,
} from "./approval";
import { executePlan } from "./executor";
import { evaluateAdSet } from "./evaluate";
import { fromOptimizationPolicyRow } from "./policy";
import type { AgentDecisionOut } from "./types";

const approvedEvidence = {
  status: "APPROVED" as ApprovalStatus,
  approvedByUserId: "user_owner_1",
  approvedAt: new Date("2026-09-16T10:30:00Z"),
};

function spendDecision(): AgentDecisionOut {
  const policy = fromOptimizationPolicyRow({ workspaceId: "ws_1" });
  const d = evaluateAdSet({
    workspaceId: "ws_1",
    runId: "run_1",
    entityId: "as_winner",
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
    now: new Date("2026-09-16T10:00:00Z"),
    buckets: Array.from({ length: 10 }, (_, i) => ({
      ageHours: 240 - i * 24,
      spendMajor: 120,
      revenueMajor: 660,
      purchases: 9,
    })),
  });
  expect(d.action).toBe("INCREASE_BUDGET");
  return d;
}

describe("requiredApproval (spek: öneri otomatik uygulanmaz)", () => {
  it("bütçe harcatan TÜM aksiyonlar onay ister (PENDING)", () => {
    for (const action of [...SPEND_AFFECTING_ACTIONS]) {
      expect(requiredApproval({ action }), action).toBe("PENDING");
    }
  });

  it("status değiştiren aksiyonlar da onay ister", () => {
    for (const action of [...STATUS_AFFECTING_ACTIONS]) {
      expect(requiredApproval({ action }), action).toBe("PENDING");
    }
  });

  it("yalnızca KEEP onaysızdır (işlem yok)", () => {
    expect(requiredApproval({ action: "KEEP" })).toBe("NOT_REQUIRED");
  });
});

describe("buildExecutionPlan (onay-gate)", () => {
  it("onaysız karar → PERMISSION_ERROR; plan üretilemez", () => {
    const f = (action: AgentDecisionAction) => () =>
      buildExecutionPlan(
        { ...spendDecision(), action },
        { ...approvedEvidence, status: "PENDING" },
      );
    for (const action of [...SPEND_AFFECTING_ACTIONS]) {
      try {
        f(action)();
        expect.unreachable(`${action} hangi yolla onaysız plan üretebildi?`);
      } catch (e) {
        expect(e).toBeInstanceOf(AdmedicError);
        expect((e as AdmedicError).code).toBe("PERMISSION_ERROR");
      }
    }
  });

  it("APPROVED + bütçe aksiyonu → BUDGET_UPDATE planı", () => {
    const plan = buildExecutionPlan(spendDecision(), approvedEvidence);
    expect(plan.kind).toBe("BUDGET_UPDATE");
    expect(plan.dailyBudgetCents).toBeGreaterThan(20000);
    expect(plan.idempotencyKey).toBe(plan.decisionKey);
  });

  it("APPROVED + PAUSE → STATUS_UPDATE planı", () => {
    const d = spendDecision();
    const plan = buildExecutionPlan(
      { ...d, action: "PAUSE", proposedBudgetCents: 0 },
      approvedEvidence,
    );
    expect(plan.kind).toBe("STATUS_UPDATE");
    expect(plan.status).toBe("PAUSED");
  });

  it("KEEP → NONE planı", () => {
    const plan = buildExecutionPlan(
      { ...spendDecision(), action: "KEEP", approval: "NOT_REQUIRED" },
      approvedEvidence,
    );
    expect(plan.kind).toBe("NONE");
  });
});

describe("executePlan — kritik güvenlik:", () => {
  it("evidence PENDING olan plan Meta'ya asla çağrı yapmadan reddedilir", async () => {
    // Plan, depolamadan yüklenmiş gibi doğrudan kurulabilir (bypass senaryosu).
    const stalePlan = {
      decisionKey: spendDecision().decisionKey,
      workspaceId: "ws_1",
      targetType: "ADSET",
      targetId: "as_winner",
      action: "INCREASE_BUDGET" as const,
      kind: "BUDGET_UPDATE" as const,
      dailyBudgetCents: 22000,
      idempotencyKey: "stale-plan-key",
      evidenceStatus: "PENDING" as ApprovalStatus,
      approvedByUserId: "user_owner_1",
      approvedAt: new Date("2026-09-16T10:30:00Z"),
    };
    const client = {
      updateBudget: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as Parameters<typeof executePlan>[1];
    await expect(executePlan(stalePlan, client, "tok")).rejects.toThrow(
      AdmedicError,
    );
    expect(client.updateBudget).not.toHaveBeenCalled();
    expect(client.setStatus).not.toHaveBeenCalled();
  });

  it("APPROVED plan → client.updateBudget çağrılır, ok=true", async () => {
    const client = {
      updateBudget: vi.fn(async () => ({
        success: true,
        entityType: "adset",
        entityId: "as_winner",
      })),
      setStatus: vi.fn(),
    } as unknown as Parameters<typeof executePlan>[1];
    const plan = buildExecutionPlan(spendDecision(), approvedEvidence);
    const res = await executePlan(plan, client, "tok");
    expect(res.ok).toBe(true);
    expect(client.updateBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "adset",
        dailyBudgetCents: plan.dailyBudgetCents,
      }),
      "tok",
    );
    expect(client.setStatus).not.toHaveBeenCalled();
  });

  it("APPROVED PAUSE → setStatus(PAUSED) çağrılır", async () => {
    const client = {
      updateBudget: vi.fn(),
      setStatus: vi.fn(async () => ({
        success: true,
        entityType: "adset",
        entityId: "as_winner",
      })),
    } as unknown as Parameters<typeof executePlan>[1];
    const d = spendDecision();
    const plan = buildExecutionPlan(
      { ...d, action: "PAUSE", proposedBudgetCents: 0 },
      approvedEvidence,
    );
    const res = await executePlan(plan, client, "tok");
    expect(res.ok).toBe(true);
    expect(client.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PAUSED" }),
      "tok",
    );
    expect(client.updateBudget).not.toHaveBeenCalled();
  });
});
