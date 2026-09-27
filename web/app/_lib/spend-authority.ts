import { prisma, type Prisma, type Role } from "@admedic/database";
import type { Actor } from "./auth";
import { HttpError } from "./http";

/**
 * Harcama yetkisi devredilebilecek roller: içerik/bütçe düzenleyebilen, Owner olmayan üyeler.
 * Hasta koordinatörü, analist ve izleyici bütçe uçlarına zaten erişemez; onlara yetki verilmez.
 */
export const SPEND_DELEGABLE_ROLES: readonly Role[] = ["ADMIN", "MEDIA_BUYER"];

export const SPEND_AUTHORITY_MESSAGE =
  "Bu işlem yalnızca kuruluş sahibi (Owner) veya Owner'ın harcama yetkisi verdiği üye tarafından yapılabilir.";

/** Üyelik satırından etkin harcama yetkisi: Owner her zaman; diğerleri yalnızca devredilebilir rolde ve yetki verilmişse. */
export function effectiveSpendAuthority(member: {
  role: Role;
  status?: string;
  canApproveSpend: boolean;
}): boolean {
  if (member.status !== undefined && member.status !== "ACTIVE") return false;
  if (member.role === "OWNER") return true;
  return member.canApproveSpend && SPEND_DELEGABLE_ROLES.includes(member.role);
}

/**
 * Spec 3.6: "ACTIVE'ya geçiş ve her bütçe artışı yalnızca Tenant Owner (veya yetki verdiği kişi)
 * tarafından yapılabilir." Yetki her çağrıda veritabanından taze okunur; geri alınan yetki bir
 * sonraki istekte hemen geçersizdir.
 */
export async function hasSpendAuthority(
  actor: Pick<Actor, "orgId" | "userId">,
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const member = await db.membership.findUnique({
    where: { orgId_userId: { orgId: actor.orgId, userId: actor.userId } },
    select: { role: true, status: true, canApproveSpend: true },
  });
  return member ? effectiveSpendAuthority(member) : false;
}

export async function requireSpendAuthority(
  actor: Pick<Actor, "orgId" | "userId">,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  if (!(await hasSpendAuthority(actor, db))) throw new HttpError(403, SPEND_AUTHORITY_MESSAGE);
}
