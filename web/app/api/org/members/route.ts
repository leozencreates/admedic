import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { respond } from "../../../_lib/http";
import { effectiveSpendAuthority, SPEND_DELEGABLE_ROLES } from "../../../_lib/spend-authority";

/**
 * Kuruluş üyeleri ve harcama yetkisi durumu (spec 3.6). OWNER/ADMIN görüntüler; yetkiyi yalnızca
 * OWNER verir/geri alır (`PUT /api/org/members/[userId]/spend-authority`).
 */
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const members = await prisma.membership.findMany({
      where: { orgId: actor.orgId },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    const grantorIds = Array.from(new Set(members.map((m) => m.spendGrantedBy).filter((v): v is string => Boolean(v))));
    const grantors = grantorIds.length
      ? await prisma.user.findMany({ where: { id: { in: grantorIds } }, select: { id: true, email: true } })
      : [];
    const grantorEmail = new Map(grantors.map((u) => [u.id, u.email]));
    return {
      canManageSpendAuthority: actor.role === "OWNER",
      members: members.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        status: m.status,
        isSelf: m.userId === actor.userId,
        /** Etkin yetki: Owner her zaman; diğerleri devredilebilir rolde ve yetki verilmişse. */
        canApproveSpend: effectiveSpendAuthority(m),
        delegable: SPEND_DELEGABLE_ROLES.includes(m.role) && m.status === "ACTIVE",
        spendGrantedAt: m.canApproveSpend ? m.spendGrantedAt : null,
        spendGrantedBy: m.canApproveSpend && m.spendGrantedBy ? (grantorEmail.get(m.spendGrantedBy) ?? null) : null,
      })),
    };
  });
}
