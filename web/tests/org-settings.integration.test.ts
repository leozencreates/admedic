import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { GET, PATCH } from "../app/api/org/settings/route";
import { POST as campaignsPost } from "../app/api/campaigns/route";

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("org settings: monthly cap in cents, recipient, retention, consent", () => {
  const suffix = randomBytes(8).toString("hex");
  const users: string[] = [];
  const orgs: string[] = [];
  const tokens: Record<string, string> = {};
  let orgId = "";

  beforeAll(async () => {
    for (const foreign of [false, true]) {
      const org = await prisma.organization.create({
        data: {
          name: "Settings fixture",
          slug: `settings-${suffix}-${foreign}`,
          monthlyAdBudgetCap: foreign ? null : 500_000, // 5.000,00 EUR
          workspaces: { create: { name: "Settings", slug: "settings" } },
        },
        include: { workspaces: true },
      });
      orgs.push(org.id);
      if (!foreign) {
        orgId = org.id;
        await prisma.adAccount.create({
          data: { orgId: org.id, workspaceId: org.workspaces[0].id, name: "Settings account", currency: "USD", status: "ACTIVE" },
        });
      }
      for (const role of (foreign ? ["OWNER"] : ["OWNER", "ADMIN", "MEDIA_BUYER", "VIEWER"]) as Role[]) {
        const user = await prisma.user.create({ data: { email: `${suffix}-${foreign}-${role}@example.invalid` } });
        users.push(user.id);
        await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role } });
        const token = randomBytes(32).toString("hex");
        await prisma.webSession.create({
          data: { tokenHash: tokenHash(token), userId: user.id, workspaceId: org.workspaces[0].id, expiresAt: new Date(Date.now() + 600_000) },
        });
        tokens[foreign ? "FOREIGN" : role] = token;
      }
    }
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  const patch = (role: string, body: unknown, origin = "http://localhost:3000") => {
    cookieJar.set(SESSION_COOKIE, tokens[role]);
    return PATCH(new Request("http://localhost:3000/api/org/settings", {
      method: "PATCH", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
  };
  const get = async (role: string) => {
    cookieJar.set(SESSION_COOKIE, tokens[role]);
    return (await (await GET()).json()).settings;
  };

  it("GET returns the cap in cents and major units plus the account currency", async () => {
    const settings = await get("VIEWER");
    expect(settings).toMatchObject({
      monthlyAdBudgetCapCents: 500_000, monthlyAdBudgetCap: 5000, currency: "USD",
      retentionDays: 365, consentText: null, reportRecipient: null,
    });
    expect(await get("FOREIGN")).toMatchObject({ monthlyAdBudgetCapCents: null, monthlyAdBudgetCap: null, currency: "EUR" });
  });

  it("OWNER/ADMIN update cap (major → cents), recipient, retention and consent with audit; others are rejected", async () => {
    expect((await patch("MEDIA_BUYER", { monthlyAdBudgetCap: 100 })).status).toBe(403);
    expect((await patch("VIEWER", { retentionDays: 90 })).status).toBe(403);
    expect((await patch("OWNER", { monthlyAdBudgetCap: 100 }, "https://other.invalid")).status).toBe(403);
    for (const bad of [{ monthlyAdBudgetCap: 0 }, { monthlyAdBudgetCap: -5 }, { reportRecipient: "not-an-email" }, { retentionDays: 1 }, { unknown: 1 }])
      expect((await patch("OWNER", bad)).status).toBe(400);

    const updated = await patch("ADMIN", {
      monthlyAdBudgetCap: 1234.56, reportRecipient: "raporlar@example.invalid", retentionDays: 180, consentText: "Aydınlatma metni",
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).settings).toMatchObject({
      monthlyAdBudgetCapCents: 123_456, monthlyAdBudgetCap: 1234.56, reportRecipient: "raporlar@example.invalid", retentionDays: 180, consentText: "Aydınlatma metni",
    });
    const row = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(row.monthlyAdBudgetCap).toBe(123_456);
    expect(row.reportRecipient).toBe("raporlar@example.invalid");
    const audit = await prisma.auditLog.findFirst({ where: { orgId, action: "ORG_SETTINGS_UPDATED" }, orderBy: { createdAt: "desc" } });
    expect(audit?.before).toMatchObject({ monthlyAdBudgetCapCents: 500_000, reportRecipient: null });
    expect(audit?.after).toMatchObject({ monthlyAdBudgetCapCents: 123_456, reportRecipient: "raporlar@example.invalid", retentionDays: 180 });
  });

  it("only the Owner may raise or remove the cap (even a delegated admin may only lower it)", async () => {
    // Başlangıç: önceki testten 123.456 cent.
    expect((await patch("ADMIN", { monthlyAdBudgetCap: 2000 })).status).toBe(403);
    expect((await patch("ADMIN", { monthlyAdBudgetCap: null })).status).toBe(403);
    await prisma.membership.updateMany({ where: { orgId, role: "ADMIN" }, data: { canApproveSpend: true } });
    const denied = await patch("ADMIN", { monthlyAdBudgetCap: 2000 });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatch(/Owner/);
    await prisma.membership.updateMany({ where: { orgId, role: "ADMIN" }, data: { canApproveSpend: false } });
    expect((await patch("ADMIN", { monthlyAdBudgetCap: 1000 })).status).toBe(200);
    expect((await patch("OWNER", { monthlyAdBudgetCap: 2000 })).status).toBe(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).monthlyAdBudgetCap).toBe(200_000);
  });

  it("stores an https privacy policy link for Instant Forms and reports active commitments", async () => {
    for (const bad of ["http://klinik.example/gizlilik", "gizlilik", "javascript:alert(1)"])
      expect((await patch("ADMIN", { privacyPolicyUrl: bad })).status).toBe(400);
    const ok = await patch("ADMIN", { privacyPolicyUrl: "https://klinik.example/gizlilik" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).settings).toMatchObject({ privacyPolicyUrl: "https://klinik.example/gizlilik", monthlyCommittedCents: 0 });
    const audit = await prisma.auditLog.findFirst({ where: { orgId, action: "ORG_SETTINGS_UPDATED" }, orderBy: { createdAt: "desc" } });
    expect(audit?.after).toMatchObject({ privacyPolicyUrl: "https://klinik.example/gizlilik" });
    const account = await prisma.adAccount.findFirstOrThrow({ where: { orgId } });
    await prisma.campaign.create({ data: { adAccountId: account.id, name: "Aktif", dailyBudget: 1_000, status: "ACTIVE", workflowStatus: "ACTIVE" } });
    expect((await get("VIEWER")).monthlyCommittedCents).toBe(30_000);
    await prisma.campaign.deleteMany({ where: { adAccountId: account.id, name: "Aktif" } });
    expect((await patch("OWNER", { privacyPolicyUrl: null })).status).toBe(200);
  });

  it("the cap is enforced in cents on campaign drafts and null removes it", async () => {
    expect((await patch("OWNER", { monthlyAdBudgetCap: 300 })).status).toBe(200); // 30.000 cent
    cookieJar.set(SESSION_COOKIE, tokens["OWNER"]);
    const mk = (budget: number) => campaignsPost(new Request("http://localhost:3000/api/campaigns", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ name: `Cap ${suffix}`, budget }),
    }));
    expect((await mk(10.01)).status).toBe(422); // 1.001 × 30 = 30.030 > 30.000
    const ok = await mk(10);
    expect(ok.status).toBe(200);
    expect((await ok.json()).campaign).toMatchObject({ budgetCents: 1000, currency: "USD" });

    const cleared = await patch("OWNER", { monthlyAdBudgetCap: null, reportRecipient: null });
    expect((await cleared.json()).settings).toMatchObject({ monthlyAdBudgetCapCents: null, monthlyAdBudgetCap: null, reportRecipient: null });
    expect((await mk(5000)).status).toBe(200);
    expect((await get("OWNER")).monthlyAdBudgetCapCents).toBeNull();
  });
});
