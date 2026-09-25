import { prisma } from "@admedic/database";
import { requireActor } from "../../../_lib/auth";
import { respond } from "../../../_lib/http";

export const maxDuration = 15;

export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const accounts = await prisma.adAccount.findMany({
      where: { workspaceId: actor.workspaceId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        metaAccountId: true,
        currency: true,
        timezone: true,
        status: true,
        isDefault: true,
        syncedAt: true,
        connection: {
          select: {
            id: true,
            status: true,
            name: true,
            expiresAt: true,
          },
        },
      },
    });
    return { accounts };
  });
}