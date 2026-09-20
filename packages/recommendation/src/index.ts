import { prisma } from "@admedic/database";

export interface RecommendationInput {
  experimentId: string;
  workspaceId: string;
}

export interface RecommendationOutput {
  id: string;
  type: string;
  title: string;
  description: string;
  reasoning: string;
  action: Record<string, unknown>;
  expectedImpact: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  status: string;
  version: number;
}

export async function generateRecommendations(input: RecommendationInput): Promise<RecommendationOutput[]> {
  const experiment = await prisma.studioExperiment.findUnique({
    where: { id: input.experimentId },
    include: { draft: { include: { workspace: true } } },
  });
  if (!experiment || experiment.status !== "COMPLETED") return [];

  const snapshot = JSON.parse(experiment.snapshot as string) as { variants: { headline: string }[] };
  const metrics = JSON.parse(experiment.metrics as string) as [any, any];
  const [a, b] = metrics;
  const winner = a.leads > b.leads ? "A" : b.leads > a.leads ? "B" : null;
  const recommendations: RecommendationOutput[] = [];

  if (winner) {
    const winnerIdx = winner === "A" ? 0 : 1;
    const winnerVariant = snapshot.variants[winnerIdx];
    const winnerCpl = a.spend > 0 ? a.spend / a.leads : Infinity;
    const loserCpl = b.spend > 0 ? b.spend / b.leads : Infinity;
    const savings = loserCpl < Infinity ? (loserCpl - winnerCpl) * a.leads : 0;

    recommendations.push({
      id: `rec-${experiment.id}-budget`,
      type: "BUDGET_REALLOCATION",
      title: `${winnerVariant.headline} — bütçe yeniden dağıtımı`,
      description: `${winner} varyantı ${a.leads - b.leads} daha fazla lead üretti. Bütçe %70 ${winner} / %30 ${winner === "A" ? "B" : "A"} olarak yeniden dağıtılması önerilir.`,
      reasoning: `${winner} varyantı daha düşük CPL ile daha fazla lead üretti. Gerçek Meta metrikleri üzerinden hesaplanmıştır.`,
      action: { type: "BUDGET_REALLOCATION", variantWinner: winner, budgetSplit: [70, 30] },
      expectedImpact: { estimatedAdditionalLeads: Math.max(0, a.leads - b.leads), estimatedSavings: Math.round(savings) },
      evidence: [{ metric: "leads", variantA: a.leads, variantB: b.leads, winner }],
      status: "DRAFT",
      version: 1,
    });
  }

  if (a.leads === 0 && b.leads === 0) {
    recommendations.push({
      id: `rec-${experiment.id}-end`,
      type: "EXPERIMENT_END",
      title: "Henüz dönüşüm yok — deney değerlendirilmeli",
      description: "Her iki varyant da henüz lead üretmemiştir. Deney süresi dolmadan önce sonuçlar belirgin olmayabilir. Devam ettir veya taslağa dön.",
      reasoning: "Meta Insights'a göre harcama var ancak dönüşüm (lead) kaydı yok. Sadece tıklama varsa kreatif odaklı değişiklik gerekebilir.",
      action: { type: "EXPERIMENT_END" },
      expectedImpact: {},
      evidence: [{ metric: "leads", variantA: 0, variantB: 0 }],
      status: "DRAFT",
      version: 1,
    });
  }

  return recommendations;
}

export async function persistRecommendations(experimentId: string, recommendations: RecommendationOutput[], actor: { workspaceId: string; userId: string }) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.recommendation.findMany({ where: { experimentId } });
    for (const rec of existing) {
      await tx.recommendation.update({ where: { id: rec.id }, data: { status: "EXPIRED" } });
    }
    const saved: RecommendationOutput[] = [];
    for (const rec of recommendations) {
      const created = await tx.recommendation.create({
        data: {
          workspaceId: actor.workspaceId,
          experimentId,
          type: rec.type as any,
          title: rec.title,
          description: rec.description,
          reasoning: rec.reasoning,
           action: rec.action as any,
           expectedImpact: rec.expectedImpact as any,
           evidence: rec.evidence as any,
          status: rec.status as any,
          version: rec.version,
        },
      });
      saved.push({ ...rec, id: created.id });
    }
    return saved;
  });
}
