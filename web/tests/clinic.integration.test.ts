import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { slugify } from "../app/_lib/slug";

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

import { GET as clinicsGet, POST as clinicsPost } from "../app/api/clinics/route";
import { GET as clinicGet, PATCH as clinicPatch } from "../app/api/clinics/[id]/route";
import { GET as servicesGet, POST as servicesPost } from "../app/api/services/clinics/[clinicId]/route";
import { PATCH as servicePatch, DELETE as serviceDelete } from "../app/api/services/[id]/route";
import { GET as targetsGet, POST as targetsPost } from "../app/api/clinics/[id]/targets/route";
import { PATCH as targetPatch, DELETE as targetDelete } from "../app/api/clinics/[id]/targets/[country]/route";

function req(url: string, method: string, bodyObj?: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}
const p = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

describe("slugify", () => {
  it("Türkçe karakterleri sadeleştirir ve URL dostu slug üretir", () => {
    expect(slugify("Özen Diş Kliniği")).toBe("ozen-dis-klinigi");
    expect(slugify("  İstanbul Göz & Estetik  ")).toBe("istanbul-goz-estetik");
    expect(slugify("Saç Ekimi (FUE)")).toBe("sac-ekimi-fue");
    expect(slugify("Clinique Générale")).toBe("clinique-generale");
  });
});

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("Klinik profili, hizmet kataloğu ve pazar hedefleri", () => {
  const suffix = randomBytes(8).toString("hex");
  const orgIds: string[] = [];
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  let tokenOwner = "";
  let tokenBuyer = "";
  let tokenViewer = "";
  let tokenForeign = "";
  let clinicId = "";
  let serviceId = "";

  beforeAll(async () => {
    const mkUser = async () =>
      prisma.user.create({ data: { email: `${randomBytes(4).toString("hex")}-${suffix}@example.invalid` } });
    const owner = await mkUser();
    const buyer = await mkUser();
    const viewer = await mkUser();
    const foreign = await mkUser();
    userIds.push(owner.id, buyer.id, viewer.id, foreign.id);
    const org1 = await prisma.organization.create({
      data: {
        name: "Clinic fixture A",
        slug: `clinic-a-${suffix}`,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: buyer.id, role: "MEDIA_BUYER" },
            { userId: viewer.id, role: "VIEWER" },
          ],
        },
        workspaces: { create: { name: "Ws", slug: "ws-a" } },
      },
      include: { workspaces: true },
    });
    const org2 = await prisma.organization.create({
      data: {
        name: "Clinic fixture B",
        slug: `clinic-b-${suffix}`,
        members: { create: { userId: foreign.id, role: "OWNER" } },
        workspaces: { create: { name: "Ws", slug: "ws-b" } },
      },
      include: { workspaces: true },
    });
    orgIds.push(org1.id, org2.id);
    workspaceIds.push(org1.workspaces[0]!.id, org2.workspaces[0]!.id);
    const session = async (u: string, ws: string) => {
      const t = randomBytes(32).toString("hex");
      await prisma.webSession.create({
        data: { tokenHash: tokenHash(t), userId: u, workspaceId: ws, expiresAt: new Date(Date.now() + 600_000) },
      });
      return t;
    };
    tokenOwner = await session(owner.id, workspaceIds[0]!);
    tokenBuyer = await session(buyer.id, workspaceIds[0]!);
    tokenViewer = await session(viewer.id, workspaceIds[0]!);
    tokenForeign = await session(foreign.id, workspaceIds[1]!);
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  it("klinik oluşturur (slug addan türetilir), audit'ler; aynı slug 409, VIEWER 403", async () => {
    cookieJar.set(SESSION_COOKIE, tokenViewer);
    expect((await clinicsPost(req("/api/clinics", "POST", { name: "V", category: "DENTAL" }))).status).toBe(403);

    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const res = await clinicsPost(req("/api/clinics", "POST", { name: `Özen Diş Kliniği ${suffix}`, category: "DENTAL", address: "Antalya" }));
    expect(res.status).toBe(200);
    const { clinic } = await res.json();
    clinicId = clinic.id;
    expect(clinic.slug).toBe(`ozen-dis-klinigi-${suffix}`);
    expect(clinic.category).toBe("DENTAL");
    expect(clinic.address).toBe("Antalya");
    expect(clinic.languages).toEqual(["TR"]);

    const dup = await clinicsPost(req("/api/clinics", "POST", { name: "Başka", slug: `ozen-dis-klinigi-${suffix}` }));
    expect(dup.status).toBe(409);
    expect((await clinicsPost(req("/api/clinics", "POST", { name: "X", slug: "Geçersiz Slug" }))).status).toBe(400);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { orgId: orgIds[0], action: "CLINIC_CREATED", entityId: clinicId } });
    expect(audit.after).toMatchObject({ name: `Özen Diş Kliniği ${suffix}`, slug: `ozen-dis-klinigi-${suffix}`, category: "DENTAL" });

    const list = await (await clinicsGet()).json();
    expect(list.clinics.some((c: { id: string }) => c.id === clinicId)).toBe(true);
  });

  it("PATCH yalnızca gönderilen alanları değiştirir, null ile temizler ve before/after farkını audit'ler", async () => {
    cookieJar.set(SESSION_COOKIE, tokenBuyer);
    const first = await clinicPatch(
      req(`/api/clinics/${clinicId}`, "PATCH", { phone: "+90 242 000 00 00", languages: ["TR", "DE", "RU"], brandBannedPhrases: ["garanti sonuç"] }),
      p({ id: clinicId }),
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.changed.sort()).toEqual(["brandBannedPhrases", "languages", "phone"]);
    expect(firstBody.clinic.address).toBe("Antalya");
    expect(firstBody.clinic.category).toBe("DENTAL");

    // null ile temizleme (eski `?? clinic.x` davranışında mümkün değildi).
    const cleared = await clinicPatch(req(`/api/clinics/${clinicId}`, "PATCH", { address: null, phone: null }), p({ id: clinicId }));
    expect(cleared.status).toBe(200);
    const row = await prisma.clinicProfile.findUniqueOrThrow({ where: { id: clinicId } });
    expect(row.address).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.languages).toEqual(["TR", "DE", "RU"]);
    expect(row.brandBannedPhrases).toEqual(["garanti sonuç"]);

    const audits = await prisma.auditLog.findMany({
      where: { orgId: orgIds[0], action: "CLINIC_UPDATED", entityId: clinicId },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.before).toMatchObject({ phone: null, languages: ["TR"], brandBannedPhrases: [] });
    expect(audits[0]!.after).toMatchObject({ phone: "+90 242 000 00 00", languages: ["TR", "DE", "RU"], brandBannedPhrases: ["garanti sonuç"] });
    expect(audits[0]!.after).not.toHaveProperty("address");
    expect(audits[1]!.before).toMatchObject({ address: "Antalya", phone: "+90 242 000 00 00" });
    expect(audits[1]!.after).toMatchObject({ address: null, phone: null });

    // Değişiklik yoksa audit yazılmaz.
    const noop = await clinicPatch(req(`/api/clinics/${clinicId}`, "PATCH", { languages: ["TR", "DE", "RU"] }), p({ id: clinicId }));
    expect((await noop.json()).changed).toEqual([]);
    expect(await prisma.auditLog.count({ where: { orgId: orgIds[0], action: "CLINIC_UPDATED", entityId: clinicId } })).toBe(2);

    // Doğrulama ve roller.
    expect((await clinicPatch(req(`/api/clinics/${clinicId}`, "PATCH", { email: "gecersiz" }), p({ id: clinicId }))).status).toBe(400);
    expect((await clinicPatch(req(`/api/clinics/${clinicId}`, "PATCH", { unknown: 1 }), p({ id: clinicId }))).status).toBe(400);
    cookieJar.set(SESSION_COOKIE, tokenViewer);
    expect((await clinicPatch(req(`/api/clinics/${clinicId}`, "PATCH", { name: "V" }), p({ id: clinicId }))).status).toBe(403);
    expect((await clinicGet(req(`/api/clinics/${clinicId}`, "GET"), p({ id: clinicId }))).status).toBe(200);
  });

  it("hizmet CRUD: oluşturma/güncelleme/arşivleme audit'lenir, fiyat null ile temizlenir, başlangıç fiyatı anahtarı korunur", async () => {
    cookieJar.set(SESSION_COOKIE, tokenBuyer);
    const created = await servicesPost(
      req(`/api/services/clinics/${clinicId}`, "POST", { name: "Saç Ekimi (FUE)", category: "SURGICAL", priceCents: 250_000, currency: "eur", packageIncludes: ["otel", "transfer"] }),
      p({ clinicId }),
    );
    expect(created.status).toBe(200);
    const { service } = await created.json();
    serviceId = service.id;
    expect(service.slug).toBe("sac-ekimi-fue");
    expect(service.currency).toBe("EUR");
    expect(service.showStartingPrice).toBe(true);
    const createAudit = await prisma.auditLog.findFirstOrThrow({ where: { orgId: orgIds[0], action: "SERVICE_CREATED", entityId: serviceId } });
    expect(createAudit.after).toMatchObject({ clinicId, name: "Saç Ekimi (FUE)", priceCents: 250_000, currency: "EUR" });
    expect((await servicesPost(req(`/api/services/clinics/${clinicId}`, "POST", { name: "Yine", slug: "sac-ekimi-fue", category: "SURGICAL" }), p({ clinicId }))).status).toBe(409);

    const patched = await servicePatch(
      req(`/api/services/${serviceId}`, "PATCH", { priceCents: 300_000, showStartingPrice: false, durationDays: 3 }),
      p({ id: serviceId }),
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).changed.sort()).toEqual(["durationDays", "priceCents", "showStartingPrice"]);
    const patchAudit = await prisma.auditLog.findFirstOrThrow({ where: { orgId: orgIds[0], action: "SERVICE_UPDATED", entityId: serviceId } });
    expect(patchAudit.before).toMatchObject({ priceCents: 250_000, showStartingPrice: true, durationDays: null });
    expect(patchAudit.after).toMatchObject({ priceCents: 300_000, showStartingPrice: false, durationDays: 3 });

    const clearedPrice = await servicePatch(req(`/api/services/${serviceId}`, "PATCH", { priceCents: null }), p({ id: serviceId }));
    expect(clearedPrice.status).toBe(200);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).priceCents).toBeNull();
    expect((await servicePatch(req(`/api/services/${serviceId}`, "PATCH", { priceCents: -5 }), p({ id: serviceId }))).status).toBe(400);

    const archived = await serviceDelete(req(`/api/services/${serviceId}`, "DELETE"), p({ id: serviceId }));
    expect(archived.status).toBe(200);
    expect((await archived.json()).service.status).toBe("ARCHIVED");
    expect(await prisma.auditLog.count({ where: { orgId: orgIds[0], action: "SERVICE_ARCHIVED", entityId: serviceId } })).toBe(1);
    // İkinci arşivleme idempotent (yeni audit yok).
    expect((await serviceDelete(req(`/api/services/${serviceId}`, "DELETE"), p({ id: serviceId }))).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { orgId: orgIds[0], action: "SERVICE_ARCHIVED", entityId: serviceId } })).toBe(1);

    const restored = await servicePatch(req(`/api/services/${serviceId}`, "PATCH", { status: "ACTIVE" }), p({ id: serviceId }));
    expect((await restored.json()).service.status).toBe("ACTIVE");

    const list = await (await servicesGet(req(`/api/services/clinics/${clinicId}`, "GET"), p({ clinicId }))).json();
    expect(list.services).toHaveLength(1);
    expect(list.services[0]).toMatchObject({ id: serviceId, showStartingPrice: false, durationDays: 3, currency: "EUR" });

    // Roller ve tenant izolasyonu.
    cookieJar.set(SESSION_COOKIE, tokenViewer);
    expect((await servicesPost(req(`/api/services/clinics/${clinicId}`, "POST", { name: "V", category: "MEDICAL" }), p({ clinicId }))).status).toBe(403);
    expect((await servicePatch(req(`/api/services/${serviceId}`, "PATCH", { name: "V" }), p({ id: serviceId }))).status).toBe(403);
    expect((await serviceDelete(req(`/api/services/${serviceId}`, "DELETE"), p({ id: serviceId }))).status).toBe(403);
    cookieJar.set(SESSION_COOKIE, tokenForeign);
    expect((await servicesGet(req(`/api/services/clinics/${clinicId}`, "GET"), p({ clinicId }))).status).toBe(404);
    expect((await servicesPost(req(`/api/services/clinics/${clinicId}`, "POST", { name: "F", category: "MEDICAL" }), p({ clinicId }))).status).toBe(404);
    expect((await servicePatch(req(`/api/services/${serviceId}`, "PATCH", { name: "Hacked" }), p({ id: serviceId }))).status).toBe(404);
    expect((await serviceDelete(req(`/api/services/${serviceId}`, "DELETE"), p({ id: serviceId }))).status).toBe(404);
    expect((await clinicGet(req(`/api/clinics/${clinicId}`, "GET"), p({ id: clinicId }))).status).toBe(404);
    expect((await clinicPatch(req(`/api/clinics/${clinicId}`, "PATCH", { name: "Hacked" }), p({ id: clinicId }))).status).toBe(404);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).name).toBe("Saç Ekimi (FUE)");
  });

  it("pazar hedefleri: ekleme, güncelleme, silme ve tenant izolasyonu", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const created = await targetsPost(req(`/api/clinics/${clinicId}/targets`, "POST", { country: "DE", language: "DE", currency: "EUR", demand: 3 }), p({ id: clinicId }));
    expect(created.status).toBe(200);
    expect((await created.json()).created).toBe(true);
    const updated = await targetPatch(req(`/api/clinics/${clinicId}/targets/DE`, "PATCH", { language: "TR", demand: 5 }), p({ id: clinicId, country: "DE" }));
    expect(updated.status).toBe(200);
    const list = await (await targetsGet(req(`/api/clinics/${clinicId}/targets`, "GET"), p({ id: clinicId }))).json();
    expect(list.targets).toHaveLength(1);
    expect(list.targets[0]).toMatchObject({ country: "DE", language: "TR", currency: "EUR", demand: 5 });

    cookieJar.set(SESSION_COOKIE, tokenForeign);
    expect((await targetsGet(req(`/api/clinics/${clinicId}/targets`, "GET"), p({ id: clinicId }))).status).toBe(404);
    const foreignDelete = await targetDelete(req(`/api/clinics/${clinicId}/targets/DE`, "DELETE"), p({ id: clinicId, country: "DE" }));
    expect([403, 404]).toContain(foreignDelete.status);

    cookieJar.set(SESSION_COOKIE, tokenOwner);
    expect((await targetDelete(req(`/api/clinics/${clinicId}/targets/DE`, "DELETE"), p({ id: clinicId, country: "DE" }))).status).toBe(200);
    expect(await prisma.marketTarget.count({ where: { clinicId } })).toBe(0);
    const actions = await prisma.auditLog.findMany({ where: { orgId: orgIds[0], entityType: "MARKET_TARGET" }, select: { action: true } });
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["MARKET_TARGET_CREATED", "MARKET_TARGET_UPDATED", "MARKET_TARGET_DELETED"]));
  });
});
