import { prisma } from "@admedic/database";
import { requireActor } from "../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../_lib/http";
import { z } from "zod";
import { loadEnv } from "@admedic/config";
export const maxDuration = 30;
const ConnectSchema = z.object({ platform: z.enum(["GOOGLE_ADS", "TIKTOK", "META"]), accessToken: z.string() }).strict();
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, ConnectSchema);
    loadEnv();
    const accounts = await prisma.adAccount.findMany({ where: { workspaceId: actor.workspaceId, connectionId: input.platform } });
    await prisma.adAccount.create({
      data: {
        orgId: actor.orgId,
        name: input.platform,
        metaAccountId: input.platform === "META" ? `meta_${actor.workspaceId}` : undefined,
        status: "ACTIVE",
      },
    });
    return { name: input.platform, status: "ACTIVE", accounts: accounts.length };
  });
}
