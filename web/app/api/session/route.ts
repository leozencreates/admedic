import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { homePathForRole } from "../../_lib/navigation";
import { prisma } from "@admedic/database";
import { currentActor, quota, SESSION_COOKIE } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { tokenHash, verifyPassword } from "../../_lib/password";
import { hasSpendAuthority } from "../../_lib/spend-authority";

export async function GET() {
  return respond(async () => {
    const actor = await currentActor();
    // Arayüz etkinleştirme/bütçe artışı düğmelerini buna göre gösterir; yetki her işlemde sunucuda yeniden doğrulanır.
    return { actor: actor ? { ...actor, canApproveSpend: await hasSpendAuthority(actor) } : null };
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const input = await body(
      request,
      z
        .object({
          email: z
            .string()
            .trim()
            .email()
            .max(254)
            .transform((s) => s.toLowerCase()),
          password: z.string().min(1).max(256),
          workspace: z.string().trim().min(1).max(100),
        })
        .strict(),
    );
    await quota(`login:${tokenHash(input.email)}`, 10, 900);
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });
    const verified = await verifyPassword(
      input.password,
      user?.passwordHash ?? null,
    );
    const workspace =
      user && verified
        ? await prisma.workspace.findFirst({
            where: {
              id: input.workspace,
              org: { members: { some: { userId: user.id, status: "ACTIVE" } } },
            },
          })
        : null;
    if (!user || !workspace)
      throw new HttpError(
        401,
        "E-posta, parola veya çalışma alanı bilgileri geçersiz.",
      );
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 8 * 3600_000);
    const jar = await cookies();
    const old = jar.get(SESSION_COOKIE)?.value;
    await prisma.$transaction(async (tx) => {
      if (old)
        await tx.webSession.deleteMany({
          where: { tokenHash: tokenHash(old) },
        });
      await tx.webSession.create({
        data: {
          tokenHash: tokenHash(token),
          userId: user.id,
          workspaceId: workspace.id,
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          orgId: workspace.orgId,
          workspaceId: workspace.id,
          userId: user.id,
          action: "SESSION_CREATED",
          entityType: "SESSION",
        },
      });
    });
    jar.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });
    // Girişten sonra rolün ana sayfası (koordinatör → Lead CRM), ADR-0016.
    const member = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId: workspace.orgId, userId: user.id } },
      select: { role: true },
    });
    return { ok: true, home: homePathForRole(member?.role) };
  });
}
export async function DELETE(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) {
      await prisma.$transaction(async (tx) => {
        const session = await tx.webSession.findUnique({
          where: { tokenHash: tokenHash(token) },
          include: { workspace: true },
        });
        if (session) {
          await tx.webSession.delete({
            where: { tokenHash: session.tokenHash },
          });
          await tx.auditLog.create({
            data: {
              orgId: session.workspace.orgId,
              workspaceId: session.workspaceId,
              userId: session.userId,
              action: "SESSION_REVOKED",
              entityType: "SESSION",
            },
          });
        }
      });
    }
    jar.delete(SESSION_COOKIE);
    return { ok: true };
  });
}
