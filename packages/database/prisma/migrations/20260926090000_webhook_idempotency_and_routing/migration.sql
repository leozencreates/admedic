-- Tenant bazlı rapor alıcısı
ALTER TABLE "Organization" ADD COLUMN "reportRecipient" TEXT;

-- WhatsApp / Conversions API yönlendirme alanları
ALTER TABLE "MetaConnection" ADD COLUMN "whatsappPhoneNumberId" TEXT;
ALTER TABLE "MetaConnection" ADD COLUMN "whatsappBusinessId" TEXT;
ALTER TABLE "MetaConnection" ADD COLUMN "pixelId" TEXT;
CREATE INDEX "MetaConnection_pageId_idx" ON "MetaConnection"("pageId");
CREATE INDEX "MetaConnection_whatsappPhoneNumberId_idx" ON "MetaConnection"("whatsappPhoneNumberId");

-- Webhook idempotency: mesaj (mid/wamid) ve leadgen kimlikleri
ALTER TABLE "Message" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Lead" ADD COLUMN "leadgenId" TEXT;

-- Önce geriye dönük doldurma: eski (idempotent olmayan) işleyici aynı mid/leadgen_id'yi birden çok
-- kez kaydetmiş olabilir; anahtar yalnızca EN ESKİ kayda verilir, sonra benzersiz indeks kurulur.
UPDATE "Message" m SET "externalId" = picked.mid
  FROM (
    SELECT DISTINCT ON (m2."metadata"->>'mid') m2."id", m2."metadata"->>'mid' AS mid
    FROM "Message" m2
    WHERE m2."metadata"->>'mid' IS NOT NULL AND m2."metadata"->>'mid' <> ''
    ORDER BY m2."metadata"->>'mid', m2."createdAt" ASC, m2."id" ASC
  ) picked
  WHERE m."id" = picked."id";

UPDATE "Lead" l SET "leadgenId" = picked.leadgen
  FROM (
    SELECT DISTINCT ON (l2."organizationId", l2."metadata"->>'leadgen_id') l2."id", l2."metadata"->>'leadgen_id' AS leadgen
    FROM "Lead" l2
    WHERE l2."metadata"->>'leadgen_id' IS NOT NULL AND l2."metadata"->>'leadgen_id' <> ''
    ORDER BY l2."organizationId", l2."metadata"->>'leadgen_id', l2."createdAt" ASC, l2."id" ASC
  ) picked
  WHERE l."id" = picked."id";

CREATE UNIQUE INDEX "Message_externalId_key" ON "Message"("externalId");
CREATE UNIQUE INDEX "Lead_organizationId_leadgenId_key" ON "Lead"("organizationId", "leadgenId");
