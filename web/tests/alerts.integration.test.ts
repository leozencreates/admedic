import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
}) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { GET as listAlerts } from "../app/api/alerts/route";
import { GET as getAlert, PATCH as patchAlert } from "../app/api/alerts/[id]/route";

const ORIGIN = "http://localhost:3000";
function req(url: string, method: string, bodyObj?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { origin, ...(bodyObj === undefined ? {} : { "content-type": "application/json" }) },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("alert management: list, ack, resolve", () => {
  const suffix = randomBytes(8).toString("hex");
  const users: string[] = [];
  const orgs: string[] = [];
  const tokens: Record<string, string> = {};
  let orgId = "";
  let workspaceId = "";
  let foreignWorkspaceId = "";

  beforeAll(async () => {
    for (const foreign of [false, true]) {
      const org = await prisma.organization.create({ data: {
        name: "Alert fixture", slug: `alert-${suffix}-${foreign}`,
        workspaces: { create: { name: "Alerts", slug: "alerts" } },
      }, include: { workspaces: true } });
      orgs.push(org.id);
      const wsId = org.workspaces[0].id;
      for (const role of (foreign ? ["OWNER"] : ["OWNER", "PATIENT_COORDINATOR", "VIEWER", "ANALYST"]) as Role[]) {
        const user = await prisma.user.create({ data: { email: `${suffix}-${foreign}-${role}@example.invalid` } });
        users.push(user.id);
        await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role } });
        const token = randomBytes(32).toString("hex");
        await prisma.webSession.create({ data: { tokenHash: tokenHash(token), userId: user.id, workspaceId: wsId, expiresAt: new Date(Date.now() + 600_000) } });
        tokens[foreign ? "FOREIGN" : role] = token;
      }
      if (foreign) foreignWorkspaceId = wsId;
      else { orgId = org.id; workspaceId = wsId; }
    }
    await prisma.alert.createMany({ data: [
      { workspaceId, type: "ROAS_DROP", severity: "WARNING", title: "ROAS düşüşü", message: "m", entityType: "CAMPAIGN", entityId: "c1" },
      { workspaceId, type: "HIGH_CPA", severity: "CRITICAL", title: "Yüksek CPL", message: "m", entityType: "CAMPAIGN", entityId: "c2" },
      { workspaceId, type: "CREATIVE_FATIGUE", severity: "INFO", title: "Kreatif", message: "m", status: "RESOLVED", read: true, resolvedAt: new Date() },
      { workspaceId: foreignWorkspaceId, type: "SPEND_SPIKE", severity: "WARNING", title: "Yabancı", message: "m" },
    ] });
  });
  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });
  const as = (role: string) => cookieJar.set(SESSION_COOKIE, tokens[role]);
  const own = () => prisma.alert.findFirstOrThrow({ where: { workspaceId, type: "ROAS_DROP" } });

  it("GET /api/alerts yalnızca kendi workspace'ini listeler ve durum filtresi uygular", async () => {
    as("VIEWER");
    const all = await (await listAlerts(req("/api/alerts", "GET"))).json() as { alerts: Array<{ workspaceId: string; status: string }> };
    expect(all.alerts).toHaveLength(3);
    expect(all.alerts.every((a) => a.workspaceId === workspaceId)).toBe(true);
    const open = await (await listAlerts(req("/api/alerts?status=OPEN", "GET"))).json() as { alerts: Array<{ status: string }> };
    expect(open.alerts).toHaveLength(2);
    expect(open.alerts.every((a) => a.status === "OPEN")).toBe(true);
    expect((await listAlerts(req("/api/alerts?status=BOGUS", "GET"))).status).toBe(400);
    as("FOREIGN");
    const foreign = await (await listAlerts(req("/api/alerts", "GET"))).json() as { alerts: Array<{ title: string }> };
    expect(foreign.alerts.map((a) => a.title)).toEqual(["Yabancı"]);
    expect((await getAlert(req(`/api/alerts/${(await own()).id}`, "GET"), ctx((await own()).id))).status).toBe(404);
  });

  it("PATCH: CARE_ROLES yetkisi, tenant izolasyonu, Görüldü → Çözüldü geçişleri, read/resolvedAt ve audit", async () => {
    const alert = await own();
    as("VIEWER");
    expect((await patchAlert(req(`/api/alerts/${alert.id}`, "PATCH", { status: "ACKED" }), ctx(alert.id))).status).toBe(403);
    as("ANALYST");
    expect((await patchAlert(req(`/api/alerts/${alert.id}`, "PATCH", { status: "ACKED" }), ctx(alert.id))).status).toBe(403);
    as("FOREIGN");
    expect((await patchAlert(req(`/api/alerts/${alert.id}`, "PATCH", { status: "ACKED" }), ctx(alert.id))).status).toBe(404);
    as("PATIENT_COORDINATOR");
    expect((await patchAlert(req(`/api/alerts/${alert.id}`, "PATCH", { status: "ACKED" }, "https://other.invalid"), ctx(alert.id))).status).toBe(403);
    expect((await patchAlert(req(`/api/alerts/${alert.id}`, "PATCH", { status: "OPEN" }), ctx(alert.id))).status).toBe(400);

    const acked = await patchAlert(req(`/api/alerts/${alert.id}`, "PATCH", { status: "ACKED" }), ctx(alert.id));
    expect(acked.status).toBe(200);
    const afterAck = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(afterAck.status).toBe("ACKED");
    expect(afterAck.read).toBe(true);
    expect(afterAck.resolvedAt).toBeNull();
    // Aynı durum tekrar → idempotent 200, yeni audit yok.
    expect((await patchAlert(req(`/api/alerts/${alert.id}`, "PATCH", { status: "ACKED" }), ctx(alert.id))).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { orgId, entityType: "ALERT", entityId: alert.id } })).toBe(1);

    as("OWNER");
    const resolved = await patchAlert(req(`/api/alerts/${alert.id}`, "PATCH", { status: "RESOLVED" }), ctx(alert.id));
    expect(resolved.status).toBe(200);
    const afterResolve = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(afterResolve.status).toBe("RESOLVED");
    expect(afterResolve.resolvedAt).not.toBeNull();
    // Çözülen uyarı yeniden açılamaz/görüldü yapılamaz.
    expect((await patchAlert(req(`/api/alerts/${alert.id}`, "PATCH", { status: "ACKED" }), ctx(alert.id))).status).toBe(409);
    const logs = await prisma.auditLog.findMany({ where: { orgId, entityType: "ALERT", entityId: alert.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["ALERT_ACKED", "ALERT_RESOLVED"]);
    expect(logs[1].before).toMatchObject({ status: "ACKED" });
    expect(logs[1].after).toMatchObject({ status: "RESOLVED" });

    // OPEN → RESOLVED doğrudan da mümkündür.
    const critical = await prisma.alert.findFirstOrThrow({ where: { workspaceId, type: "HIGH_CPA" } });
    expect((await patchAlert(req(`/api/alerts/${critical.id}`, "PATCH", { status: "RESOLVED" }), ctx(critical.id))).status).toBe(200);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: critical.id } })).read).toBe(true);
  });
});
