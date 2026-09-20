CREATE TYPE "StudioStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED');

CREATE TABLE "WebSession" (
  "tokenHash" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "WebSession_expiresAt_idx" ON "WebSession"("expiresAt");

CREATE TABLE "RequestQuota" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "count" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "RequestQuota_expiresAt_idx" ON "RequestQuota"("expiresAt");

CREATE TABLE "StudioDraft" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "status" "StudioStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "policy" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "StudioDraft_workspaceId_updatedAt_idx" ON "StudioDraft"("workspaceId", "updatedAt");

CREATE TABLE "StudioExperiment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "draftId" TEXT NOT NULL REFERENCES "StudioDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "snapshot" JSONB NOT NULL,
  "status" "ExperimentStatus" NOT NULL DEFAULT 'DRAFT',
  "metrics" JSONB NOT NULL,
  "elapsedDays" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "StudioExperiment_draftId_key" ON "StudioExperiment"("draftId");

CREATE TABLE "LlmCallLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "agent" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LlmCallLog_workspaceId_createdAt_idx" ON "LlmCallLog"("workspaceId", "createdAt");
