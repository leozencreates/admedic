import { AdmedicError } from "@admedic/shared";

import { prisma } from "./index";
import type { Role } from "@prisma/client";

/** Kullanıcının bir org içindeki üyeliğini (+durum) döner; yoksa hata fırlatır. */
export async function requireMembership(userId: string, orgId: string) {
  const membership = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
  if (!membership || membership.status !== "ACTIVE") {
    throw new AdmedicError("PERMISSION_ERROR", "Bu organizasyona erişiminiz yok");
  }
  return membership;
}

/** Kullanıcının bir rolde (veya üstünde) olduğunu doğrular. */
export async function requireRole(
  userId: string,
  orgId: string,
  minRole: Role,
) {
  const membership = await requireMembership(userId, orgId);
  const rank: Record<Role, number> = { OWNER: 5, ADMIN: 4, MEDIA_BUYER: 3, ANALYST: 2, VIEWER: 1 };
  if (rank[membership.role] < rank[minRole]) {
    throw new AdmedicError(
      "PERMISSION_ERROR",
      `Bu işlem için en az ${minRole} rolü gerekli (siz: ${membership.role})`,
    );
  }
  return membership;
}

/** Kullanıcının erişebildiği organizasyonları döner. */
export async function listOrgsForUser(userId: string) {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: "ACTIVE" },
    include: { org: true },
  });
  return memberships.map((m) => ({ ...m.org, role: m.role, membershipCreatedAt: m.createdAt }));
}

/** Kullanıcının org içindeki rolünü döner (yoksa undefined). */
export async function getRole(userId: string, orgId: string) {
  const m = await prisma.membership.findUnique({ where: { orgId_userId: { orgId, userId } } });
  return m?.status === "ACTIVE" ? (m.role as Role) : undefined;
}

export interface WorkspaceAccess {
  orgId: string;
  workspaceId: string;
}

/** Tenant filtresi: kullanıcının workspace'e erişimi olduğunu doğrular ve orgId döner. */
export async function assertWorkspaceAccess(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceAccess> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, orgId: true },
  });
  if (!workspace) throw new AdmedicError("NOT_FOUND", "Workspace bulunamadı");
  await requireMembership(userId, workspace.orgId);
  return { orgId: workspace.orgId, workspaceId: workspace.id };
}

/** Kullanıcının ilk (varsayılan) workspace'ini döner. */
export async function defaultWorkspaceFor(userId: string) {
  const memberOrgs = await listOrgsForUser(userId);
  if (memberOrgs.length === 0) return undefined;
  const orgId = memberOrgs[0]!.id;
  const ws = await prisma.workspace.findFirst({
    where: { orgId },
    orderBy: { createdAt: "asc" },
  });
  if (!ws) return undefined;
  return ws;
}