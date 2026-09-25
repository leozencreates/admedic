-- CreateEnum
CREATE TYPE "RecommendationPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- AlterTable
ALTER TABLE "Recommendation" ADD COLUMN "priority" "RecommendationPriority" NOT NULL DEFAULT 'MEDIUM';