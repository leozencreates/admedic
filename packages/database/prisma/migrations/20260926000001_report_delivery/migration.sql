-- Spec 3.10: haftalık rapor e-postası teslimat kaydı (dedup)
CREATE TABLE "ReportDelivery" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "recipient" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,

    CONSTRAINT "ReportDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReportDelivery_workspaceId_periodStart_key" ON "ReportDelivery"("workspaceId", "periodStart");
CREATE INDEX "ReportDelivery_workspaceId_periodStart_idx" ON "ReportDelivery"("workspaceId", "periodStart");

ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;