-- Spec 3.5: reklam düzeyinde Meta inceleme durumu ve red uyarısı
ALTER TYPE "AlertType" ADD VALUE 'AD_DISAPPROVED';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "metaReviewCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Ad" ADD COLUMN "metaEffectiveStatus" TEXT,
ADD COLUMN "metaReviewFeedback" JSONB,
ADD COLUMN "metaReviewCheckedAt" TIMESTAMP(3);

-- Spec 3.11: rıza kaydının kaynağı ve kanıtı (Instant Form kutusu yanıtı)
ALTER TABLE "ConsentRecord" ADD COLUMN "source" TEXT,
ADD COLUMN "evidence" JSONB;

-- CreateTable
CREATE TABLE "LeadForm" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "campaignId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "metaFormId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "consentKey" TEXT NOT NULL,
    "consentRequired" BOOLEAN NOT NULL DEFAULT true,
    "consentText" TEXT NOT NULL,
    "privacyPolicyUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadForm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadForm_metaFormId_key" ON "LeadForm"("metaFormId");

-- CreateIndex
CREATE INDEX "LeadForm_orgId_idx" ON "LeadForm"("orgId");

-- CreateIndex
CREATE INDEX "LeadForm_campaignId_idx" ON "LeadForm"("campaignId");

-- AddForeignKey
ALTER TABLE "LeadForm" ADD CONSTRAINT "LeadForm_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
