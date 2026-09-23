import { prisma } from "@admedic/database";
import { requireActor } from "../../../_lib/auth";
import { respond, sameOrigin } from "../../../_lib/http";
export const maxDuration = 15;
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const connections = await prisma.metaConnection.findMany({
      where: { orgId: actor.orgId },
      orderBy: { createdAt: "desc" },
    });
    return { connections };
  });
}
import { HttpError } from "../../../_lib/http";
