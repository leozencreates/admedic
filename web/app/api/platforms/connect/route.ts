import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../_lib/http";
import { z } from "zod";
import { loadEnv } from "@admedic/config";
import { logAudit } from "../../../_lib/audit";
export const maxDuration = 30;
const ConnectSchema = z.object({ platform: z.enum(["GOOGLE_ADS", "TIKTOK", "META"]), accessToken: z.string() }).strict();
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, ConnectSchema);
    loadEnv();
    let connectionId: string | null = null;
    if (input.platform === "META") {
      const existingConn = await prisma.metaConnection.findFirst({
        where: { orgId: actor.orgId, type: "BUSINESS_MANAGER" },
        select: { id: true },
      });
      if (existingConn) {
        await prisma.metaConnection.update({
          where: { id: existingConn.id },
          data: { status: "CONNECTED" },
        });
        connectionId = existingConn.id;
      } else {
        const conn = await prisma.metaConnection.create({
          data: {
            orgId: actor.orgId,
            type: "BUSINESS_MANAGER",
            name: "Platform API",
            status: "CONNECTED",
          },
        });
        connectionId = conn.id;
      }
    }
    const existing = await prisma.adAccount.findFirst({
      where: {
        workspaceId: actor.workspaceId,
        ...(connectionId
          ? { connectionId }
          : { name: input.platform, connectionId: null }),
      },
    });
    if (existing) {
      await prisma.adAccount.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", name: input.platform },
      });
    } else {
      await prisma.adAccount.create({
        data: {
          orgId: actor.orgId,
          workspaceId: actor.workspaceId,
          name: input.platform,
          connectionId,
          metaAccountId: input.platform === "META" ? `meta_${actor.workspaceId}` : undefined,
          status: "ACTIVE",
        },
      });
    }
    await logAudit({
      actor,
      action: "PLATFORM_CONNECTED",
      entityType: "AD_ACCOUNT",
      after: { platform: input.platform, status: "ACTIVE" },
    });
    return { name: input.platform, status: "ACTIVE", accounts: 1 };
  });
}
