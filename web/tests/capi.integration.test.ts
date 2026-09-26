import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { encrypt } from "../app/_lib/encrypt";

const { cookieJar, postSpy } = vi.hoisted(() => ({ cookieJar: new Map<string, string>(), postSpy: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
}) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
// Gerçek modül (mock modda ağ isteği yapmaz) + çağrı gözlemi.
vi.mock("@admedic/meta-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@admedic/meta-api")>();
  return {
    ...actual,
    postConversionEvents: (...args: Parameters<typeof actual.postConversionEvents>) => {
      postSpy(...args);
      return actual.postConversionEvents(...args);
    },
  };
});

import { sha256 } from "@admedic/meta-api";
import { POST as capiPost } from "../app/api/capi/route";
import { POST as leadCapiPost } from "../app/api/capi/lead/route";
import { sendLeadStatusConversion } from "../app/_lib/capi-sync";

const ORIGIN = "http://localhost:3000";
function req(url: string, bodyObj: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("Conversions API routes and CRM bridge", () => {
  const suffix = randomBytes(8).toString("hex");
  const users: string[] = [];
  const orgs: string[] = [];
  const tokens: Record<string, string> = {};
  let orgId = "";
  let workspaceId = "";
  let consentedLeadId = "";
  let noConsentLeadId = "";
  let lostLeadId = "";
  let foreignLeadId = "";
  const PIXEL = `1234567890${suffix.slice(0, 4).replace(/\D/g, "1")}`;

  beforeAll(async () => {
    vi.stubEnv("META_MOCK_MODE", "true");
    for (const variant of ["main", "nopixel", "foreign"] as const) {
      const org = await prisma.organization.create({ data: {
        name: "CAPI fixture", slug: `capi-${suffix}-${variant}`,
        workspaces: { create: { name: "Capi", slug: "capi" } },
      }, include: { workspaces: true } });
      orgs.push(org.id);
      const wsId = org.workspaces[0].id;
      const roles: Role[] = variant === "main" ? ["OWNER", "MEDIA_BUYER", "VIEWER"] : ["OWNER"];
      for (const role of roles) {
        const user = await prisma.user.create({ data: { email: `${suffix}-${variant}-${role}@example.invalid` } });
        users.push(user.id);
        await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role } });
        const token = randomBytes(32).toString("hex");
        await prisma.webSession.create({ data: { tokenHash: tokenHash(token), userId: user.id, workspaceId: wsId, expiresAt: new Date(Date.now() + 600_000) } });
        tokens[variant === "main" ? role : variant.toUpperCase()] = token;
      }
      if (variant !== "nopixel") {
        await prisma.metaConnection.create({ data: { orgId: org.id, type: "PIXEL", status: "CONNECTED", pixelId: variant === "main" ? PIXEL : "999" } });
      }
      // Pixel'siz bağlantı (ad account) her org'da var; hedef seçimi pixelId'li bağlantıyı bulmalı.
      await prisma.metaConnection.create({ data: { orgId: org.id, type: "AD_ACCOUNT", status: "CONNECTED" } });
      const mkLead = (data: Record<string, unknown>) => prisma.lead.create({ data: {
        workspaceId: wsId, organizationId: org.id, firstName: "Ada", lastName: "Yılmaz", country: "DE", language: "de",
        email: encrypt("Ada@Example.com"), phone: encrypt("+49 123 456789"), lookupHash: `lh-${randomBytes(6).toString("hex")}`,
        ...data,
      } });
      if (variant === "main") {
        orgId = org.id;
        workspaceId = wsId;
        consentedLeadId = (await mkLead({ status: "QUALIFIED", consentGiven: true })).id;
        noConsentLeadId = (await mkLead({ status: "QUALIFIED", consentGiven: false })).id;
        lostLeadId = (await mkLead({ status: "LOST", consentGiven: true, lostReason: "x" })).id;
      } else if (variant === "nopixel") {
        // nopixel org'un lead'i: pixel yok → 400
        const lead = await mkLead({ status: "QUALIFIED", consentGiven: true });
        tokens.NOPIXEL_LEAD = lead.id;
      } else {
        foreignLeadId = (await mkLead({ status: "QUALIFIED", consentGiven: true })).id;
      }
    }
  });
  beforeEach(() => { postSpy.mockClear(); });
  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });
  const as = (role: string) => cookieJar.set(SESSION_COOKIE, tokens[role]);

  it("lead dönüşümü: rıza/LOST/tenant/rol kapıları; pixel hedefi; hash'li user_data; idempotency", async () => {
    as("VIEWER");
    expect((await leadCapiPost(req("/api/capi/lead", { leadId: consentedLeadId }))).status).toBe(403);
    as("MEDIA_BUYER");
    expect((await leadCapiPost(req("/api/capi/lead", { leadId: noConsentLeadId }))).status).toBe(409);
    expect((await leadCapiPost(req("/api/capi/lead", { leadId: lostLeadId }))).status).toBe(409);
    expect((await leadCapiPost(req("/api/capi/lead", { leadId: foreignLeadId }))).status).toBe(404);
    expect((await leadCapiPost(req("/api/capi/lead", { leadId: consentedLeadId, eventName: "CUSTOMIZE" }))).status).toBe(400);
    expect((await leadCapiPost(req("/api/capi/lead", { leadId: consentedLeadId }, "https://other.invalid"))).status).toBe(403);
    expect(postSpy).not.toHaveBeenCalled();
    expect(await prisma.conversionEvent.count({ where: { workspaceId } })).toBe(0);

    // QUALIFIED → Lead olayı, pixel hedefi, hash'li user_data, custom_data yok.
    const ok = await leadCapiPost(req("/api/capi/lead", { leadId: consentedLeadId }));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { status: string; eventId: string; duplicate: boolean; conversionEventId: string; mock: boolean };
    expect(body.status).toBe("ACCEPTED");
    expect(body.duplicate).toBe(false);
    expect(body.mock).toBe(true);
    expect(body.eventId).toMatch(new RegExp(`^crm_${consentedLeadId}_LEAD_\\d{8}$`));
    expect(postSpy).toHaveBeenCalledTimes(1);
    const [pixelId, events, token] = postSpy.mock.calls[0]!;
    expect(pixelId).toBe(PIXEL);
    expect(token).toBe("mock-token");
    expect(events[0]).toMatchObject({ eventName: "LEAD", actionSource: "system_generated", eventId: body.eventId });
    expect(events[0].customData).toBeUndefined();
    expect(events[0].userData).toEqual({
      em: sha256("ada@example.com"),
      ph: sha256("49123456789"),
      fn: sha256("ada"),
      ln: sha256("yılmaz"),
      country: sha256("de"),
      external_id: expect.stringMatching(/^lh-/),
    });
    expect(events[0].userData).not.toHaveProperty("ct");
    const saved = await prisma.conversionEvent.findUniqueOrThrow({ where: { externalId: body.eventId } });
    expect(saved).toMatchObject({ workspaceId, type: "LEAD", source: "CRM", value: null });
    expect(await prisma.auditLog.count({ where: { orgId, action: "CRM_CONVERSION", entityId: saved.id } })).toBe(1);

    // Aynı gün tekrar → DUPLICATE, Meta'ya gönderilmez.
    postSpy.mockClear();
    const dup = await leadCapiPost(req("/api/capi/lead", { leadId: consentedLeadId }));
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ status: "DUPLICATE", duplicate: true, eventId: body.eventId });
    expect(postSpy).not.toHaveBeenCalled();
    expect(await prisma.conversionEvent.count({ where: { workspaceId } })).toBe(1);

    // Değerli PURCHASE: custom_data yalnızca value/currency; ConversionEvent.value cent.
    const purchase = await leadCapiPost(req("/api/capi/lead", { leadId: consentedLeadId, eventName: "PURCHASE", value: 1250.5, currency: "eur" }));
    expect(purchase.status).toBe(200);
    const [, purchaseEvents] = postSpy.mock.calls[0]!;
    expect(purchaseEvents[0].customData).toEqual({ value: 1250.5, currency: "EUR" });
    expect(Object.keys(purchaseEvents[0].customData)).toEqual(["value", "currency"]);
    const purchaseRow = await prisma.conversionEvent.findFirstOrThrow({ where: { workspaceId, type: "PURCHASE" } });
    expect(purchaseRow.value).toBe(125_050);
    expect(purchaseRow.currency).toBe("EUR");
  });

  it("pixel/dataset ayarlanmamış org → 400; mock hesap kimliğine düşülmez", async () => {
    as("NOPIXEL");
    const res = await leadCapiPost(req("/api/capi/lead", { leadId: tokens.NOPIXEL_LEAD }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("Pixel/Dataset ID");
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("genel CAPI ucu: rıza, action_source, izinli olay, idempotency ve veri minimizasyonu", async () => {
    as("OWNER");
    const base = { eventName: "SCHEDULE", eventTime: new Date().toISOString(), actionSource: "chat", consentGiven: true, eventId: `evt-${suffix}` };
    expect((await capiPost(req("/api/capi", { ...base, consentGiven: false }))).status).toBe(409);
    expect((await capiPost(req("/api/capi", { ...base, actionSource: "offline_conversion" }))).status).toBe(400);
    expect((await capiPost(req("/api/capi", { ...base, eventName: "VIEW_CONTENT" }))).status).toBe(422);
    expect((await capiPost(req("/api/capi", { ...base, customData: { service: "saç ekimi" } }))).status).toBe(400);
    expect(postSpy).not.toHaveBeenCalled();

    const ok = await capiPost(req("/api/capi", {
      ...base,
      userData: { em: "Guest@Example.com", ph: "+90 532 111 22 33", country: "TR", clientUserAgent: "UA/1" },
      customData: { value: 10, currency: "try" },
    }));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { status: string; eventId: string; duplicate: boolean };
    // İdempotency anahtarı tenant'a özeldir (orgId ile karma): istemci eventId'si düz olarak dönmez.
    expect(body).toMatchObject({ status: "ACCEPTED", duplicate: false });
    expect(body.eventId).toMatch(/^ce_[0-9a-f]{40}$/);
    const [pixelId, events] = postSpy.mock.calls[0]!;
    expect(pixelId).toBe(PIXEL);
    expect(events[0]).toMatchObject({ eventName: "SCHEDULE", actionSource: "chat", customData: { value: 10, currency: "TRY" } });
    expect(events[0].userData).toEqual({
      em: sha256("guest@example.com"),
      ph: sha256("905321112233"),
      country: sha256("tr"),
      client_user_agent: "UA/1",
    });
    const saved = await prisma.conversionEvent.findUniqueOrThrow({ where: { externalId: body.eventId } });
    expect(saved).toMatchObject({ workspaceId, type: "SCHEDULE", source: "META", value: 1_000, currency: "TRY" });

    postSpy.mockClear();
    const dup = await capiPost(req("/api/capi", base));
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ status: "DUPLICATE", duplicate: true });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("sendLeadStatusConversion: durum → olay eşlemesi, olaysız durumlar atlanır, fırlatmaz", async () => {
    expect(await sendLeadStatusConversion(consentedLeadId, "LOST")).toEqual({ status: "SKIPPED", reason: "NO_EVENT_FOR_STATUS" });
    expect(await sendLeadStatusConversion(consentedLeadId, "NEW")).toEqual({ status: "SKIPPED", reason: "NO_EVENT_FOR_STATUS" });
    expect((await sendLeadStatusConversion("missing-lead", "TREATED")).reason).toBe("LEAD_NOT_FOUND");
    expect((await sendLeadStatusConversion(noConsentLeadId, "CONSULTATION_BOOKED")).reason).toBe("NO_CONSENT");
    expect(postSpy).not.toHaveBeenCalled();

    const sent = await sendLeadStatusConversion(consentedLeadId, "CONSULTATION_BOOKED");
    expect(sent.status).toBe("SENT");
    expect(sent.eventName).toBe("SCHEDULE");
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]![1][0]).toMatchObject({ eventName: "SCHEDULE", actionSource: "system_generated" });
    const again = await sendLeadStatusConversion(consentedLeadId, "CONSULTATION_BOOKED");
    expect(again.status).toBe("DUPLICATE");
    expect(postSpy).toHaveBeenCalledTimes(1);
  });
});
