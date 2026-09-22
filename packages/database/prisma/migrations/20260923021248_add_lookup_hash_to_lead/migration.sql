-- Add lookupHash column to Lead for encrypted duplicate detection
ALTER TABLE "Lead" ADD COLUMN "lookupHash" TEXT NULL;
CREATE INDEX "Lead_lookupHash_index" ON "Lead" ("organizationId", "lookupHash");
