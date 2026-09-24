import { prisma } from "@admedic/database";
import { DraftSchema } from "@admedic/llm";
import { policyFor } from "../app/_lib/studio-service";

async function main() {
  const email = process.env.DEMO_EMAIL;
  if (!email) throw new Error("DEMO_EMAIL gerekli.");
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error("Önce demo kullanıcı oluşturulmalı.");
  const workspace = await prisma.workspace.findFirst({ where: {
    org: { members: { some: { userId: user.id, role: "OWNER" } } }, slug: "main",
  } });
  if (!workspace) throw new Error("Demo çalışma alanı bulunamadı.");
  const content = DraftSchema.parse({
    clinic: "EX Kliniği · DEMO", service: "Uluslararası hasta koordinasyonu",
    market: "Almanya", language: "TR", budget: 350, duration: 7,
    variants: [
      { headline: "EX Kliniği ile görüşmenizi planlayın", text: "Uluslararası hasta koordinasyon ekibimizden süreç ve randevu seçenekleri hakkında bilgi alın.", cta: "Bilgi alın" },
      { headline: "Hasta koordinasyon ekibimizle tanışın", text: "Uluslararası hasta koordinasyon ekibimizden süreç ve randevu seçenekleri hakkında bilgi alın.", cta: "Bilgi alın" },
    ],
  });
  const result = await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspace.id }, data: { name: "EX Kliniği · DEMO", currency: "EUR" } });
    await tx.organization.update({ where: { id: workspace.orgId }, data: { name: "EX Kliniği · DEMO" } });
    const old = await tx.studioDraft.findFirst({ where: {
      workspaceId: workspace.id, name: { in: ["A/B Deneyi - Kadın Doktor", "EX Kliniği · DEMO A/B"] },
    } });
    const data = { name: "EX Kliniği · DEMO A/B", content, policy: await policyFor(content, workspace.id), status: "APPROVED" as const };
    const draft = old
      ? await tx.studioDraft.update({ where: { id: old.id }, data })
      : await tx.studioDraft.create({ data: { ...data, workspaceId: workspace.id } });
    const experiment = await tx.studioExperiment.upsert({
      where: { draftId: draft.id },
      create: { draftId: draft.id, snapshot: content, metrics: [{ spend: 50, clicks: 120, leads: 6 }, { spend: 50, clicks: 150, leads: 12 }], elapsedDays: 2, status: "RUNNING" },
      update: { snapshot: content, metrics: [{ spend: 50, clicks: 120, leads: 6 }, { spend: 50, clicks: 150, leads: 12 }], elapsedDays: 2, status: "RUNNING", version: { increment: 1 } },
    });
    await tx.adAccount.updateMany({ where: { workspaceId: workspace.id, metaAccountId: "act_demo_001" }, data: { name: "EX Kliniği · DEMO", currency: "EUR" } });
    await tx.campaign.updateMany({ where: { workspaceId: workspace.id, metaCampaignId: "camp_demo_001" }, data: { name: "EX Kliniği · DEMO A/B", dailyBudget: 5000 } });
    await tx.adSet.updateMany({ where: { workspaceId: workspace.id, metaAdSetId: { in: ["adset_001", "adset_002"] } }, data: { dailyBudget: 2500 } });
    return experiment;
  });
  console.log(JSON.stringify({ workspaceId: workspace.id, experimentUrl: `/tests/${result.id}`, totalBudgetEUR: 350, dailyBudgetEUR: 50 }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
