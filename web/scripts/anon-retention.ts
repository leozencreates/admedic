import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";

/**
 * Veri saklama politikası (spec 3.11): Binince ilgili lead'leri
 * org.retentionDays'e göre anonimleştirir. Çıktı kaydını loglar.
 *
 * Kullanım: pnpm --filter @admedic/web retention:run  (opsiyonel DRY_RUN=1)
 */

function olderThan(days: number): Date {
  return new Date(Date.now() - days * 24 * 3600 * 1000);
}

async function main() {
  loadEnv();
  const dryRun = process.env.DRY_RUN === "1";
  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, retentionDays: true },
  });
  let anonymized = 0;
  for (const org of orgs) {
    const days = org.retentionDays ?? 365;
    const cutoff = olderThan(days);
    const stale = await prisma.lead.findMany({
      where: {
        organizationId: org.id,
        updatedAt: { lt: cutoff },
        OR: [
          { status: "LOST" },
          { status: "TREATED" },
          { status: { in: ["NEW", "CONTACTED"] } },
        ],
      },
      select: { id: true },
    });
    if (stale.length === 0) continue;
    if (dryRun) {
      console.log(`[dry-run] ${org.name} (${days}g): ${stale.length} lead anonimleştirilecek`);
      anonymized += stale.length;
      continue;
    }
    const ids = stale.map((l) => l.id);
    await prisma.$transaction(async (tx) => {
      await tx.message.updateMany({
        where: { conversation: { leadId: { in: ids } } },
        data: { content: "[anonymized]", sender: null, metadata: {} },
      });
      await tx.conversation.updateMany({
        where: { leadId: { in: ids } },
        data: { status: "CLOSED", closedAt: new Date(), initiatedBy: null, escalatedTo: null },
      });
      await tx.consentRecord.updateMany({
        where: { leadId: { in: ids } },
        data: { status: "WITHDRAWN", withdrawnAt: new Date(), consentText: "[anonymized]", ip: null, userAgent: null },
      });
      await tx.lead.updateMany({
        where: { id: { in: ids } },
        data: {
          firstName: "[anonymized]", lastName: "[anonymized]", email: null,
          phone: null, country: null, lostReason: null, duplicateOf: null, metadata: {},
        },
      });
    });
    await prisma.auditLog.createMany({
      data: orgs.length
        ? ids.map((id) => ({
            orgId: org.id,
            action: "PRIVACY_RETENTION_ANONYMIZE",
            entityType: "LEAD",
            entityId: id,
            after: { retentionDays: days },
          }))
        : [],
    });
    anonymized += stale.length;
    console.log(`${org.name} (${days}g): ${stale.length} lead anonimleştirildi`);
  }
  console.log(`Tamam: ${anonymized} lead işlendi${dryRun ? " (dry-run)" : ""}.`);
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });