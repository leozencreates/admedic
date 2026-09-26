import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../_lib/http";
import { z } from "zod";
import { loadEnv } from "@admedic/config";
import { createMetaClient } from "@admedic/meta-api";
import { encrypt } from "../../../_lib/encrypt";
import { logAudit } from "../../../_lib/audit";
import { syncDiscoveredAdAccounts } from "../../../_lib/meta-connection";
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
      const connData = {
        status: "CONNECTED" as const,
        tokenCiphertext: encrypt(input.accessToken),
        lastError: null as string | null,
      };
      if (existingConn) {
        await prisma.metaConnection.update({
          where: { id: existingConn.id },
          data: connData,
        });
        connectionId = existingConn.id;
      } else {
        const conn = await prisma.metaConnection.create({
          data: {
            orgId: actor.orgId,
            type: "BUSINESS_MANAGER",
            name: "Platform API",
            ...connData,
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
    if (input.platform === "META" && connectionId && !loadEnv().META_MOCK_MODE) {
      try {
        const discovered = await createMetaClient({ mock: false }).getAdAccounts(input.accessToken);
        // Varsayılan hesap bayrağı döngü içinde güncellenir (yalnızca ilk hesap varsayılan olur).
        await syncDiscoveredAdAccounts(actor, connectionId, discovered);
      } catch (err) {
        console.warn(`[platforms/connect] reklam hesabı keşfi başarısız: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      }
    }
    return { name: input.platform, status: "ACTIVE", accounts: 1 };
  });
}
