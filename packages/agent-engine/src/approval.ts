import {
  AdmedicError,
  type AgentDecisionAction,
  type ApprovalStatus,
} from "@admedic/shared";

import type { AgentDecisionOut } from "./types";

/** Bütçe harcamasını/dağıtımını değiştiren aksiyonlar (test + guard için kanonik liste). */
export const SPEND_AFFECTING_ACTIONS: ReadonlySet<AgentDecisionAction> =
  new Set([
    "INCREASE_BUDGET",
    "DECREASE_BUDGET",
    "ALLOCATE",
    "EXPLORE",
    "WINNER_PROMOTION",
    "NEW_EXPERIMENT",
  ]);

/** Reklam dağıtımını değiştiren aksiyonlar (status). */
export const STATUS_AFFECTING_ACTIONS = new Set<AgentDecisionAction>([
  "PAUSE",
  "UNPAUSE",
]);

/**
 * Onay kuralı (spec 3.6/3.10):
 *  - KEEP → onay gerekmez (işlem yok).
 *  - Bütçe/statü değiştiren her aksiyon → PENDING (insan onayı şart).
 * Mode (OBSERVE/APPROVAL/AUTOPILOT) bu kuralı gevşetemez; auto-execute yoktur.
 */
export function requiredApproval(
  decision: Pick<AgentDecisionOut, "action">,
): ApprovalStatus {
  if (decision.action === "KEEP") return "NOT_REQUIRED";
  return "PENDING";
}

export interface ApprovalEvidence {
  status: ApprovalStatus; // yalnızca APPROVED geçerli
  approvedByUserId: string;
  approvedAt: Date;
  note?: string;
}

export interface ExecutionPlan {
  decisionKey: string;
  workspaceId: string;
  targetType: string;
  targetId: string;
  action: AgentDecisionAction;
  kind: "BUDGET_UPDATE" | "STATUS_UPDATE" | "NONE";
  dailyBudgetCents?: number;
  status?: "PAUSED" | "ACTIVE";
  idempotencyKey: string;
  evidenceStatus: ApprovalStatus;
  approvedByUserId: string;
  approvedAt: Date;
}

/**
 * Onaylanmış kararı Meta'da uygulanabilir "plan"a çevirir.
 * Onay yoksa (status !== APPROVED) PERMISSION_ERROR fırlatır — para harcatan
 * hiçbir kod yolu onaysız buradan çıkamaz.
 */
export function buildExecutionPlan(
  decision: AgentDecisionOut,
  evidence: ApprovalEvidence,
): ExecutionPlan {
  if (evidence.status !== "APPROVED") {
    throw new AdmedicError(
      "PERMISSION_ERROR",
      `Karar ${decision.decisionKey} onaylanmadan uygulanamaz (beklenen: APPROVED, alınan: ${evidence.status})`,
      { decisionKey: decision.decisionKey, action: decision.action },
    );
  }

  const isBudget = SPEND_AFFECTING_ACTIONS.has(decision.action);
  const isStatus = STATUS_AFFECTING_ACTIONS.has(decision.action);

  if (isBudget) {
    if (
      decision.proposedBudgetCents === null ||
      decision.proposedBudgetCents === undefined
    ) {
      throw new AdmedicError(
        "VALIDATION_ERROR",
        `${decision.action} için proposedBudgetCents eksik`,
        {
          decisionKey: decision.decisionKey,
        },
      );
    }
    return {
      decisionKey: decision.decisionKey,
      workspaceId: decision.workspaceId,
      targetType: decision.targetType,
      targetId: decision.targetId,
      action: decision.action,
      kind: "BUDGET_UPDATE",
      dailyBudgetCents: decision.proposedBudgetCents,
      idempotencyKey: decision.decisionKey,
      evidenceStatus: evidence.status,
      approvedByUserId: evidence.approvedByUserId,
      approvedAt: evidence.approvedAt,
    };
  }

  if (isStatus) {
    const status = decision.action === "PAUSE" ? "PAUSED" : "ACTIVE";
    return {
      decisionKey: decision.decisionKey,
      workspaceId: decision.workspaceId,
      targetType: decision.targetType,
      targetId: decision.targetId,
      action: decision.action,
      kind: "STATUS_UPDATE",
      status,
      idempotencyKey: decision.decisionKey,
      evidenceStatus: evidence.status,
      approvedByUserId: evidence.approvedByUserId,
      approvedAt: evidence.approvedAt,
    };
  }

  return {
    decisionKey: decision.decisionKey,
    workspaceId: decision.workspaceId,
    targetType: decision.targetType,
    targetId: decision.targetId,
    action: decision.action,
    kind: "NONE",
    idempotencyKey: decision.decisionKey,
    evidenceStatus: evidence.status,
    approvedByUserId: evidence.approvedByUserId,
    approvedAt: evidence.approvedAt,
  };
}
