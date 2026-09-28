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
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { GET as shellGet } from "../app/api/shell/route";

/**
 * Kabuk özeti (ADR-0017): rozet sayıları ve bildirimler çalışma alanıyla sınırlı ve role göre süzülür.
 * Hasta koordinatörü yalnızca konuşma devri uyarılarını görür; izleyici hiç uyarı/rozet görmez;
 * başka çalışma alanının lead'i ve uyarısı sayılmaz.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("kabuk özeti /api/shell", () => {
  const suffix = randomBytes(8).toString("hex");
  const tokens: Partial<Record<Role, string>> = {};
  const userIds: string[] = [];
  const orgIds: string[] = [];
  const as = (role: Role) => cookieJar.set(SESSION_COOKIE, tokens[role]!);
  const summary = async () => {
    const res = await shellGet();
    expect(res.status).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    for (const foreign of [false, true]) {
      const org = await prisma.organization.create({
        data: {
          name: "Kabuk fixture",
          slug: `shell-${suffix}-${foreign}`,
          workspaces: { create: { name: foreign ? "Yabancı" : "Kabuk klinik", slug: "kabuk" } },
        },
        include: { workspaces: true },
      });
      orgIds.push(org.id);
      const wsId = org.workspaces[0].id;
      // Her iki çalışma alanında: 2 yanıt bekleyen + 1 görüşülen lead, 1 devir + 1 performans uyarısı (+1 çözülmüş).
      for (const status of ["NEW", "NEW", "CONTACTED"] as const) {
        await prisma.lead.create({
          data: { workspaceId: wsId, organizationId: org.id, firstName: "Kabuk", lastName: suffix, channel: "WHATSAPP", status },
        });
      }
      await prisma.alert.createMany({
        data: [
          { workspaceId: wsId, type: "CONVERSATION_ESCALATED", severity: "WARNING", title: "Asistan konuşmayı devretti", message: "m" },
          { workspaceId: wsId, type: "ROAS_DROP", severity: "CRITICAL", title: "ROAS düşüşü", message: "m" },
          { workspaceId: wsId, type: "HIGH_CPA", severity: "WARNING", title: "Çözülmüş", message: "m", status: "RESOLVED" },
        ],
      });
      if (foreign) continue;
      for (const role of ["OWNER", "PATIENT_COORDINATOR", "VIEWER", "ANALYST"] as Role[]) {
        const user = await prisma.user.create({
          data: { email: `${role.toLowerCase()}-shell-${suffix}@example.invalid`, name: role === "OWNER" ? "Selin Kaya" : null },
        });
        userIds.push(user.id);
        await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role } });
        const token = randomBytes(32).toString("hex");
        await prisma.webSession.create({
          data: { tokenHash: tokenHash(token), userId: user.id, workspaceId: wsId, expiresAt: new Date(Date.now() + 120_000) },
        });
        tokens[role] = token;
      }
    }
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("oturum yoksa 401", async () => {
    cookieJar.clear();
    expect((await shellGet()).status).toBe(401);
  });

  it("hesap sahibi: yalnızca kendi çalışma alanının yanıt bekleyen lead'leri ve açık uyarıları; ad ve baş harfler", async () => {
    as("OWNER");
    const body = await summary();
    expect(body.user).toMatchObject({ name: "Selin Kaya", initials: "SK", role: "OWNER", roleLabel: "Hesap sahibi", workspaceName: "Kabuk klinik" });
    expect(body.counts).toMatchObject({ leads: 2, alerts: 2, approvals: 0 });
    expect(body.notifications.map((n: { title: string }) => n.title).sort()).toEqual(["Asistan konuşmayı devretti", "ROAS düşüşü"]);
    expect(body.notifications.every((n: { href: string }) => n.href === "/alerts")).toBe(true);
  });

  it("hasta koordinatörü yalnızca konuşma devri uyarılarını görür", async () => {
    as("PATIENT_COORDINATOR");
    const body = await summary();
    expect(body.counts).toMatchObject({ leads: 2, alerts: 1, approvals: 0 });
    expect(body.notifications.map((n: { title: string }) => n.title)).toEqual(["Asistan konuşmayı devretti"]);
    // Adı olmayan kullanıcıda e-posta gösterilir.
    expect(body.user.name).toContain("@example.invalid");
  });

  it("izleyici rozet ve bildirim görmez; analistin uyarı rozeti bildirim listesiyle aynı (ADR-0022)", async () => {
    as("VIEWER");
    const viewer = await summary();
    expect(viewer.counts).toEqual({ approvals: 0, leads: 0, alerts: 0 });
    expect(viewer.notifications).toEqual([]);
    as("ANALYST");
    const analyst = await summary();
    expect(analyst.counts).toEqual({ approvals: 0, leads: 0, alerts: 2 });
    expect(analyst.notifications).toHaveLength(2);
  });
});
