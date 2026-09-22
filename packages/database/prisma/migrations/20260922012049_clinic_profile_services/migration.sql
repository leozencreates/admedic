/*
  Warnings:

  - Made the column `expectedImpact` on table `Recommendation` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "LlmCallLogStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ServiceCategory" AS ENUM ('MEDICAL', 'DENTAL', 'WELLNESS', 'SURGICAL', 'DIAGNOSTIC', 'PSYCHIATRIC', 'OTHER');

-- CreateEnum
CREATE TYPE "TargetMarket" AS ENUM ('TURKEY', 'GERMANY', 'UK', 'NETHERLANDS', 'USA', 'GULF', 'OTHER');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('TR', 'EN', 'DE', 'RU', 'AR');

-- DropForeignKey
ALTER TABLE "ConsentRecord" DROP CONSTRAINT "ConsentRecord_leadId_fkey";

-- DropForeignKey
ALTER TABLE "ConsentRecord" DROP CONSTRAINT "ConsentRecord_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_leadId_fkey";

-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_conversationId_fkey";

-- AlterTable
ALTER TABLE "ConsentRecord" ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Conversation" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Lead" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Recommendation" ALTER COLUMN "expectedImpact" SET NOT NULL;

-- CreateTable
CREATE TABLE "ClinicProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" "ServiceCategory" NOT NULL DEFAULT 'MEDICAL',
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "description" TEXT,
    "languages" "Language"[],
    "targetMarket" "TargetMarket" NOT NULL DEFAULT 'TURKEY',
    "licenseNumber" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" "ServiceCategory" NOT NULL,
    "description" TEXT,
    "durationDays" INTEGER,
    "priceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "recoveryRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketTarget" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "region" TEXT,
    "language" "Language" NOT NULL DEFAULT 'TR',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "demand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicProfile_workspaceId_idx" ON "ClinicProfile"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicProfile_workspaceId_slug_key" ON "ClinicProfile"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "Service_clinicId_idx" ON "Service"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_clinicId_slug_key" ON "Service"("clinicId", "slug");

-- CreateIndex
CREATE INDEX "MarketTarget_clinicId_idx" ON "MarketTarget"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketTarget_clinicId_country_key" ON "MarketTarget"("clinicId", "country");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicProfile" ADD CONSTRAINT "ClinicProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "ClinicProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketTarget" ADD CONSTRAINT "MarketTarget_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "ClinicProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "Lead_organizationId_phone_email_idx" RENAME TO "Lead_organizationId_phone_email_key";
