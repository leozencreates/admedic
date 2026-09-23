import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) =>
      cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { POST as clinicsPost } from "../app/api/clinics/route";
import { GET as clinicGet, PATCH as clinicPatch } from "../app/api/clinics/[id]/route";
import { POST as campaignsPost } from "../app/api/campaigns/route";
import { POST as creativePost } from "../app/api/creative/route";
import { POST as leadsPost } from "../app/api/leads/route";
import { GET as leadGet, PATCH as leadPatch, DELETE as leadDelete } from "../app/api/leads/[id]/route";
import { POST as platformsConnect } from "../app/api/platforms/connect/route";
import { POST as billingCheckout } from "../app/api/billing/stripe/checkout/route";
import { GET as metaOauth } from "../app/api/meta/oauth/route";

function req(url: string, method: string, bodyObj?: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}
function withOrigin(request: Request) {
  request.headers.set("origin", "http://localhost:3000");
  return request;
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")(
  "role, tenant isolation and audit coverage",
  () => {
    const suffix = randomBytes(8).toString("hex");
    const orgIds: string[] = [];
    const workspaceIds: string[] = [];
    const userIds: string[] = [];
    let tokenOwner = "";
    let tokenViewer = "";
    let tokenBuyer = "";
    let tokenForeign = "";

    beforeAll(async () => {
      vi.stubEnv("ENCRYPTION_KEY", "82da20c19f1765f384e674dc19d7c4ecdc7dd6475527fa1cf5465f43092e21cf");
      const mkUser = async () =>
        prisma.user.create({ data: { email: `${randomBytes(4).toString("hex")}-${suffix}@example.invalid` } });
      const owner = await mkUser();
      const viewer = await mkUser();
      const buyer = await mkUser();
      const foreign = await mkUser();
      userIds.push(owner.id, viewer.id, buyer.id, foreign.id);

      const org1 = await prisma.organization.create({
        data: {
          name: "Guard fixture A",
          slug: `guardfix-a-${suffix}`,
          members: {
            create: [
              { userId: owner.id, role: "OWNER" },
              { userId: viewer.id, role: "VIEWER" },
              { userId: buyer.id, role: "MEDIA_BUYER" },
            ],
          },
          workspaces: { create: { name: "Ws", slug: "ws-a" } },
        },
        include: { workspaces: true },
      });
      const org2 = await prisma.organization.create({
        data: {
          name: "Guard fixture B",
          slug: `guardfix-b-${suffix}`,
          members: { create: { userId: foreign.id, role: "OWNER" } },
          workspaces: { create: { name: "Ws", slug: "ws-b" } },
        },
        include: { workspaces: true },
      });
      orgIds.push(org1.id, org2.id);
      const ws1 = org1.workspaces[0].id;
      const ws2 = org2.workspaces[0].id;
      workspaceIds.push(ws1, ws2);

      await prisma.adAccount.create({
        data: { orgId: org1.id, workspaceId: ws1, name: "Guard ad account", status: "ACTIVE" },
      });

      const session = async (u: string, ws: string) => {
        const t = randomBytes(32).toString("hex");
        await prisma.webSession.create({
          data: { tokenHash: tokenHash(t), userId: u, workspaceId: ws, expiresAt: new Date(Date.now() + 60_000) },
        });
        return t;
      };
      tokenOwner = await session(owner.id, ws1);
      tokenViewer = await session(viewer.id, ws1);
      tokenBuyer = await session(buyer.id, ws1);
      tokenForeign = await session(foreign.id, ws2);
    });

    afterAll(async () => {
      cookieJar.clear();
      await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
      await prisma.consentRecord.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.subscription.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.adAccount.deleteMany({ where: { orgId: { in: orgIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      vi.unstubAllEnvs();
      await prisma.$disconnect();
    });

    it("rejects VIEWER on every write endpoint", async () => {
      cookieJar.set(SESSION_COOKIE, tokenViewer);
      expect((await clinicsPost(req("/api/clinics", "POST", { name: "V", slug: "v" }))).status).toBe(403);
      expect((await campaignsPost(req("/api/campaigns", "POST", { name: "V" }))).status).toBe(403);
      expect((await creativePost(req("/api/creative", "POST", { name: "V" }))).status).toBe(403);
      expect((await leadsPost(req("/api/leads", "POST", { firstName: "V", lastName: "V", phone: "+90111222" }))).status).toBe(403);
      expect((await platformsConnect(req("/api/platforms/connect", "POST", { platform: "META", accessToken: "tok" }))).status).toBe(403);
      expect((await billingCheckout(req("/api/billing/stripe/checkout", "POST", { plan: "FREE" }))).status).toBe(403);
      expect((await metaOauth(withOrigin(req("/api/meta/oauth", "GET")))).status).toBe(403);
    });

    it("allows MEDIA_BUYER for content writes, denies owner-only endpoints, and audits creates", async () => {
      cookieJar.set(SESSION_COOKIE, tokenBuyer);
      const clinic = await clinicsPost(req("/api/clinics", "POST", { name: "Aesthetic", slug: `aes-${suffix}` }));
      expect(clinic.status).toBe(200);
      const campaign = await campaignsPost(req("/api/campaigns", "POST", { name: "Summer" }));
      expect(campaign.status).toBe(200);
      const creative = await creativePost(req("/api/creative", "POST", { name: "Hero" }));
      expect(creative.status).toBe(200);
      const lead = await leadsPost(req("/api/leads", "POST", { firstName: "Lale", lastName: "Demir", phone: "+4902312345678" }));
      expect(lead.status).toBe(200);
      expect(lead.status && (await lead.json())).toBeTruthy();

      const audit = await prisma.auditLog.groupBy({
        by: ["action"],
        _count: { _all: true },
        where: { orgId: orgIds[0] },
      });
      const actions = Object.fromEntries(audit.map((r) => [r.action, r._count._all]));
      expect(actions.CLINIC_CREATED).toBeGreaterThanOrEqual(1);
      expect(actions.CAMPAIGN_CREATED).toBeGreaterThanOrEqual(1);
      expect(actions.CREATIVE_CREATED).toBeGreaterThanOrEqual(1);
      expect(actions.LEAD_CREATED).toBeGreaterThanOrEqual(1);

      expect((await platformsConnect(req("/api/platforms/connect", "POST", { platform: "META", accessToken: "tok" }))).status).toBe(403);
      expect((await billingCheckout(req("/api/billing/stripe/checkout", "POST", { plan: "FREE" }))).status).toBe(403);
      expect((await metaOauth(withOrigin(req("/api/meta/oauth", "GET")))).status).toBe(403);
    });

    it("lets OWNER connect platforms, change billing and reach OAuth (env gate)", async () => {
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const connected = await platformsConnect(req("/api/platforms/connect", "POST", { platform: "META", accessToken: "tok" }));
      expect(connected.status).toBe(200);

      const account = await prisma.adAccount.findFirstOrThrow({
        where: { orgId: orgIds[0], name: "META" },
      });
      expect(account.workspaceId).toBe(workspaceIds[0]);
      expect(account.connectionId).toBeTruthy();
      expect(
        await prisma.metaConnection.findUnique({
          where: { id: account.connectionId! },
          select: { status: true },
        }),
      ).toMatchObject({ status: "CONNECTED" });

      const billed = await billingCheckout(req("/api/billing/stripe/checkout", "POST", { plan: "FREE" }));
      expect(billed.status).toBe(200);
      expect((await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgIds[0] } })).status).toBe("ACTIVE");

      const oauthResponse = await metaOauth(withOrigin(req("/api/meta/oauth", "GET")));
      expect(oauthResponse.status).toBe(400);
      expect((await oauthResponse.json()).error).toContain("META_APP_ID");

      const audit = await prisma.auditLog.findMany({
        where: { orgId: orgIds[0], action: { in: ["PLATFORM_CONNECTED", "PLAN_CHANGED"] } },
      });
      expect(audit.some((a) => a.action === "PLATFORM_CONNECTED")).toBe(true);
      expect(audit.some((a) => a.action === "PLAN_CHANGED")).toBe(true);
    });

    it("isolates resources across tenants and returns 404 for foreign edits", async () => {
      cookieJar.set(SESSION_COOKIE, tokenBuyer);
      const clinicRes = await clinicsPost(req("/api/clinics", "POST", { name: "Yalova", slug: `yal-${suffix}` }));
      const clinicId = (await clinicRes.json()).clinic.id;
      const leadRes = await leadsPost(req("/api/leads", "POST", { firstName: "Halil", lastName: "Sarı", phone: "+902112223344" }));
      const leadId = (await leadRes.json()).lead.id;

      cookieJar.set(SESSION_COOKIE, tokenForeign);
      expect((await clinicGet(req(`/api/clinics/${clinicId}`, "GET"), { params: Promise.resolve({ id: clinicId }) })).status).toBe(404);
      expect((await clinicPatch(req(`/api/clinics/${clinicId}`, "PATCH", { name: "Hacked" }), { params: Promise.resolve({ id: clinicId }) })).status).toBe(404);
      expect((await leadGet(req(`/api/leads/${leadId}`, "GET"), { params: Promise.resolve({ id: leadId }) })).status).toBe(404);
      expect((await leadPatch(req(`/api/leads/${leadId}`, "PATCH", { status: "CONTACTED" }), { params: Promise.resolve({ id: leadId }) })).status).toBe(404);
      expect((await leadDelete(req(`/api/leads/${leadId}`, "DELETE"), { params: Promise.resolve({ id: leadId }) })).status).toBe(404);

      const org1HasClinic = await prisma.clinicProfile.count({ where: { id: clinicId, workspaceId: workspaceIds[0] } });
      const org1HasLead = await prisma.lead.count({ where: { id: leadId, workspaceId: workspaceIds[0] } });
      expect(org1HasClinic).toBe(1);
      expect(org1HasLead).toBe(1);
    });

    it("enforces progressive status transitions and logs before/after audit", async () => {
      cookieJar.set(SESSION_COOKIE, tokenBuyer);
      const leadRes = await leadsPost(req("/api/leads", "POST", { firstName: "Naz", lastName: "Gül", phone: "+903332221100" }));
      const leadId = (await leadRes.json()).lead.id;

      const patched = await leadPatch(req(`/api/leads/${leadId}`, "PATCH", { status: "CONTACTED" }), { params: Promise.resolve({ id: leadId }) });
      expect(patched.status).toBe(200);
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("CONTACTED");

      const rolledBack = await leadPatch(req(`/api/leads/${leadId}`, "PATCH", { status: "NEW" }), { params: Promise.resolve({ id: leadId }) });
      expect(rolledBack.status).toBe(409);

      const auditRows = await prisma.auditLog.findMany({
        where: { orgId: orgIds[0], entityType: "LEAD", entityId: leadId, action: "LEAD_UPDATED" },
        orderBy: { createdAt: "desc" },
      });
      expect(auditRows.length).toBe(1);
      const row = auditRows[0];
      expect(row.before).toMatchObject({ status: "NEW" });
      expect(row.after).toMatchObject({ status: "CONTACTED" });
      expect(row.userId).toBeTruthy();
    });
  },
);