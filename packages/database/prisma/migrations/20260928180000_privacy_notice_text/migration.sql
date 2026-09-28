-- KVKK İlke Kararı 2026/347: aydınlatma metni açık rıza metninden ayrı tutulur (ADR-0016).
-- Organization.consentText bundan sonra yalnızca açık rıza metnidir; aydınlatma metni yeni alanda.
ALTER TABLE "Organization" ADD COLUMN "privacyNoticeText" TEXT;
