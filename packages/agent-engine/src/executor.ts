import { AdmedicError } from "@admedic/shared";
import type { MetaClientLike } from "@admedic/meta-api";

import type { ApprovalEvidence, ExecutionPlan } from "./approval";

export interface PlanExecutionResult {
  decisionKey: string;
  kind: ExecutionPlan["kind"];
  ok: boolean;
  meta?: unknown;
}

/**
 * Onay-gated executor (spec 4: onay servisinden geçen ayrı executor).
 * İki katmanlı güvenlik:
 *  1) Plan ancak APPROVED evidence ile üretilebilir (buildExecutionPlan).
 *  2) Burada da evidence.status AGAIN kontrol edilir — onaysız plan uygulanamaz.
 */
export async function executePlan(
  plan: ExecutionPlan,
  client: MetaClientLike,
  token: string,
): Promise<PlanExecutionResult> {
  if (plan.evidenceStatus !== "APPROVED") {
    throw new AdmedicError(
      "PERMISSION_ERROR",
      `Plan ${plan.idempotencyKey} onaysız uygulanamaz`,
      { decisionKey: plan.decisionKey, evidenceStatus: plan.evidenceStatus },
    );
  }

  if (plan.kind === "BUDGET_UPDATE") {
    if (plan.dailyBudgetCents === undefined) {
      throw new AdmedicError(
        "VALIDATION_ERROR",
        "BUDGET_UPDATE planında dailyBudgetCents eksik",
      );
    }
    const meta = await client.updateBudget(
      {
        entityType: plan.targetType === "ADSET" ? "adset" : "campaign",
        entityId: plan.targetId,
        dailyBudgetCents: plan.dailyBudgetCents,
      },
      token,
    );
    return {
      decisionKey: plan.decisionKey,
      kind: plan.kind,
      ok: meta.success,
      meta,
    };
  }

  if (plan.kind === "STATUS_UPDATE") {
    if (plan.status === undefined) {
      throw new AdmedicError(
        "VALIDATION_ERROR",
        "STATUS_UPDATE planında status eksik",
      );
    }
    const meta = await client.setStatus(
      {
        entityType:
          plan.targetType === "AD"
            ? "ad"
            : plan.targetType === "ADSET"
              ? "adset"
              : "campaign",
        entityId: plan.targetId,
        status: plan.status,
      },
      token,
    );
    return {
      decisionKey: plan.decisionKey,
      kind: plan.kind,
      ok: meta.success,
      meta,
    };
  }

  return { decisionKey: plan.decisionKey, kind: "NONE", ok: true };
}

export type { ApprovalEvidence };
