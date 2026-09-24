-- Paket 6: spec 3.2, 3.4, 3.5, 3.7, 3.8, 3.11 boşlukları

ALTER TYPE "Role" ADD VALUE 'PATIENT_COORDINATOR';

-- 3.11: tenant saklama süresi + tenant'a özel rıza metni
ALTER TABLE "Organization" ADD COLUMN "retentionDays" INTEGER NOT NULL DEFAULT 365;
ALTER TABLE "Organization" ADD COLUMN "consentText" TEXT;

-- 3.2: klinik profili akreditasyon, belge ve marka kılavuzu
ALTER TABLE "ClinicProfile" ADD COLUMN "accreditations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ClinicProfile" ADD COLUMN "brandLogo" TEXT;
ALTER TABLE "ClinicProfile" ADD COLUMN "brandColors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ClinicProfile" ADD COLUMN "brandTone" TEXT;
ALTER TABLE "ClinicProfile" ADD COLUMN "brandBannedPhrases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 3.2: hizmet paket içeriği ve başlangıç fiyatı bayrağı
ALTER TABLE "Service" ADD COLUMN "packageIncludes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Service" ADD COLUMN "showStartingPrice" BOOLEAN NOT NULL DEFAULT true;

-- 3.7: ilgilenilen işlem (lead birleşik kartı)
ALTER TABLE "Lead" ADD COLUMN "interestedService" TEXT;

-- 3.8: koordinatörün ilk yanıt süresi (başarı metriği)
ALTER TABLE "Conversation" ADD COLUMN "firstResponseAt" TIMESTAMP(3);

-- 3.5: Meta reklam inceleme durumu ve red gerekçesi
ALTER TABLE "Campaign" ADD COLUMN "metaReviewStatus" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "metaRejectionReason" JSONB;