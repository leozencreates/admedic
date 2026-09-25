-- Spec 3.3: planlayıcı çıktısı ve planlama girişlerinin kampanya kaydına işlenmiş hali
ALTER TABLE "Campaign" ADD COLUMN "plan" JSONB;