import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { z } from "zod";

export const maxDuration = 15;

const DefaultSchema = z.object({ isDefault: z.boolean() }).strict();

/** Çoklu reklam hesabında varsayılanı seçer (spec 3.1 kabul: "varsayılanı seçebilir"). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const input = await body(request, DefaultSchema);
    return prisma.$transaction(async (tx) => {
      const account = await tx.adAccount.findFirst({
        where: { id, workspaceId: actor.workspaceId, orgId: actor.orgId },
      });
      if (!account) throw new HttpError(404, "Reklam hesabı bulunamadı. Platformlar sayfasından hesabı kontrol edin ya da Meta ile yeniden bağlanın.");
      if (input.isDefault) {
        await tx.adAccount.updateMany({
          where: { orgId: actor.orgId, workspaceId: actor.workspaceId, isDefault: true },
          data: { isDefault: false },
        });
      } else if (account.isDefault) {
        throw new HttpError(409, "Varsayılan işaretini kaldırmadan önce başka birini varsayılan yapın.");
      }
      const updated = await tx.adAccount.update({
        where: { id },
        data: { isDefault: input.isDefault },
        select: { id: true, name: true, isDefault: true },
      });
      await logAudit(
        {
          actor,
          action: "AD_ACCOUNT_DEFAULT_CHANGED",
          entityType: "AD_ACCOUNT",
          entityId: id,
          before: { isDefault: account.isDefault },
          after: { isDefault: updated.isDefault, name: updated.name },
        },
        tx,
      );
      return { account: updated };
    });
  });
}