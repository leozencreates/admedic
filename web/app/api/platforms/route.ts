import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { respond, sameOrigin } from "../../_lib/http";
import { loadEnv } from "@admedic/config";
export const maxDuration = 15;
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const accounts = await prisma.adAccount.findMany({
      where: { workspaceId: actor.workspaceId },
      select: { id: true, name: true, status: true, syncedAt: true, metaAccountId: true },
    });
    return { platforms: accounts };
  });
}
