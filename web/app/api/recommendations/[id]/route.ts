import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, HttpError, respond, sameOrigin } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";
import { z } from "zod";
export const maxDuration = 60;

/**
 * PATCH: reddetme (PENDING/APPROVED → REJECTED), eski DRAFT kayıtları onaya gönderme
 * (DRAFT → PENDING) ve uygulama hedefi kampanya seçimi (`action.campaignId`).
 * APPROVED/APPLIED buradan verilemez; onay `approve`, uygulama `apply` ucundan geçer.
 */
const PatchSchema = z
  .object({
    status: z.enum(["PENDING", "REJECTED"]).optional(),
    campaignId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.campaignId !== undefined, "Değiştirilecek alan yok.");

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const rec = await prisma.recommendation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!rec) throw new HttpError(404, "Öneri bulunamadı; silinmiş olabilir. Öneriler sayfasını yenileyin.");
    return { recommendation: rec };
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const input = await body(request, PatchSchema);
    const rec = await prisma.recommendation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!rec) throw new HttpError(404, "Öneri bulunamadı; silinmiş olabilir. Öneriler sayfasını yenileyin.");
    const action = { ...((rec.action as Record<string, unknown> | null) ?? {}) };
    const data: { status?: "PENDING" | "REJECTED"; action?: Record<string, unknown> } = {};

    if (input.status === "REJECTED") {
      if (rec.status !== "PENDING" && rec.status !== "APPROVED")
        throw new HttpError(409, "Yalnızca bekleyen veya onaylanmış öneri reddedilebilir. Önerinin durumu değişmiş olabilir; sayfayı yenileyin.");
      data.status = "REJECTED";
    } else if (input.status === "PENDING") {
      if (rec.status !== "DRAFT") throw new HttpError(409, "Yalnızca taslak öneri onaya gönderilebilir. Önerinin durumu değişmiş olabilir; sayfayı yenileyin.");
      data.status = "PENDING";
    }

    if (input.campaignId !== undefined) {
      if (rec.status === "APPLIED" || rec.status === "REJECTED" || rec.status === "EXPIRED")
        throw new HttpError(409, "Kapatılmış öneri için hedef kampanya değiştirilemez. Gerekirse yeni bir öneri oluşturun.");
      if (input.campaignId === null) {
        delete action.campaignId;
      } else {
        const campaign = await prisma.campaign.findFirst({
          where: { id: input.campaignId, workspaceId: actor.workspaceId },
          select: { id: true },
        });
        if (!campaign) throw new HttpError(404, "Kampanya bulunamadı; silinmiş olabilir. Kampanyalar sayfasından yeniden açın.");
        action.campaignId = campaign.id;
      }
      data.action = action;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.recommendation.updateMany({
        where: { id, workspaceId: actor.workspaceId, status: rec.status },
        data: { ...(data.status ? { status: data.status } : {}), ...(data.action ? { action: data.action as object } : {}) },
      });
      if (!result.count) throw new HttpError(409, "Öneri bu sırada değişti; sayfayı yenileyin.");
      await logAudit(
        {
          actor,
          action: data.status === "REJECTED" ? "RECOMMENDATION_REJECTED" : "RECOMMENDATION_UPDATED",
          entityType: "RECOMMENDATION",
          entityId: id,
          before: { status: rec.status, campaignId: (rec.action as Record<string, unknown> | null)?.campaignId ?? null },
          after: { status: data.status ?? rec.status, campaignId: action.campaignId ?? null },
        },
        tx,
      );
      return tx.recommendation.findUniqueOrThrow({ where: { id } });
    });
    return { ok: true, recommendation: updated };
  });
}
