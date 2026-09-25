import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { deliverDisconnectWebhook } from "../../../../_lib/disconnect-webhook";

export const maxDuration = 15;

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const conn = await prisma.metaConnection.findUnique({ where: { id } });
    if (!conn || conn.orgId !== actor.orgId)
      throw new HttpError(404, "Meta bağlantısı bulunamadı.");

    const adAccounts = await prisma.adAccount.findMany({
      where: { connectionId: conn.id },
      select: { id: true },
    });

    await prisma.$transaction([
      prisma.metaConnection.update({
        where: { id: conn.id },
        data: {
          status: "REVOKED",
          tokenCiphertext: null,
          lastError: "Kullanıcı bağlantıyı kesti.",
        },
      }),
      prisma.adAccount.updateMany({
        where: { connectionId: conn.id },
        data: { status: "PAUSED" },
      }),
    ]);

    await logAudit({
      actor,
      action: "META_DISCONNECTED",
      entityType: "META_CONNECTION",
      entityId: conn.id,
      before: { status: conn.status },
      after: { status: "REVOKED", adAccounts: adAccounts.length },
    });

    await deliverDisconnectWebhook({
      workspaceId: actor.workspaceId,
      connectionId: conn.id,
      adAccountIds: adAccounts.map((a) => a.id),
      connectionType: conn.type,
      status: "REVOKED",
      connectionName: conn.name ?? null,
      metaAccountId: conn.metaAccountId ?? null,
    });

    return {
      connection: {
        id: conn.id,
        status: "REVOKED",
        adAccountsPaused: adAccounts.length,
      },
    };
  });
}