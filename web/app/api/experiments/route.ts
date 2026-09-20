import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { respond } from "../../_lib/http";
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    return {
      experiments: await prisma.studioExperiment.findMany({
        where: { draft: { workspaceId: actor.workspaceId } },
        orderBy: { updatedAt: "desc" },
        take: 100,
        include: { draft: { select: { name: true } } },
      }),
    };
  });
}
