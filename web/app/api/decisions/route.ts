import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { respond, sameOrigin } from "../../_lib/http";
export const maxDuration = 15;
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const decisions = await prisma.agentDecision.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, take: 20 });
    return { decisions };
  });
}
import { HttpError } from "../../_lib/http";
