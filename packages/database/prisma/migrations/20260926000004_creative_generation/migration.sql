-- Spec 3.4: kreatif üretim bağlamı — hedeflenen diller, varyasyon sayısı, brief çıktısı ve politika riski
ALTER TABLE "Creative"
  ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "variations" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "brief" JSONB,
  ADD COLUMN "policyRisk" "PolicyRisk",
  ADD COLUMN "policyReport" JSONB;