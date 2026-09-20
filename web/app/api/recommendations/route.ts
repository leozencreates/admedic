import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
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

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, GenerateSchema);
    const experiment = await prisma.studioExperiment.findUnique({
      where: { id: input.experimentId, draft: { workspaceId: actor.workspaceId } },
    });
    if (!experiment) throw new Error("Deney bulunamadı.");
    if (experiment.status !== "COMPLETED") throw new Error("Tamamlanan deney için öneri oluşturulabilir.");
    const recs = await generateRecommendations({ experimentId: experiment.id, workspaceId: actor.workspaceId });
    if (!recs.length) throw new Error("Oluşturulacak öneri yok.");
    await persistRecommendations(experiment.id, recs, actor);
    return { recommendations: recs };
  });
}
