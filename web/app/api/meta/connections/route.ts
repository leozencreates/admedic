import { prisma } from "@admedic/database";
import { requireActor } from "../../../_lib/auth";
import { respond } from "../../../_lib/http";
export const maxDuration = 15;
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const connections = await prisma.metaConnection.findMany({
      where: { orgId: actor.orgId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, type: true, status: true, name: true,
        metaAccountId: true, metaUserId: true, scopes: true,
        missingPermissions: true, pageId: true, instaId: true,
        appId: true, expiresAt: true, lastError: true,
        createdAt: true, updatedAt: true,
      },
    });
    return { connections };
  });
}