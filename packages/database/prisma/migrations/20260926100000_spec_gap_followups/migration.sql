-- Yeni enum değerleri (asistan devri uyarısı, "devam et" önerisi)
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'CONVERSATION_ESCALATED';
ALTER TYPE "RecommendationType" ADD VALUE IF NOT EXISTS 'CONTINUE';

-- Klinik şehri (spec 3.2)
ALTER TABLE "ClinicProfile" ADD COLUMN "city" TEXT;

-- Şema ile migration sapması: Lead(organizationId, lookupHash) şemada @@unique, DB'de düz indeksti.
-- Aynı hash'e sahip mükerrer kayıtlarda yalnızca en eski kayıt hash'i korur (diğerleri duplicateOf ile izlenir).
UPDATE "Lead" l SET "lookupHash" = NULL
  WHERE l."lookupHash" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Lead" o
    WHERE o."organizationId" = l."organizationId" AND o."lookupHash" = l."lookupHash"
      AND (o."createdAt" < l."createdAt" OR (o."createdAt" = l."createdAt" AND o."id" < l."id"))
  );
DROP INDEX IF EXISTS "Lead_lookupHash_index";
CREATE UNIQUE INDEX IF NOT EXISTS "Lead_organizationId_lookupHash_key" ON "Lead"("organizationId", "lookupHash");
