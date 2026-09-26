import { prisma, anonymizeExpiredLeads } from "@admedic/database";
import { loadEnv } from "@admedic/config";

async function main() {
  loadEnv();
  const dryRun = process.env.DRY_RUN === "1";
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, orgId: true, org: { select: { retentionDays: true } } },
  });
  let anonymized = 0;
  for (const workspace of workspaces) {
    anonymized += await anonymizeExpiredLeads(prisma, {
      orgId: workspace.orgId, workspaceId: workspace.id, retentionDays: workspace.org.retentionDays,
    }, { dryRun });
  }
  console.log(`Tamam: ${anonymized} lead işlendi${dryRun ? " (dry-run)" : ""}.`);
}

main().catch(() => {
  console.error("Saklama süresi işlemi tamamlanamadı.");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
