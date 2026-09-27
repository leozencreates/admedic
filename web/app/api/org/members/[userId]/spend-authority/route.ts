import { prisma } from "@admedic/database";
import { z } from "zod";
import { requireActor, requireRole } from "../../../../../_lib/auth";
import { body, HttpError, respond, sameOrigin } from "../../../../../_lib/http";
import { logAudit } from "../../../../../_lib/audit";
import { effectiveSpendAuthority, SPEND_DELEGABLE_ROLES } from "../../../../../_lib/spend-authority";

export const maxDuration = 10;

const SpendAuthoritySchema = z.object({ granted: z.boolean() }).strict();

/**
 * Harcama yetkisi devri (spec 3.6: "ACTIVE'ya geçiş ve her bütçe artışı yalnızca Tenant Owner (veya
 * yetki verdiği kişi) tarafından yapılabilir"). Yalnızca OWNER; hedef aynı kuruluşta ACTIVE bir
 * ADMIN veya MEDIA_BUYER olmalıdır. Her değişiklik denetime yazılır; geri alma bir sonraki istekte geçerlidir.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER"]);
    const { userId } = await params;
    const input = await body(request, SpendAuthoritySchema);
    if (userId === actor.userId) throw new HttpError(409, "Owner'ın harcama yetkisi zaten kalıcıdır.");
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Membership" WHERE "orgId" = ${actor.orgId} AND "userId" = ${userId} FOR UPDATE`;
      const member = await tx.membership.findUnique({
        where: { orgId_userId: { orgId: actor.orgId, userId } },
        include: { user: { select: { email: true } } },
      });
      if (!member) throw new HttpError(404, "Üye bulunamadı.");
      if (input.granted) {
        if (member.status !== "ACTIVE") throw new HttpError(409, "Yalnızca aktif üyeye harcama yetkisi verilebilir.");
        if (!SPEND_DELEGABLE_ROLES.includes(member.role))
          throw new HttpError(
            422,
            "Harcama yetkisi yalnızca ADMIN veya MEDIA_BUYER rolündeki üyelere verilebilir.",
          );
      }
      if (member.canApproveSpend === input.granted)
        return { member: { userId, canApproveSpend: effectiveSpendAuthority(member), changed: false } };
      const now = new Date();
      const updated = await tx.membership.update({
        where: { id: member.id },
        data: input.granted
          ? { canApproveSpend: true, spendGrantedBy: actor.userId, spendGrantedAt: now }
          : { canApproveSpend: false, spendGrantedBy: null, spendGrantedAt: null },
      });
      await logAudit({
        actor,
        action: input.granted ? "SPEND_AUTHORITY_GRANTED" : "SPEND_AUTHORITY_REVOKED",
        entityType: "MEMBERSHIP",
        entityId: member.id,
        before: {
          userId,
          role: member.role,
          canApproveSpend: member.canApproveSpend,
          spendGrantedBy: member.spendGrantedBy,
          spendGrantedAt: member.spendGrantedAt?.toISOString() ?? null,
        },
        after: {
          userId,
          role: updated.role,
          canApproveSpend: updated.canApproveSpend,
          spendGrantedBy: updated.spendGrantedBy,
          spendGrantedAt: updated.spendGrantedAt?.toISOString() ?? null,
        },
      }, tx);
      return {
        member: {
          userId,
          email: member.user.email,
          canApproveSpend: effectiveSpendAuthority(updated),
          spendGrantedAt: updated.spendGrantedAt,
          changed: true,
        },
      };
    });
  });
}
