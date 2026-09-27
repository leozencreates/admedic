/**
 * Prisma enum/DB değerleri ile birebir uyumlu paylaşılan tipler (client kullanımı).
 * Kaynak: prisma/schema.prisma. Değişiklikte ikisi de güncellenmeli.
 */

export type Role = "OWNER" | "ADMIN" | "MEDIA_BUYER" | "ANALYST" | "VIEWER";

export type MembershipStatus = "PENDING" | "ACTIVE" | "DISABLED";

export type MetaConnectionType =
  | "BUSINESS_MANAGER"
  | "AD_ACCOUNT"
  | "PAGE"
  | "INSTAGRAM"
  | "PIXEL"
  | "WHATSAPP_BUSINESS";

export type MetaConnectionStatus = "CONNECTED" | "EXPIRED" | "REVOKED" | "DEGRADED";

export type EntityStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";

export type OptimizationObjective =
  | "MAX_ROAS"
  | "MAX_REVENUE"
  | "MAX_PROFIT"
  | "MIN_CPA"
  | "MAX_PURCHASES_BUDGET"
  | "TARGET_ROAS"
  | "TARGET_CPA";

export type AgentMode = "OBSERVE" | "APPROVAL" | "AUTOPILOT" | "SHADOW";

export type AgentStatus = "ACTIVE" | "PAUSED" | "STOPPED";

export type AgentDecisionAction =
  | "INCREASE_BUDGET"
  | "DECREASE_BUDGET"
  | "PAUSE"
  | "UNPAUSE"
  | "ALLOCATE"
  | "EXPLORE"
  | "WINNER_PROMOTION"
  | "NEW_EXPERIMENT"
  | "KEEP";

export type AgentTargetType = "CAMPAIGN" | "ADSET" | "AD";

export type ApprovalStatus = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED" | "FAILED";

export type RunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "ABORTED";

export type ExperimentStatus = "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED" | "ARCHIVED";

export type ExperimentMetric =
  | "ROAS"
  | "CPA"
  | "PURCHASE_CONVERSION_RATE"
  | "CTR"
  | "REVENUE"
  | "CPL";

export type ExperimentMode = "MANUAL" | "AUTOPILOT";

export type VariantRole = "CONTROL" | "TEST";

export type VariantResult = "WINNER" | "LOSER" | "CONTINUE";

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type AlertStatus = "OPEN" | "ACKED" | "RESOLVED";

export type AlertType =
  | "ROAS_DROP"
  | "SPEND_SPIKE"
  | "ZERO_PURCHASES"
  | "ZERO_CONVERSION_VALUE"
  | "HIGH_CPA"
  | "META_API_ERROR"
  | "META_DISCONNECTED"
  | "PAUSE_APPLIED"
  | "WINNER_DETECTED"
  | "BUDGET_LIMIT_90"
  | "DUPLICATE_CAMPAIGN"
  | "PIXEL_ERROR"
  | "CREATIVE_FATIGUE"
  | "BUDGET_MODIFIED_EXTERNAL"
  | "TOKEN_EXPIRING"
  | "CONVERSATION_ESCALATED"
  | "AD_DISAPPROVED";

export type TrendDirection = "RISING" | "DECLINING" | "STABLE" | "INSUFFICIENT_DATA";

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export type SyncStatus = "OK" | "ERROR" | "STALE";

export type InsightGranularity = "HOURLY" | "DAILY";

export const ROLE_RANK: Record<Role, number> = {
  OWNER: 5,
  ADMIN: 4,
  MEDIA_BUYER: 3,
  ANALYST: 2,
  VIEWER: 1,
};

export function isRoleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}