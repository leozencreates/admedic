import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { hashPassword } from "../app/_lib/password";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined),
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));

import { POST as login } from "../app/api/session/route";

const req = (data: unknown) =>
  new Request("http://localhost:3000/api/session", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(data),
  });

/**
 * Giriş yalnızca e-posta ve parolayla: çalışma alanı kimliği istenmez. Kullanıcının en son oturum açtığı çalışma alanı,
 * hiç oturum yoksa en eskisi açılır; üyesi olmadığı kuruluşun çalışma alanı hiçbir zaman açılmaz.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("oturum açma: çalışma alanı kimliği olmadan", () => {
  const suffix = randomBytes(6).toString("hex");
  const email = `login-${suffix}@example.invalid`;
  const password = "dogru-parola-123";
  const orgIds: string[] = [];
  let userId = "";
  let first = "";
  let second = "";

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password) } });
    userId = user.id;
    const org = await prisma.organization.create({
      data: { name: "Giriş", slug: `login-${suffix}`, members: { create: { userId, role: "OWNER" } } },
    });
    orgIds.push(org.id);
    first = (await prisma.workspace.create({ data: { orgId: org.id, name: "Birinci", slug: "bir" } })).id;
    second = (await prisma.workspace.create({ data: { orgId: org.id, name: "İkinci", slug: "iki" } })).id;
    // Üyesi olmadığı kuruluş.
    const foreign = await prisma.organization.create({
      data: { name: "Yabancı", slug: `login-x-${suffix}`, workspaces: { create: { name: "X", slug: "x" } } },
    });
    orgIds.push(foreign.id);
  });
  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const sessionWorkspace = async () =>
    (await prisma.webSession.findFirstOrThrow({ where: { userId }, orderBy: { expiresAt: "desc" } })).workspaceId;

  it("yanlış parola 401; alan istenmez, eski alan gönderilirse reddedilir", async () => {
    expect((await login(req({ email, password: "yanlis" }))).status).toBe(401);
    expect((await login(req({ email, password, workspace: first }))).status).toBe(400);
  });

  it("ilk girişte en eski çalışma alanı, sonra en son kullanılan açılır", async () => {
    expect((await login(req({ email, password }))).status).toBe(200);
    expect(await sessionWorkspace()).toBe(first);
    await prisma.webSession.create({
      data: { tokenHash: randomBytes(32).toString("hex"), userId, workspaceId: second, expiresAt: new Date(Date.now() + 9 * 3600_000) },
    });
    cookieJar.clear();
    expect((await login(req({ email: email.toUpperCase(), password }))).status).toBe(200);
    expect(await sessionWorkspace()).toBe(second);
  });

  it("etkin üyeliği olmayan kullanıcı giremez", async () => {
    await prisma.membership.updateMany({ where: { userId }, data: { status: "DISABLED" } });
    cookieJar.clear();
    expect((await login(req({ email, password }))).status).toBe(401);
    await prisma.membership.updateMany({ where: { userId }, data: { status: "ACTIVE" } });
  });
});
