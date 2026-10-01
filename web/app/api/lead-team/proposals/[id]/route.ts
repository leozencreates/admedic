import { z } from "zod";
import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { logAudit } from "../../../../_lib/audit";
import { body, HttpError, respond, sameOrigin } from "../../../../_lib/http";

export const maxDuration = 15;

const Schema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * Direktör önerisine insan kararı (ADR-0029): PENDING → APPROVED / REJECTED, yalnızca hesap sahibi ya da yönetici.
 * Onay bir kampanya oluşturmaz, yayına almaz ve harcama başlatmaz; yalnızca önerinin uygulanmaya değer bulunduğunu
 * kaydeder. Kampanya, Yeni kampanya sayfasında kendi onay akışıyla kurulur (ADR-0002, ADR-0014).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const input = await body(request, Schema);
    if (input.decision === "REJECT" && !input.note) throw new HttpError(422, "Reddetme gerekçesini yazın.");
    const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const proposal = await tx.leadTeamProposal.findFirst({ where: { id, workspaceId: actor.workspaceId }, select: { status: true } });
      if (!proposal) throw new HttpError(404, "Öneri bulunamadı; silinmiş olabilir. Sayfayı yenileyin.");
      const result = await tx.leadTeamProposal.updateMany({
        where: { id, workspaceId: actor.workspaceId, status: "PENDING" },
        data: { status, decidedById: actor.userId, decidedAt: now, decisionNote: input.note ?? null },
      });
      if (!result.count) throw new HttpError(409, "Bu öneri için karar zaten verilmiş. Sayfayı yenileyin.");
      await logAudit(
        {
          actor,
          action: status === "APPROVED" ? "LEAD_TEAM_PROPOSAL_APPROVED" : "LEAD_TEAM_PROPOSAL_REJECTED",
          entityType: "LEAD_TEAM_PROPOSAL",
          entityId: id,
          before: { status: "PENDING" },
          after: { status },
        },
        tx,
      );
    });
    return { ok: true, status };
  });
}
