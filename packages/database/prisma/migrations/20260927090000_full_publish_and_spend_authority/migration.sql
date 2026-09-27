-- Spec 3.6: harcama yetkisi devri (ACTIVE geçişi ve bütçe artışı yalnızca Owner veya yetki verdiği kişi)
ALTER TABLE "Membership" ADD COLUMN "canApproveSpend" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "spendGrantedBy" TEXT,
ADD COLUMN "spendGrantedAt" TIMESTAMP(3);

-- Spec 3.11: Instant Form gizlilik politikası bağlantısı (Meta lead formu için zorunlu)
ALTER TABLE "Organization" ADD COLUMN "privacyPolicyUrl" TEXT;

-- Spec 3.3/3.4/3.6: kampanyaya bağlı onaylı içerik, reklam görseli ve Meta yayın ilerlemesi
ALTER TABLE "Campaign" ADD COLUMN "contentDraftIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "content" JSONB,
ADD COLUMN "imageHash" TEXT,
ADD COLUMN "imageUrl" TEXT,
ADD COLUMN "publishState" JSONB,
ADD COLUMN "publishLockedUntil" TIMESTAMP(3);
