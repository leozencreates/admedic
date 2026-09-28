import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../../_lib/http";
import { logAudit } from "../../../../../_lib/audit";
import { refreshMetaConnection } from "../../../../../_lib/meta-connection";

export const maxDuration = 30;

export async function POST(
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
      throw new HttpError(404, "Meta bağlantısı bulunamadı. Meta bağlantıları sayfasını yenileyin; bağlantı yoksa Meta ile bağlantı kurun.");

    const before = {
      status: conn.status,
      expiresAt: conn.expiresAt,
      lastError: conn.lastError,
    };
    const result = await refreshMetaConnection(conn.id);
    await logAudit({
      actor,
      action: "META_TOKEN_REFRESHED",
      entityType: "META_CONNECTION",
      entityId: conn.id,
      before,
      after: {
        status: result.status,
        expiresAt: result.expiresAt,
        refreshed: result.refreshed,
      },
    });
    return { connection: { id: conn.id, ...result } };
  });
}