import { prisma } from "@admedic/database";
import { getGraphVersion, graphGet } from "@admedic/meta-api";
import { requireActor } from "../../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../../_lib/http";
import { generateRecommendations, persistRecommendations } from "@admedic/recommendation";
import { z } from "zod";
export const maxDuration = 60;

const SyncSchema = z.object({ experimentId: z.string().min(1) }).strict();

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, SyncSchema);
    const experiment = await prisma.studioExperiment.findUnique({
      where: { id: input.experimentId, draft: { workspaceId: actor.workspaceId } },
      include: { draft: { include: { workspace: { include: { adAccounts: true } } } } },
    });
    if (!experiment) throw new Error("Deney bulunamadı.");
    if (experiment.status !== "RUNNING") throw new Error("Yalnızca çalışan deney senkronize edilebilir.");
    const snapshot = JSON.parse(experiment.snapshot as string) as { variants: { id: string }[]; duration: number };
    const variantIds = snapshot.variants?.map((v: any) => v.id) ?? [];
    const adAccount = experiment.draft.workspace.adAccounts?.find((a: any) => a.isDefault) ?? experiment.draft.workspace.adAccounts?.[0];
    if (!adAccount) throw new Error("Varsayılan reklam hesabı yok.");
    const version = getGraphVersion();
    const token = "";

    for (let i = 0; i < variantIds.length; i++) {
      const rows = await graphGet(version, `act_${adAccount.metaAccountId}/adsets`, { fields: "id,name,status,daily_budget", access_token: token, limit: "100" }, fetch).catch(() => []);
      const adSetIds = (rows as any[]).map((r: any) => r.id);
      for (const adSetId of adSetIds) {
        let insightRows: any[] = [];
        try { insightRows = await graphGet(version, `${adSetId}/insights`, { fields: "impressions,clicks,spend,purchases", access_token: token, datePreset: "last_7d" }, fetch).catch(() => []); }
        catch { continue; }
        for (const row of insightRows) {
          await prisma.experimentMetricPoint.create({
            data: {
              experimentId: experiment.id, variantId: variantIds[i],
              spend: (row as any).spend ?? 0, revenue: 0,
              purchases: (row as any).purchases ?? 0, impressions: (row as any).impressions ?? 0,
              clicks: (row as any).clicks ?? 0, addsToCart: 0, initiatesCheckout: 0,
            },
          });
        }
      }
    }

    const variantTotals = await Promise.all(
      variantIds.map(async (vid: string) => {
        const agg = await prisma.experimentMetricPoint.aggregate({
          where: { experimentId: experiment.id, variantId: vid },
          _sum: { spend: true, clicks: true }, _count: { _all: true },
        });
        return { spend: (agg as any)._sum.spend ?? 0, clicks: (agg as any)._count._all ?? 0, leads: 0 };
      }),
    );
    const elapsedDays = experiment.elapsedDays + 1;
    const completed = elapsedDays >= snapshot.duration;

    await prisma.studioExperiment.updateMany({
      where: { id: experiment.id },
      data: { metrics: JSON.stringify(variantTotals), elapsedDays, status: completed ? "COMPLETED" : "RUNNING", version: { increment: 1 } },
    });

    if (completed) {
      const recs = await generateRecommendations({ experimentId: experiment.id, workspaceId: actor.workspaceId });
      if (recs.length) await persistRecommendations(experiment.id, recs, actor);
    }
    return { result: { status: completed ? "COMPLETED" : "RUNNING", completed } };
  });
}
