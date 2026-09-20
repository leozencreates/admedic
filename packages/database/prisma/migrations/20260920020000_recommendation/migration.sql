-- Recommendation model + Lead CRM + Consent (Phase 5)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RecommendationStatus') THEN EXECUTE 'CREATE TYPE "RecommendationStatus" AS ENUM (''DRAFT'',''PENDING'',''APPROVED'',''REJECTED'',''APPLIED'',''EXPIRED'')'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RecommendationType') THEN EXECUTE 'CREATE TYPE "RecommendationType" AS ENUM (''BUDGET_REALLOCATION'',''BUDGET_INCREASE'',''BUDGET_DECREASE'',''EXPERIMENT_END'',''WINNER_PROMOTION'')'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LeadStatus') THEN EXECUTE 'CREATE TYPE "LeadStatus" AS ENUM (''NEW'',''CONTACTED'',''QUALIFIED'',''CONSULTATION_BOOKED'',''TRAVEL_PLANNED'',''TREATED'',''LOST'')'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConversationStatus') THEN EXECUTE 'CREATE TYPE "ConversationStatus" AS ENUM (''ACTIVE'',''CLOSED'',''ESCALATED'')'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MessageChannel') THEN EXECUTE 'CREATE TYPE "MessageChannel" AS ENUM (''WHATSAPP'',''INSTAGRAM'',''MESSENGER'',''SMS'')'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MessageDirection') THEN EXECUTE 'CREATE TYPE "MessageDirection" AS ENUM (''INCOMING'',''OUTGOING'')'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConsentStatus') THEN EXECUTE 'CREATE TYPE "ConsentStatus" AS ENUM (''PENDING'',''GRANTED'',''DENIED'',''WITHDRAWN'')'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConsentType') THEN EXECUTE 'CREATE TYPE "ConsentType" AS ENUM (''MARKETING'',''DATA_PROCESSING'',''HEALTH_QUESTIONNAIRE'')'; END IF;
END $$;

ALTER TABLE "StudioExperiment" DROP COLUMN IF EXISTS "recommendationsId";

CREATE TABLE IF NOT EXISTS "Recommendation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "experimentId" TEXT NOT NULL REFERENCES "StudioExperiment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "type" "RecommendationType" NOT NULL DEFAULT 'BUDGET_REALLOCATION',
    "status" "RecommendationStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "action" JSONB NOT NULL,
    "expectedImpact" JSONB,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "Recommendation_workspaceId_status_idx" ON "Recommendation"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "Recommendation_experimentId_idx" ON "Recommendation"("experimentId");

CREATE TABLE IF NOT EXISTS "Lead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
    "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "language" TEXT NOT NULL DEFAULT 'tr',
    "channel" TEXT,
    "campaignId" TEXT,
    "adSetId" TEXT,
    "adId" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "lostReason" TEXT,
    "qualifiedAt" TIMESTAMP(3),
    "consultationBookedAt" TIMESTAMP(3),
    "treatedAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "duplicateOf" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Lead_workspaceId_status_idx" ON "Lead"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "Lead_organizationId_createdAt_idx" ON "Lead"("organizationId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Lead_organizationId_phone_email_idx" ON "Lead"("organizationId", "phone", "email");

CREATE TABLE IF NOT EXISTS "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE CASCADE,
    "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
    "channel" "MessageChannel" NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "initiatedBy" TEXT,
    "escalatedTo" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Conversation_leadId_idx" ON "Conversation"("leadId");
CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_status_idx" ON "Conversation"("workspaceId", "status");

CREATE TABLE IF NOT EXISTS "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
    "direction" "MessageDirection" NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "content" TEXT NOT NULL,
    "sender" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Message_conversationId_idx" ON "Message"("conversationId");

CREATE TABLE IF NOT EXISTS "ConsentRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE CASCADE,
    "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
    "type" "ConsentType" NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'PENDING',
    "consentText" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ConsentRecord_leadId_idx" ON "ConsentRecord"("leadId");
CREATE INDEX IF NOT EXISTS "ConsentRecord_workspaceId_type_idx" ON "ConsentRecord"("workspaceId", "type");
