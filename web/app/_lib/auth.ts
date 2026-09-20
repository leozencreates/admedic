import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "./password";
import { HttpError } from "./http";

export const SESSION_COOKIE = "studio-session";
export type Actor = {
  userId: string;
  workspaceId: string;
  orgId: string;
  role: Role;
  workspaceName: string;
};
export async function currentActor(): Promise<Actor | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await prisma.webSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { workspace: true },
  });
  if (!session || session.expiresAt <= new Date()) return null;
  const member = await prisma.membership.findUnique({
    where: {
      orgId_userId: { orgId: session.workspace.orgId, userId: session.userId },
    },
  });
  if (member?.status !== "ACTIVE") return null;
  return {
    userId: member.userId,
    orgId: member.orgId,
    workspaceId: session.workspaceId,
    role: member.role,
    workspaceName: session.workspace.name,
  };
}
export async function requireActor() {
  const actor = await currentActor();
  if (!actor) throw new HttpError(401, "Oturum açmanız gerekiyor.");
  return actor;
}
export async function requirePageActor() {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  return actor;
}
export function requireRole(actor: Actor, roles: Role[]) {
  if (!roles.includes(actor.role))
    throw new HttpError(403, "Bu işlem için yetkiniz yok.");
}
export const EDIT_ROLES: Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER"];
export async function quota(key: string, limit: number, seconds: number) {
  const window = Math.floor(Date.now() / (seconds * 1000));
  const expiresAt = new Date((window + 1) * seconds * 1000);
  const row = await prisma.requestQuota.upsert({
    where: { key: `${key}:${window}` },
    create: { key: `${key}:${window}`, expiresAt },
    update: { count: { increment: 1 } },
  });
  if (row.count > limit)
    throw new HttpError(
      429,
      "Çok fazla deneme. Bir süre sonra tekrar deneyin.",
    );
}
