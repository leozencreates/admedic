-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEDIA_BUYER', 'ANALYST', 'VIEWER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "MetaConnectionType" AS ENUM ('BUSINESS_MANAGER', 'AD_ACCOUNT', 'PAGE', 'INSTAGRAM', 'PIXEL', 'WHATSAPP_BUSINESS');

-- CreateEnum
CREATE TYPE "MetaConnectionStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'REVOKED', 'DEGRADED');

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('OK', 'ERROR', 'STALE');

-- CreateEnum
CREATE TYPE "OptimizationObjective" AS ENUM ('MAX_ROAS', 'MAX_REVENUE', 'MAX_PROFIT', 'MIN_CPA', 'MAX_PURCHASES_BUDGET', 'TARGET_ROAS', 'TARGET_CPA');

-- CreateEnum
CREATE TYPE "AgentMode" AS ENUM ('OBSERVE', 'APPROVAL', 'AUTOPILOT', 'SHADOW');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'STOPPED');

-- CreateEnum
CREATE TYPE "AgentDecisionAction" AS ENUM ('INCREASE_BUDGET', 'DECREASE_BUDGET', 'PAUSE', 'UNPAUSE', 'ALLOCATE', 'EXPLORE', 'WINNER_PROMOTION', 'NEW_EXPERIMENT', 'KEEP');

-- CreateEnum
CREATE TYPE "AgentTargetType" AS ENUM ('CAMPAIGN', 'ADSET', 'AD');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'ABORTED');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ExperimentMetric" AS ENUM ('ROAS', 'CPA', 'PURCHASE_CONVERSION_RATE', 'CTR', 'REVENUE');

-- CreateEnum
CREATE TYPE "ExperimentMode" AS ENUM ('MANUAL', 'AUTOPILOT');

-- CreateEnum
CREATE TYPE "VariantRole" AS ENUM ('CONTROL', 'TEST');

-- CreateEnum
CREATE TYPE "VariantResult" AS ENUM ('WINNER', 'LOSER', 'CONTINUE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('ROAS_DROP', 'SPEND_SPIKE', 'ZERO_PURCHASES', 'ZERO_CONVERSION_VALUE', 'HIGH_CPA', 'META_API_ERROR', 'META_DISCONNECTED', 'PAUSE_APPLIED', 'WINNER_DETECTED', 'BUDGET_LIMIT_90', 'DUPLICATE_CAMPAIGN', 'PIXEL_ERROR', 'CREATIVE_FATIGUE', 'BUDGET_MODIFIED_EXTERNAL');

-- CreateEnum
CREATE TYPE "InsightGranularity" AS ENUM ('HOURLY', 'DAILY');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "passwordHash" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "locale" TEXT NOT NULL DEFAULT 'tr',
    "agentStatus" "AgentStatus" NOT NULL DEFAULT 'PAUSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" "MetaConnectionType" NOT NULL,
    "status" "MetaConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "name" TEXT,
    "metaAccountId" TEXT,
    "metaUserId" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenCiphertext" TEXT,
    "appId" TEXT,
    "pageId" TEXT,
    "instaId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "connectionId" TEXT,
    "metaAccountId" TEXT,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Istanbul',
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "dailySpendLimit" INTEGER,
    "monthlySpendLimit" INTEGER,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "metaCampaignId" TEXT,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "budgetType" TEXT,
    "dailyBudget" INTEGER,
    "lifetimeBudget" INTEGER,
    "spendCap" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'OK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSet" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "metaAdSetId" TEXT,
    "name" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "bidStrategy" TEXT,
    "dailyBudget" INTEGER,
    "lifetimeBudget" INTEGER,
    "budgetUsed" INTEGER,
    "targeting" JSONB,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'OK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),

    CONSTRAINT "AdSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ad" (
    "id" TEXT NOT NULL,
    "adSetId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "metaAdId" TEXT,
    "name" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "metaCreativeId" TEXT,
    "creativeId" TEXT,
    "creative" JSONB,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'OK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Creative" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'IMAGE',
    "metaCreativeId" TEXT,
    "primaryText" TEXT,
    "headline" TEXT,
    "description" TEXT,
    "cta" TEXT,
    "linkUrl" TEXT,
    "imageUrl" TEXT,
    "thumbnailUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Creative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsightSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "adAccountId" TEXT,
    "campaignId" TEXT,
    "adSetId" TEXT,
    "adId" TEXT,
    "date" DATE NOT NULL,
    "granularity" "InsightGranularity" NOT NULL DEFAULT 'DAILY',
    "attributionWindowDays" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'META',
    "spend" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER NOT NULL DEFAULT 0,
    "outboundClicks" INTEGER NOT NULL DEFAULT 0,
    "landingPageViews" INTEGER NOT NULL DEFAULT 0,
    "addsToCart" INTEGER NOT NULL DEFAULT 0,
    "initiatesCheckout" INTEGER NOT NULL DEFAULT 0,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "conversionValue" INTEGER NOT NULL DEFAULT 0,
    "frequency" DOUBLE PRECISION,
    "ctr" DOUBLE PRECISION,
    "cpc" INTEGER,
    "cpm" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "campaignId" TEXT,
    "adSetId" TEXT,
    "adId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'PURCHASE',
    "value" INTEGER,
    "currency" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'META',
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "adAccountId" TEXT,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT,
    "primaryMetric" "ExperimentMetric" NOT NULL DEFAULT 'ROAS',
    "status" "ExperimentStatus" NOT NULL DEFAULT 'DRAFT',
    "mode" "ExperimentMode" NOT NULL DEFAULT 'MANUAL',
    "minSpend" INTEGER,
    "maxSpend" INTEGER,
    "minPurchases" INTEGER NOT NULL DEFAULT 10,
    "minRuntimeHours" INTEGER NOT NULL DEFAULT 72,
    "maxRuntimeHours" INTEGER,
    "confidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.95,
    "budgetCents" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "winnerVariantId" TEXT,
    "resultSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentVariant" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "role" "VariantRole" NOT NULL DEFAULT 'TEST',
    "name" TEXT NOT NULL,
    "creativeId" TEXT,
    "landingPageUrl" TEXT,
    "dailyBudgetCents" INTEGER,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentMetricPoint" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spend" INTEGER NOT NULL DEFAULT 0,
    "revenue" INTEGER NOT NULL DEFAULT 0,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "addsToCart" INTEGER NOT NULL DEFAULT 0,
    "initiatesCheckout" INTEGER NOT NULL DEFAULT 0,
    "ctr" DOUBLE PRECISION,

    CONSTRAINT "ExperimentMetricPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "objective" "OptimizationObjective" NOT NULL DEFAULT 'MAX_ROAS',
    "mode" "AgentMode" NOT NULL DEFAULT 'APPROVAL',
    "accountDailyMaxCents" INTEGER,
    "accountMonthlyMaxCents" INTEGER,
    "campaignDailyMaxCents" INTEGER,
    "adSetDailyMaxCents" INTEGER,
    "minDailyBudgetCents" INTEGER NOT NULL DEFAULT 2000,
    "maxDailyBudgetCents" INTEGER,
    "maxIncreasePct" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "maxDecreasePct" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "maxChangePer24hPct" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "minHoursBetweenChanges" INTEGER NOT NULL DEFAULT 6,
    "minSpendBeforeDecisionCents" INTEGER NOT NULL DEFAULT 5000,
    "minPurchasesBeforeScaling" INTEGER NOT NULL DEFAULT 10,
    "minTestDurationHours" INTEGER NOT NULL DEFAULT 24,
    "explorationPct" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "exploitationPct" DOUBLE PRECISION NOT NULL DEFAULT 85,
    "targetRoas" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "maxCpaCents" INTEGER,
    "stopLossSpendCents" INTEGER,
    "stopLossPurchases" INTEGER,
    "attributionWindowDays" INTEGER NOT NULL DEFAULT 7,
    "profitSettings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptimizationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "logic" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mode" "AgentMode" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "objective" "OptimizationObjective" NOT NULL DEFAULT 'MAX_ROAS',
    "agentVersion" TEXT NOT NULL DEFAULT 'agent_v1.0',
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "summary" JSONB,
    "metaError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT,
    "targetType" "AgentTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "action" "AgentDecisionAction" NOT NULL,
    "statusBefore" TEXT,
    "statusAfter" TEXT,
    "budgetBefore" INTEGER,
    "budgetAfter" INTEGER,
    "changePct" DOUBLE PRECISION,
    "approval" "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "reason" TEXT NOT NULL,
    "metricsSnapshot" JSONB,
    "trendDirection" TEXT,
    "algorithm" TEXT NOT NULL DEFAULT 'rules_v1',
    "ruleVersion" TEXT NOT NULL DEFAULT 'policy_1',
    "agentVersion" TEXT NOT NULL DEFAULT 'agent_v1.0',
    "decisionKey" TEXT,
    "experimentId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "metaResponse" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetChange" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "decisionId" TEXT,
    "targetType" "AgentTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "field" TEXT NOT NULL DEFAULT 'daily_budget',
    "fromCents" INTEGER NOT NULL,
    "toCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "metaResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "BudgetChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "category" TEXT,
    "sellingPriceCents" INTEGER NOT NULL,
    "cogsCents" INTEGER NOT NULL,
    "shippingCents" INTEGER NOT NULL DEFAULT 0,
    "paymentFeePct" DOUBLE PRECISION DEFAULT 0,
    "otherCostsCents" INTEGER NOT NULL DEFAULT 0,
    "refundRatePct" DOUBLE PRECISION DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandingPage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LandingPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE INDEX "Membership_orgId_idx" ON "Membership"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_orgId_userId_key" ON "Membership"("orgId", "userId");

-- CreateIndex
CREATE INDEX "Workspace_orgId_idx" ON "Workspace"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_orgId_slug_key" ON "Workspace"("orgId", "slug");

-- CreateIndex
CREATE INDEX "MetaConnection_orgId_idx" ON "MetaConnection"("orgId");

-- CreateIndex
CREATE INDEX "MetaConnection_type_idx" ON "MetaConnection"("type");

-- CreateIndex
CREATE INDEX "AdAccount_workspaceId_idx" ON "AdAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "AdAccount_orgId_idx" ON "AdAccount"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "AdAccount_orgId_metaAccountId_key" ON "AdAccount"("orgId", "metaAccountId");

-- CreateIndex
CREATE INDEX "Campaign_workspaceId_idx" ON "Campaign"("workspaceId");

-- CreateIndex
CREATE INDEX "Campaign_adAccountId_idx" ON "Campaign"("adAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_adAccountId_metaCampaignId_key" ON "Campaign"("adAccountId", "metaCampaignId");

-- CreateIndex
CREATE INDEX "AdSet_workspaceId_idx" ON "AdSet"("workspaceId");

-- CreateIndex
CREATE INDEX "AdSet_campaignId_idx" ON "AdSet"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "AdSet_campaignId_metaAdSetId_key" ON "AdSet"("campaignId", "metaAdSetId");

-- CreateIndex
CREATE INDEX "Ad_workspaceId_idx" ON "Ad"("workspaceId");

-- CreateIndex
CREATE INDEX "Ad_adSetId_idx" ON "Ad"("adSetId");

-- CreateIndex
CREATE UNIQUE INDEX "Ad_adSetId_metaAdId_key" ON "Ad"("adSetId", "metaAdId");

-- CreateIndex
CREATE INDEX "Creative_orgId_idx" ON "Creative"("orgId");

-- CreateIndex
CREATE INDEX "Creative_workspaceId_idx" ON "Creative"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Creative_orgId_metaCreativeId_key" ON "Creative"("orgId", "metaCreativeId");

-- CreateIndex
CREATE INDEX "InsightSnapshot_workspaceId_date_idx" ON "InsightSnapshot"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "InsightSnapshot_adId_date_idx" ON "InsightSnapshot"("adId", "date");

-- CreateIndex
CREATE INDEX "InsightSnapshot_adSetId_date_idx" ON "InsightSnapshot"("adSetId", "date");

-- CreateIndex
CREATE INDEX "InsightSnapshot_campaignId_date_idx" ON "InsightSnapshot"("campaignId", "date");

-- CreateIndex
CREATE INDEX "InsightSnapshot_adAccountId_date_idx" ON "InsightSnapshot"("adAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionEvent_externalId_key" ON "ConversionEvent"("externalId");

-- CreateIndex
CREATE INDEX "ConversionEvent_workspaceId_occurredAt_idx" ON "ConversionEvent"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "Experiment_workspaceId_status_idx" ON "Experiment"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ExperimentVariant_experimentId_idx" ON "ExperimentVariant"("experimentId");

-- CreateIndex
CREATE INDEX "ExperimentMetricPoint_experimentId_idx" ON "ExperimentMetricPoint"("experimentId");

-- CreateIndex
CREATE INDEX "ExperimentMetricPoint_variantId_idx" ON "ExperimentMetricPoint"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "OptimizationPolicy_workspaceId_key" ON "OptimizationPolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_startedAt_idx" ON "AgentRun"("workspaceId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDecision_decisionKey_key" ON "AgentDecision"("decisionKey");

-- CreateIndex
CREATE INDEX "AgentDecision_workspaceId_createdAt_idx" ON "AgentDecision"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentDecision_workspaceId_targetId_idx" ON "AgentDecision"("workspaceId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetChange_idempotencyKey_key" ON "BudgetChange"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BudgetChange_workspaceId_idx" ON "BudgetChange"("workspaceId");

-- CreateIndex
CREATE INDEX "Alert_workspaceId_status_idx" ON "Alert"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "AuditLog_orgId_createdAt_idx" ON "AuditLog"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Product_workspaceId_idx" ON "Product"("workspaceId");

-- CreateIndex
CREATE INDEX "LandingPage_workspaceId_idx" ON "LandingPage"("workspaceId");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaConnection" ADD CONSTRAINT "MetaConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MetaConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_adSetId_fkey" FOREIGN KEY ("adSetId") REFERENCES "AdSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "Creative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightSnapshot" ADD CONSTRAINT "InsightSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightSnapshot" ADD CONSTRAINT "InsightSnapshot_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightSnapshot" ADD CONSTRAINT "InsightSnapshot_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightSnapshot" ADD CONSTRAINT "InsightSnapshot_adSetId_fkey" FOREIGN KEY ("adSetId") REFERENCES "AdSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightSnapshot" ADD CONSTRAINT "InsightSnapshot_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_adSetId_fkey" FOREIGN KEY ("adSetId") REFERENCES "AdSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT "ExperimentVariant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT "ExperimentVariant_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "Creative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentMetricPoint" ADD CONSTRAINT "ExperimentMetricPoint_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentMetricPoint" ADD CONSTRAINT "ExperimentMetricPoint_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ExperimentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationPolicy" ADD CONSTRAINT "OptimizationPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationRule" ADD CONSTRAINT "OptimizationRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDecision" ADD CONSTRAINT "AgentDecision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDecision" ADD CONSTRAINT "AgentDecision_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetChange" ADD CONSTRAINT "BudgetChange_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetChange" ADD CONSTRAINT "BudgetChange_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AgentDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandingPage" ADD CONSTRAINT "LandingPage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
