import { prisma } from "@admedic/database";
import { z } from "zod";
import { CARE_ROLES, requireActor, requireRole } from "../../../_lib/auth";
import { body, HttpError, respond, sameOrigin } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";

export const maxDuration = 15;

const AlertStatusSchema = z.object({ status: z.enum(["ACKED", "RESOLVED"]) }).strict();

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const alert = await prisma.alert.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!alert) throw new HttpError(404, "Uyarı bulunamadı.");
    return { alert };
  });
}

/**
 * Uyarı durumu: OPEN → ACKED ("Görüldü") veya RESOLVED ("Çözüldü"); ACKED → RESOLVED.
 * Çözülen uyarı yeniden açılmaz. Her geçiş `read=true` yapar ve audit'e yazılır.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, CARE_ROLES);
    const { id } = await params;
    const input = await body(request, AlertStatusSchema);
    const alert = await prisma.alert.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!alert) throw new HttpError(404, "Uyarı bulunamadı.");
    if (alert.status === input.status) return { ok: true, alert };
    if (alert.status === "RESOLVED") throw new HttpError(409, "Çözülen uyarı yeniden açılamaz.");
    const resolvedAt = input.status === "RESOLVED" ? new Date() : null;
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.alert.updateMany({
        where: { id, workspaceId: actor.workspaceId, status: alert.status },
        data: { status: input.status, read: true, resolvedAt },
      });
      if (!result.count) throw new HttpError(409, "Uyarı bu sırada değişti; sayfayı yenileyin.");
      await logAudit(
        {
          actor,
          action: input.status === "RESOLVED" ? "ALERT_RESOLVED" : "ALERT_ACKED",
          entityType: "ALERT",
          entityId: id,
          before: { status: alert.status, read: alert.read },
          after: { status: input.status, read: true, resolvedAt: resolvedAt?.toISOString() ?? null },
        },
        tx,
      );
      return tx.alert.findUniqueOrThrow({ where: { id } });
    });
    return { ok: true, alert: updated };
  });
}
