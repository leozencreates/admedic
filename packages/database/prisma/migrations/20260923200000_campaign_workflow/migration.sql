-- Campaign yayın yaşam döngüsü (spec 3.6) + politika riski (spec 3.5)
CREATE TYPE "CampaignWorkflowStatus" AS ENUM ('DRAFT','IN_REVIEW','APPROVED','REJECTED','PUBLISHED_PAUSED','ACTIVE','ARCHIVED');
CREATE TYPE "PolicyRisk" AS ENUM ('LOW','MEDIUM','HIGH');

ALTER TABLE "Campaign" ADD COLUMN "workflowStatus" "CampaignWorkflowStatus" NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "Campaign" ADD COLUMN "policyRisk" "PolicyRisk";
ALTER TABLE "Campaign" ADD COLUMN "policyReport" JSONB;
ALTER TABLE "Campaign" ADD COLUMN "approvedBy" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "rejectionBy" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "rejectionReason" TEXT;

-- Tenant aylık reklam bütçesi üst limiti (spec 3.3 kabul kriteri)
ALTER TABLE "Organization" ADD COLUMN "monthlyAdBudgetCap" INTEGER;

-- Devam eden mevcut kampanyaları iş akışına eşle
UPDATE "Campaign" SET "workflowStatus" = 'ACTIVE' WHERE "status" = 'ACTIVE';
UPDATE "Campaign" SET "workflowStatus" = 'ARCHIVED' WHERE "status" = 'ARCHIVED';