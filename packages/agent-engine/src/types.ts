import type {
  AgentDecisionAction,
  AgentMode,
  AgentTargetType,
  ApprovalStatus,
  EntityStatus,
  TrendDirection,
} from "@admedic/shared";
import type {
  EngineSettings,
  FatigueLevel,
  ObservationBucket,
  PosteriorConfig,
} from "@admedic/bayesian-engine";

/**
 * OptimizationPolicy satırının agent-engine için sadeleştirilmiş hali.
 * DB şeması (OptimizationPolicy) ile birebir uyumlu; yüzdeler 0–100 arası.
 */
export interface PolicyGuardrails {
  workspaceId: string;
  enabled: boolean;
  mode: AgentMode;
  accountDailyMaxCents?: number;
  accountMonthlyMaxCents?: number;
  campaignDailyMaxCents?: number;
  adSetDailyMaxCents?: number;
  minDailyBudgetCents: number;
  maxDailyBudgetCents?: number;
  maxIncreasePct: number; // 20 → %20
  maxDecreasePct: number; // 20 → %20
  maxChangePer24hPct: number; // 50 → %50
  minHoursBetweenChanges: number;
  minSpendBeforeDecisionCents: number;
  minPurchasesBeforeScaling: number;
  minTestDurationHours: number;
  targetRoas: number;
  maxCpaCents?: number;
  stopLossSpendCents?: number;
  attributionWindowDays: number;
}

/**
 * Bir ad set / ad'ın tek değerlendirme girdisi.
 * Alışkanlık: tüm para birimi "cents"; bayesian-engine ise major (birim) kullanır,
 * dönüşüm bu katmanda yapılır.
 */
export interface AdSetAgentInput {
  workspaceId: string;
  runId: string;
  entityId: string;
  targetType: AgentTargetType;
  currentBudgetCents: number;
  status: EntityStatus;
  buckets: ObservationBucket[]; // ageHours asc, major birimde
  policy: PolicyGuardrails;
  settings: EngineSettings;
  posterior: PosteriorConfig;
  targetRoas: number;
  /** 0..1 arası katkı marjı; break-even ROAS = 1/M. */
  contributionMarginRatio: number;
  minimumAcceptableRoas: number;
  now: Date;
  /** Son karar (cooldown için). */
  lastDecisionAt?: Date;
  /** Son 24 saat içindeki bütçe değişimleri (maxChangePer24hPct için). */
  budgetChangesLast24h?: {
    budgetBeforeCents: number;
    budgetAfterCents: number;
    createdAt: Date;
    action: AgentDecisionAction;
  }[];
  consecutiveLoserEvaluations?: number;
  trackingAnomaly?: boolean;
  fatigue?: FatigueLevel;
}

export interface DecisionMetrics {
  observedRoas: number | null;
  bayesianRoas: number | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  bayesianRoasP10: number | null;
  bayesianRoasP50: number | null;
  bayesianRoasP90: number | null;
  probabilityAboveTarget: number | null;
  probabilityBelowBreakEven: number | null;
  evidenceTarget: number | null;
  evidenceBreakEven: number | null;
  expectedAov: number | null;
  trend: TrendDirection;
  fatigue: FatigueLevel;
  purchases: number;
  spendCents: number;
  ctrPercent: number | null;
  cpcCents: number | null;
  cpmCents: number | null;
}

/** Agent ajanının ürettiği "önerilen aksiyon" nesnesi (spec 4: ajan Meta'ya yazamaz). */
export interface AgentDecisionOut {
  decisionKey: string;
  workspaceId: string;
  runId: string;
  targetType: AgentTargetType;
  targetId: string;
  action: AgentDecisionAction;
  reason: string;
  algorithm: string;
  ruleVersion: string;
  currentBudgetCents: number;
  proposedBudgetCents: number | null;
  changePct: number | null;
  statusBefore: EntityStatus;
  statusAfter: EntityStatus;
  approval: ApprovalStatus;
  metrics: DecisionMetrics;
  createdAt: Date;
}

export type AgentAlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface AgentAlertOut {
  type: string;
  severity: AgentAlertSeverity;
  title: string;
  message: string;
  entityType: AgentTargetType | "ACCOUNT";
  entityId: string;
  decisionKey?: string;
}

export interface OptimizerReport {
  workspaceId: string;
  runId: string;
  decisions: AgentDecisionOut[];
  alerts: AgentAlertOut[];
  projectedDailySpendCents: number;
  accountDailyMaxCents: number | null;
  overBudgetCents: number;
  now: Date;
}
