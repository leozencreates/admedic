import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined),
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));

import { GET as goLive } from "../app/api/go-live/route";
import { POST as metaCheck } from "../app/api/go-live/meta-check/route";

const req = (url: string, method: string) =>
  new Request(`http://localhost:3000${url}`, { method, headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });

/** Canlıya geçiş denetimi (ADR-0023): yalnızca hesap sahibi; değer sızdırmaz; deneme modunda Meta'ya gitmez. */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("canlıya geçiş denetimi", () => {
  const suffix = randomBytes(6).toString("hex");
  const tokens: Partial<Record<Role, string>> = {};
  const userIds: string[] = [];
  let orgId = "";
  const as = (role: Role) => cookieJar.set(SESSION_COOKIE, tokens[role]!);

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: "Canlı", slug: `golive-${suffix}`, workspaces: { create: { name: "Ws", slug: "ws" } } },
      include: { workspaces: true },
    });
    orgId = org.id;
    for (const role of ["OWNER", "ADMIN"] as Role[]) {
      const user = await prisma.user.create({ data: { email: `${role.toLowerCase()}-golive-${suffix}@example.invalid` } });
      userIds.push(user.id);
      await prisma.membership.create({ data: { orgId, userId: user.id, role } });
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({ data: { tokenHash: tokenHash(token), userId: user.id, workspaceId: org.workspaces[0].id, expiresAt: new Date(Date.now() + 120_000) } });
      tokens[role] = token;
    }
  });
  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("yalnızca hesap sahibi açar", async () => {
    as("ADMIN");
    expect((await goLive()).status).toBe(403);
    expect((await metaCheck(req("/api/go-live/meta-check", "POST"))).status).toBe(403);
  });

  it("deneme modu engel olarak görünür; gizli değerler yanıtta yok", async () => {
    as("OWNER");
    const res = await goLive();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.find((c: { key: string }) => c.key === "mode")).toMatchObject({ status: "fail" });
    expect(body.e2e).toEqual({ live: false, checks: [] });
    const text = JSON.stringify(body);
    for (const name of ["ENCRYPTION_KEY", "AUTH_SECRET", "META_APP_SECRET"]) {
      const value = process.env[name];
      if (value && value.length > 8) expect(text).not.toContain(value);
    }
  });

  it("Meta denetimi deneme modunda Meta'ya gitmez ve denetim kaydı yazar", async () => {
    as("OWNER");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await metaCheck(req("/api/go-live/meta-check", "POST"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ live: false, connections: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(await prisma.auditLog.count({ where: { orgId, action: "GO_LIVE_META_CHECK" } })).toBe(1);
  });
});
