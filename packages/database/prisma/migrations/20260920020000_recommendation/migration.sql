-- Recommendation model for optimization suggestions (Phase 5)
CREATE TYPE "RecommendationStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'EXPIRED');
CREATE TYPE "RecommendationType" AS ENUM ('BUDGET_REALLOCATION', 'BUDGET_INCREASE', 'BUDGET_DECREASE', 'EXPERIMENT_END', 'WINNER_PROMOTION');

ALTER TABLE "StudioExperiment" ADD COLUMN "recommendationsId" TEXT;

CREATE TABLE "Recommendation" (
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
CREATE INDEX "Recommendation_workspaceId_status_idx" ON "Recommendation"("workspaceId", "status");
CREATE INDEX "Recommendation_experimentId_idx" ON "Recommendation"("experimentId");
