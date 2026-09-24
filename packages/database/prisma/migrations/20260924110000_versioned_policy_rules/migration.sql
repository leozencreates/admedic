ALTER TABLE "User" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "PolicyMatcher" AS ENUM ('GUARANTEE_V1', 'BEFORE_AFTER_V1', 'PERSONAL_ATTRIBUTE_V1', 'PHRASES_V1');
CREATE TABLE "policy_rules" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "matcher" "PolicyMatcher" NOT NULL,
  "phrases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "risk" "PolicyRisk" NOT NULL,
  "reason" TEXT NOT NULL,
  "suggestion" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "policy_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "policy_rules_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "policy_rules_key_version_key" ON "policy_rules"("key", "version");

INSERT INTO "policy_rules" ("id", "key", "version", "matcher", "risk", "reason", "suggestion") VALUES
('policy-guarantee-v1', 'guarantee', 1, 'GUARANTEE_V1', 'HIGH', 'Kesin sonuç veya garanti ifadesi.', 'Sonuç vaadi yerine hizmet ve görüşme sürecini anlatın.'),
('policy-before-after-v1', 'before-after', 1, 'BEFORE_AFTER_V1', 'HIGH', 'Önce/sonra karşılaştırması.', 'Karşılaştırmayı kaldırıp tarafsız hizmet bilgisi kullanın.'),
('policy-personal-attribute-v1', 'personal-attribute', 1, 'PERSONAL_ATTRIBUTE_V1', 'HIGH', 'Okuyucunun sağlık veya görünüş özelliği varsayılıyor.', 'Kişiye özellik atfetmek yerine hizmeti genel ifadelerle tanıtın.');
