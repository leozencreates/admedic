-- Spec 3.9: Meta "lead"/"leadgen" action sayısı ayrı incelik sütunu
-- (daha önce addsToCart+initiatesCheckout+purchases ile türetiliyordu)
ALTER TABLE "InsightSnapshot" ADD COLUMN "leads" INTEGER NOT NULL DEFAULT 0;