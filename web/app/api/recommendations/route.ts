import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../_lib/auth";
import { body, HttpError, respond, sameOrigin } from "../../_lib/http";
import { logAudit } from "../../_lib/audit";
import { generateRecommendations, persistRecommendations } from "@admedic/recommendation";
import { z } from "zod";
export const maxDuration = 60;

const GenerateSchema = z.object({ experimentId: z.string().min(1) }).strict();

export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const recs = await prisma.recommendation.findMany({
      where: { workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { recommendations: recs };
  });
}

/** Tamamlanan deney için öneri üretir ve PENDING olarak kaydeder (OWNER/ADMIN). */
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, GenerateSchema);
    const experiment = await prisma.studioExperiment.findFirst({
      where: { id: input.experimentId, draft: { workspaceId: actor.workspaceId } },
      select: { id: true, status: true },
    });
    if (!experiment) throw new HttpError(404, "Deney bulunamadı.");
    if (experiment.status !== "COMPLETED") throw new HttpError(409, "Öneri yalnızca tamamlanan deney için oluşturulabilir.");
    const recs = await generateRecommendations({ experimentId: experiment.id, workspaceId: actor.workspaceId });
    if (!recs.length) throw new HttpError(409, "Oluşturulacak öneri yok.");
    const saved = await persistRecommendations(experiment.id, recs, actor);
    await logAudit({
      actor,
      action: "RECOMMENDATIONS_GENERATED",
      entityType: "STUDIO_EXPERIMENT",
      entityId: experiment.id,
      after: { recommendations: saved.map((r) => ({ id: r.id, type: r.type, priority: r.priority })) },
    });
    return { recommendations: saved };
  });
}
