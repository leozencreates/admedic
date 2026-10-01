-- Sesli ajanla giden arama (ADR-0026) ve asistan örnekleri ayarı (ADR-0027).
ALTER TYPE "ConsentType" ADD VALUE 'PHONE_CALL';

CREATE TYPE "VoiceCallStatus" AS ENUM ('QUEUED', 'INITIATED', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL', 'FAILED');
CREATE TYPE "VoiceCallTrigger" AS ENUM ('MANUAL', 'AUTO');

ALTER TABLE "Organization"
    ADD COLUMN "voiceAutoCallEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "assistantExamplesEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "VoiceCall" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "trigger" "VoiceCallTrigger" NOT NULL,
    "requestedById" TEXT,
    "status" "VoiceCallStatus" NOT NULL DEFAULT 'QUEUED',
    "conversationId" TEXT,
    "providerCallId" TEXT,
    "failureReason" TEXT,
    "outcome" TEXT,
    "summary" TEXT,
    "durationSecs" INTEGER,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceCall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VoiceCall_conversationId_key" ON "VoiceCall"("conversationId");
CREATE INDEX "VoiceCall_leadId_createdAt_idx" ON "VoiceCall"("leadId", "createdAt");
CREATE INDEX "VoiceCall_workspaceId_status_idx" ON "VoiceCall"("workspaceId", "status");
CREATE INDEX "VoiceCall_organizationId_createdAt_idx" ON "VoiceCall"("organizationId", "createdAt");

ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
