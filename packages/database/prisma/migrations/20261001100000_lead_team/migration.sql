-- Lead takımı (ADR-0029): 50 ajanlık hiyerarşinin çalıştırmaları, ajan raporları ve direktör önerileri.
CREATE TYPE "LeadTeamRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "LeadTeamProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "LeadTeamRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedById" TEXT,
    "status" "LeadTeamRunStatus" NOT NULL DEFAULT 'RUNNING',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "agentsTotal" INTEGER NOT NULL,
    "agentsCompleted" INTEGER NOT NULL DEFAULT 0,
    "agentsFailed" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "error" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadTeamRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeadTeamReport" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "team" TEXT,
    "status" TEXT NOT NULL,
    "output" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadTeamReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeadTeamProposal" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "market" TEXT,
    "language" TEXT,
    "service" TEXT,
    "angle" TEXT NOT NULL,
    "dailyBudgetCents" INTEGER,
    "currency" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "rationale" TEXT NOT NULL,
    "status" "LeadTeamProposalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadTeamProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeadTeamRun_workspaceId_createdAt_idx" ON "LeadTeamRun"("workspaceId", "createdAt");
CREATE UNIQUE INDEX "LeadTeamReport_runId_agentKey_key" ON "LeadTeamReport"("runId", "agentKey");
CREATE INDEX "LeadTeamProposal_workspaceId_status_idx" ON "LeadTeamProposal"("workspaceId", "status");
CREATE INDEX "LeadTeamProposal_runId_idx" ON "LeadTeamProposal"("runId");

ALTER TABLE "LeadTeamRun" ADD CONSTRAINT "LeadTeamRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadTeamReport" ADD CONSTRAINT "LeadTeamReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "LeadTeamRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadTeamProposal" ADD CONSTRAINT "LeadTeamProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "LeadTeamRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadTeamProposal" ADD CONSTRAINT "LeadTeamProposal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
