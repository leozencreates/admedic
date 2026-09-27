import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { createOAuthState } from "../app/_lib/oauth-state";
import { decrypt, encrypt } from "../app/_lib/encrypt";
import { META_OAUTH_SCOPES, META_REQUIRED_SCOPES, optionalScopesMissing, requiredScopesMissing } from "../app/_lib/meta-scopes";

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

import { GET as oauthStart } from "../app/api/meta/oauth/route";
import { GET as oauthCallback } from "../app/api/meta/oauth/callback/route";
import { GET as connectionsGet } from "../app/api/meta/connections/route";
import { PATCH as connectionPatch, DELETE as connectionDelete } from "../app/api/meta/connections/[id]/route";
import { POST as connectionRefresh } from "../app/api/meta/connections/[id]/refresh/route";
import { refreshMetaConnection, requireLiveMetaConnection } from "../app/_lib/meta-connection";

const ENV_BASE = {
  META_APP_ID: "app_test_123",
  META_APP_SECRET: "secret_test_abc",
  META_API_VERSION: "v26.0",
  AUTH_URL: "http://localhost:3000",
  META_DISCONNECTED_WEBHOOK_URL: "",
};

function req(url: string, method: string, bodyObj?: unknown, origin = true) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(origin ? { origin: "http://localhost:3000" } : {}),
      "content-type": "application/json",
    },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? record[key]! : null;
}
function locationParams(res: Response) {
  const location = res.headers.get("location");
  expect(location, "303 Location bekleniyor").toBeTruthy();
  const url = new URL(location!);
  expect(url.pathname).toBe("/meta-connections");
  return url.searchParams;
}

interface GraphCall { url: string; init?: RequestInit }

/** Meta Graph'ı taklit eden fetch: URL yoluna göre deterministik yanıt. */
function graphStub(calls: GraphCall[], opts: { permissions?: unknown; accounts?: unknown; adaccounts?: unknown } = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const search = new URL(url).searchParams;
    if (path.endsWith("/oauth/access_token")) {
      if (search.get("grant_type") === "fb_exchange_token")
        return jsonResponse({ access_token: `long_${search.get("fb_exchange_token")}`, token_type: "bearer", expires_in: 5_184_000 });
      if (search.get("code") === "bad_code")
        return jsonResponse({ error: { code: 100, message: "Invalid verification code format." } }, 400);
      return jsonResponse({ access_token: `short_${search.get("code")}`, token_type: "bearer", expires_in: 5_000 });
    }
    if (path.endsWith("/me")) return jsonResponse({ id: "meta_user_1", name: "Test Kullanıcı" });
    if (path.endsWith("/me/businesses")) return jsonResponse({ data: [{ id: "bm_1", name: "Klinik BM" }] });
    if (path.endsWith("/me/permissions")) return jsonResponse(opts.permissions ?? { data: [] });
    if (path.endsWith("/me/accounts")) return jsonResponse(opts.accounts ?? { data: [] });
    if (path.endsWith("/me/adaccounts")) return jsonResponse(opts.adaccounts ?? { data: [] });
    if (path.endsWith("/debug_token")) return jsonResponse({ data: { is_valid: false, error: { code: 190, message: "Error validating access token: The session is invalid" } } });
    return jsonResponse({ error: { code: 1, message: `beklenmeyen çağrı: ${path}` } }, 400);
  };
}

describe("meta-scopes yardımcıları", () => {
  it("zorunlu/opsiyonel ayrımı yapar", () => {
    expect(requiredScopesMissing([...META_OAUTH_SCOPES])).toEqual([]);
    expect(optionalScopesMissing([...META_OAUTH_SCOPES])).toEqual([]);
    expect(requiredScopesMissing(["ads_read"])).toEqual(META_REQUIRED_SCOPES.filter((s) => s !== "ads_read"));
    expect(optionalScopesMissing([...META_REQUIRED_SCOPES])).toContain("pages_messaging");
    expect(optionalScopesMissing([...META_REQUIRED_SCOPES])).not.toContain("ads_management");
  });
});

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("Meta OAuth ve bağlantı yönetimi", () => {
  const suffix = randomBytes(8).toString("hex");
  const orgIds: string[] = [];
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  let ownerId = "";
  let tokenOwner = "";
  let tokenBuyer = "";
  let tokenForeign = "";

  beforeAll(async () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex")); // test başına rastgele anahtar (gerçek anahtar repoya girmez)
    loadEnv({ fresh: true, overrides: { ...ENV_BASE, META_MOCK_MODE: "true" } });
    const mkUser = async () =>
      prisma.user.create({ data: { email: `${randomBytes(4).toString("hex")}-${suffix}@example.invalid` } });
    const owner = await mkUser();
    const buyer = await mkUser();
    const foreign = await mkUser();
    ownerId = owner.id;
    userIds.push(owner.id, buyer.id, foreign.id);
    const org1 = await prisma.organization.create({
      data: {
        name: "OAuth fixture A",
        slug: `oauth-a-${suffix}`,
        members: { create: [{ userId: owner.id, role: "OWNER" }, { userId: buyer.id, role: "MEDIA_BUYER" }] },
        workspaces: { create: { name: "Ws", slug: "ws-a" } },
      },
      include: { workspaces: true },
    });
    const org2 = await prisma.organization.create({
      data: {
        name: "OAuth fixture B",
        slug: `oauth-b-${suffix}`,
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
    tokenForeign = await session(foreign.id, workspaceIds[1]!);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    loadEnv({ fresh: true, overrides: { ...ENV_BASE, META_MOCK_MODE: "true" } });
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.alert.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.adAccount.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.metaConnection.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.requestQuota.deleteMany({ where: { key: { startsWith: `oauth:${orgIds[0]}` } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    vi.unstubAllEnvs();
    loadEnv({ fresh: true });
    await prisma.$disconnect();
  });

  function stateFor(userId = ownerId, orgId = orgIds[0]!) {
    return createOAuthState(loadEnv().AUTH_SECRET, userId, orgId).state;
  }

  it("GET /api/meta/oauth Origin başlığı olmadan çalışır ve tam izin setini ister", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const res = await oauthStart(req("/api/meta/oauth", "GET", undefined, false));
    expect(res.status).toBe(200);
    const data = await res.json();
    const url = new URL(data.authUrl);
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.pathname).toBe("/v26.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("app_test_123");
    const scopes = (url.searchParams.get("scope") ?? "").split(",");
    for (const s of META_OAUTH_SCOPES) expect(scopes).toContain(s);
    expect(url.searchParams.get("state")).toBeTruthy();
    // MEDIA_BUYER OAuth başlatamaz.
    cookieJar.set(SESSION_COOKIE, tokenBuyer);
    expect((await oauthStart(req("/api/meta/oauth", "GET", undefined, false))).status).toBe(403);
  });

  it("callback (mock mod): token değişimi, izinler, BM + PAGE bağlantıları ve 303 yönlendirme", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const calls: GraphCall[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(graphStub(calls));
    const state = stateFor();
    const res = await oauthCallback(req(`/api/meta/oauth/callback?code=code_ok&state=${encodeURIComponent(state)}`, "GET"));
    expect(res.status).toBe(303);
    const params = locationParams(res);
    expect(params.get("status")).toBe("connected");
    expect(params.get("missing")).toBeNull();
    expect(params.get("optional")).toBeNull();
    expect(params.get("pages")).toBe("1");

    // Mock modda /me/permissions ve /me/accounts çağrılmaz; /me ve /me/businesses Bearer + appsecret_proof ile gider.
    expect(calls.some((c) => c.url.includes("/me/permissions"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/me/accounts"))).toBe(false);
    const me = calls.find((c) => new URL(c.url).pathname.endsWith("/me"));
    expect(me).toBeTruthy();
    expect(headerOf(me!.init, "authorization")).toBe("Bearer long_short_code_ok");
    expect(new URL(me!.url).searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    expect(new URL(me!.url).searchParams.get("access_token")).toBeNull();

    const bm = await prisma.metaConnection.findFirstOrThrow({ where: { orgId: orgIds[0], type: "BUSINESS_MANAGER" } });
    expect(bm.status).toBe("CONNECTED");
    expect(bm.metaUserId).toBe("meta_user_1");
    expect(bm.metaAccountId).toBe("bm_1");
    expect(bm.name).toBe("Klinik BM");
    expect(decrypt(bm.tokenCiphertext!)).toBe("long_short_code_ok");
    expect(bm.scopes).toEqual([...META_OAUTH_SCOPES]);
    expect(bm.missingPermissions).toEqual([]);
    expect(bm.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 24 * 3600 * 1000);

    const page = await prisma.metaConnection.findFirstOrThrow({ where: { orgId: orgIds[0], type: "PAGE" } });
    expect(page.pageId).toBe("page_mock_1");
    expect(page.instaId).toBe("ig_mock_1");
    expect(page.status).toBe("CONNECTED");
    expect(decrypt(page.tokenCiphertext!)).toBe("mock-page-token");
    expect(page.expiresAt).toBeNull();
    expect(await prisma.metaConnection.count({ where: { orgId: orgIds[0] } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { orgId: orgIds[0], action: "META_CONNECTED", entityId: bm.id } })).toBe(1);

    // Aynı state tekrar kullanılamaz → hata yönlendirmesi (JSON değil).
    const replay = await oauthCallback(req(`/api/meta/oauth/callback?code=code_ok&state=${encodeURIComponent(state)}`, "GET"));
    expect(replay.status).toBe(303);
    const replayParams = locationParams(replay);
    expect(replayParams.get("status")).toBe("error");
    expect(replayParams.get("reason")).toContain("zaten işlenmiş");

    // İkinci bağlantı kurulumunda mevcut BM ve PAGE kayıtları güncellenir, çoğaltılmaz.
    const again = await oauthCallback(req(`/api/meta/oauth/callback?code=code_2&state=${encodeURIComponent(stateFor())}`, "GET"));
    expect(locationParams(again).get("status")).toBe("connected");
    expect(await prisma.metaConnection.count({ where: { orgId: orgIds[0] } })).toBe(2);
    expect(decrypt((await prisma.metaConnection.findUniqueOrThrow({ where: { id: bm.id } })).tokenCiphertext!)).toBe("long_short_code_2");
  });

  it("callback (canlı mod): /me/permissions eksik izinleri, /me/accounts sayfa token'ını ve reklam hesabı varsayılanını işler", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    loadEnv({ fresh: true, overrides: { ...ENV_BASE, META_MOCK_MODE: "false" } });
    const calls: GraphCall[] = [];
    const granted = META_OAUTH_SCOPES.filter((s) => s !== "leads_retrieval" && s !== "whatsapp_business_messaging");
    vi.spyOn(globalThis, "fetch").mockImplementation(graphStub(calls, {
      permissions: {
        data: [
          ...granted.map((permission) => ({ permission, status: "granted" })),
          { permission: "leads_retrieval", status: "declined" },
        ],
      },
      accounts: {
        data: [
          { id: `page_live_${suffix}`, name: "Canlı Sayfa", access_token: "page_tok_live", instagram_business_account: { id: `ig_live_${suffix}` } },
          { id: `page_live2_${suffix}`, name: "İkinci Sayfa" },
        ],
      },
      adaccounts: {
        data: [
          { id: `act_live1_${suffix}`, name: "Hesap 1", currency: "EUR", timezone_name: "Europe/Berlin", account_status: 1 },
          { id: `act_live2_${suffix}`, name: "Hesap 2", currency: "TRY", timezone_name: "Europe/Istanbul", account_status: 1 },
        ],
      },
    }));
    const res = await oauthCallback(req(`/api/meta/oauth/callback?code=code_live&state=${encodeURIComponent(stateFor())}`, "GET"));
    expect(res.status).toBe(303);
    const params = locationParams(res);
    expect(params.get("status")).toBe("connected");
    expect(params.get("missing")).toBe("leads_retrieval");
    expect(params.get("optional")).toBe("whatsapp_business_messaging");
    expect(params.get("pages")).toBe("2");
    expect(params.get("accounts")).toBe("2");

    const perms = calls.find((c) => c.url.includes("/me/permissions"));
    expect(perms).toBeTruthy();
    expect(headerOf(perms!.init, "authorization")).toBe("Bearer long_short_code_live");
    expect(new URL(perms!.url).searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    const accounts = calls.find((c) => c.url.includes("/me/accounts"));
    expect(new URL(accounts!.url).searchParams.get("fields")).toContain("instagram_business_account");
    expect(headerOf(accounts!.init, "authorization")).toBe("Bearer long_short_code_live");

    const bm = await prisma.metaConnection.findFirstOrThrow({ where: { orgId: orgIds[0], type: "BUSINESS_MANAGER" } });
    expect(bm.missingPermissions).toEqual(["leads_retrieval"]);
    expect(bm.scopes).toEqual([...granted]);

    const livePage = await prisma.metaConnection.findFirstOrThrow({ where: { orgId: orgIds[0], type: "PAGE", pageId: `page_live_${suffix}` } });
    expect(livePage.instaId).toBe(`ig_live_${suffix}`);
    expect(decrypt(livePage.tokenCiphertext!)).toBe("page_tok_live");
    expect(livePage.expiresAt).toBeNull();
    const secondPage = await prisma.metaConnection.findFirstOrThrow({ where: { orgId: orgIds[0], type: "PAGE", pageId: `page_live2_${suffix}` } });
    expect(secondPage.tokenCiphertext).toBeNull();
    expect(secondPage.instaId).toBeNull();

    // hasDefault: yalnızca ilk keşfedilen hesap varsayılan olur.
    const adAccounts = await prisma.adAccount.findMany({ where: { orgId: orgIds[0], connectionId: bm.id }, orderBy: { createdAt: "asc" } });
    expect(adAccounts).toHaveLength(2);
    expect(adAccounts.filter((a) => a.isDefault)).toHaveLength(1);
    expect(adAccounts[0]!.isDefault).toBe(true);
    expect(adAccounts[1]!.currency).toBe("TRY");
  });

  it("callback hata durumlarında JSON yerine hata yönlendirmesi döner", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const denied = await oauthCallback(req("/api/meta/oauth/callback?error=access_denied&error_description=Permissions+error", "GET"));
    expect(denied.status).toBe(303);
    expect(locationParams(denied).get("status")).toBe("error");
    expect(locationParams(denied).get("reason")).toContain("access_denied");

    const noState = await oauthCallback(req("/api/meta/oauth/callback?code=x", "GET"));
    expect(locationParams(noState).get("reason")).toContain("state");

    const badState = await oauthCallback(req("/api/meta/oauth/callback?code=x&state=garbage.state", "GET"));
    expect(locationParams(badState).get("reason")).toContain("doğrulanamadı");

    // Başka kullanıcının state'i → 403 mesajı ile yönlendirme.
    const foreignState = createOAuthState(loadEnv().AUTH_SECRET, userIds[2]!, orgIds[1]!).state;
    const mismatch = await oauthCallback(req(`/api/meta/oauth/callback?code=x&state=${encodeURIComponent(foreignState)}`, "GET"));
    expect(locationParams(mismatch).get("reason")).toContain("eşleşmiyor");

    // Meta kod değişimi hatası.
    vi.spyOn(globalThis, "fetch").mockImplementation(graphStub([]));
    const badCode = await oauthCallback(req(`/api/meta/oauth/callback?code=bad_code&state=${encodeURIComponent(stateFor())}`, "GET"));
    expect(locationParams(badCode).get("status")).toBe("error");
    expect(locationParams(badCode).get("reason")).toContain("tokenı alınamadı");

    // MEDIA_BUYER callback'e ulaşamaz.
    cookieJar.set(SESSION_COOKIE, tokenBuyer);
    const buyer = await oauthCallback(req(`/api/meta/oauth/callback?code=x&state=${encodeURIComponent(stateFor())}`, "GET"));
    expect(locationParams(buyer).get("reason")).toContain("yetkiniz yok");
  });

  it("PATCH /api/meta/connections/[id] kimlikleri OWNER/ADMIN için günceller, audit'ler ve tenant'ı izole eder", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const conn = await prisma.metaConnection.findFirstOrThrow({ where: { orgId: orgIds[0], type: "BUSINESS_MANAGER" } });
    const res = await connectionPatch(
      req(`/api/meta/connections/${conn.id}`, "PATCH", { pixelId: "123456789", whatsappPhoneNumberId: "9876", whatsappBusinessId: "waba_1" }),
      { params: Promise.resolve({ id: conn.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed.sort()).toEqual(["pixelId", "whatsappBusinessId", "whatsappPhoneNumberId"]);
    expect(body.connection.pixelId).toBe("123456789");
    expect(body.connection).not.toHaveProperty("tokenCiphertext");
    const updated = await prisma.metaConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(updated.pixelId).toBe("123456789");
    expect(updated.whatsappPhoneNumberId).toBe("9876");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { orgId: orgIds[0], action: "META_CONNECTION_UPDATED", entityId: conn.id } });
    expect(audit.before).toMatchObject({ pixelId: null, whatsappPhoneNumberId: null });
    expect(audit.after).toMatchObject({ pixelId: "123456789", whatsappPhoneNumberId: "9876" });

    // null ile temizleme; değişmeyen alanlar audit'e girmez.
    const cleared = await connectionPatch(
      req(`/api/meta/connections/${conn.id}`, "PATCH", { pixelId: null, whatsappBusinessId: "waba_1" }),
      { params: Promise.resolve({ id: conn.id }) },
    );
    expect((await cleared.json()).changed).toEqual(["pixelId"]);
    expect((await prisma.metaConnection.findUniqueOrThrow({ where: { id: conn.id } })).pixelId).toBeNull();

    // Geçersiz kimlik → 400, bilinmeyen alan → 400.
    expect((await connectionPatch(req(`/api/meta/connections/${conn.id}`, "PATCH", { pixelId: "abc def" }), { params: Promise.resolve({ id: conn.id }) })).status).toBe(400);
    expect((await connectionPatch(req(`/api/meta/connections/${conn.id}`, "PATCH", { tokenCiphertext: "x" }), { params: Promise.resolve({ id: conn.id }) })).status).toBe(400);

    // GET listesi kimlikleri döner, token'ı döndürmez.
    const list = await (await connectionsGet()).json();
    const row = list.connections.find((c: { id: string }) => c.id === conn.id);
    expect(row.whatsappPhoneNumberId).toBe("9876");
    expect(row).not.toHaveProperty("tokenCiphertext");

    // Başka bir organizasyonun aktif bağlantısında kayıtlı kimlik buraya eşlenemez (webhook ele geçirme) → 409.
    const foreignConn = await prisma.metaConnection.findFirst({ where: { orgId: { not: orgIds[0] }, status: "CONNECTED" } });
    if (foreignConn) {
      await prisma.metaConnection.update({ where: { id: foreignConn.id }, data: { pageId: `victim-page-${conn.id}` } });
      const hijack = await connectionPatch(
        req(`/api/meta/connections/${conn.id}`, "PATCH", { pageId: `victim-page-${conn.id}` }),
        { params: Promise.resolve({ id: conn.id }) },
      );
      expect(hijack.status).toBe(409);
      expect((await prisma.metaConnection.findUniqueOrThrow({ where: { id: conn.id } })).pageId).not.toBe(`victim-page-${conn.id}`);
    }

    // MEDIA_BUYER → 403; başka tenant → 404.
    cookieJar.set(SESSION_COOKIE, tokenBuyer);
    expect((await connectionPatch(req(`/api/meta/connections/${conn.id}`, "PATCH", { pixelId: "1" }), { params: Promise.resolve({ id: conn.id }) })).status).toBe(403);
    cookieJar.set(SESSION_COOKIE, tokenForeign);
    expect((await connectionPatch(req(`/api/meta/connections/${conn.id}`, "PATCH", { pixelId: "1" }), { params: Promise.resolve({ id: conn.id }) })).status).toBe(404);
    expect((await connectionDelete(req(`/api/meta/connections/${conn.id}`, "DELETE"), { params: Promise.resolve({ id: conn.id }) })).status).toBe(404);
  });

  it("requireLiveMetaConnection mock modda CONNECTED bağlantı için mock token döner", async () => {
    const conn = await prisma.metaConnection.findFirstOrThrow({ where: { orgId: orgIds[0], type: "BUSINESS_MANAGER" } });
    const live = await requireLiveMetaConnection(conn.id, orgIds[0]!);
    expect(live.mockMode).toBe(true);
    expect(live.token).toBe("mock-token");
    await expect(requireLiveMetaConnection(conn.id, orgIds[1]!)).rejects.toMatchObject({ status: 400 });
  });

  it("canlı mod: süresi dolmuş token EXPIRED, geçersiz token REVOKED olarak kalıcılaşır ve hesaplar durur", async () => {
    loadEnv({ fresh: true, overrides: { ...ENV_BASE, META_MOCK_MODE: "false" } });
    const expired = await prisma.metaConnection.create({
      data: { orgId: orgIds[0]!, type: "AD_ACCOUNT", status: "CONNECTED", name: "Süresi dolmuş", tokenCiphertext: encrypt("tok_expired"), expiresAt: new Date(Date.now() - 1000) },
    });
    const expiredAccount = await prisma.adAccount.create({ data: { orgId: orgIds[0]!, workspaceId: workspaceIds[0]!, connectionId: expired.id, name: "Exp", metaAccountId: `act_exp_${suffix}` } });
    await expect(requireLiveMetaConnection(expired.id, orgIds[0]!)).rejects.toMatchObject({ status: 400 });
    const expiredRow = await prisma.metaConnection.findUniqueOrThrow({ where: { id: expired.id } });
    expect(expiredRow.status).toBe("EXPIRED");
    expect(expiredRow.lastError).toBe("Token süresi doldu.");
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: expiredAccount.id } })).status).toBe("PAUSED");
    await expect(refreshMetaConnection(expired.id)).rejects.toMatchObject({ status: 409 });

    // debug_token geçersiz → REVOKED + lastError.
    vi.spyOn(globalThis, "fetch").mockImplementation(graphStub([]));
    const revoked = await prisma.metaConnection.create({
      data: { orgId: orgIds[0]!, type: "AD_ACCOUNT", status: "CONNECTED", name: "İptal", tokenCiphertext: encrypt("tok_revoked"), expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) },
    });
    const revokedAccount = await prisma.adAccount.create({ data: { orgId: orgIds[0]!, workspaceId: workspaceIds[0]!, connectionId: revoked.id, name: "Rev", metaAccountId: `act_rev_${suffix}` } });
    await expect(refreshMetaConnection(revoked.id)).rejects.toMatchObject({ status: 409 });
    const revokedRow = await prisma.metaConnection.findUniqueOrThrow({ where: { id: revoked.id } });
    expect(revokedRow.status).toBe("REVOKED");
    expect(revokedRow.lastError).toContain("geçersiz");
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: revokedAccount.id } })).status).toBe("PAUSED");
    await expect(requireLiveMetaConnection(revoked.id, orgIds[0]!)).rejects.toMatchObject({ status: 401 });
  });

  it("DELETE bağlantıyı REVOKED yapar, hesapları duraklatır, OPEN uyarı oluşturur; mock modda REVOKED yenilenmez", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const conn = await prisma.metaConnection.findFirstOrThrow({ where: { orgId: orgIds[0], type: "BUSINESS_MANAGER" } });
    const account = await prisma.adAccount.create({ data: { orgId: orgIds[0]!, workspaceId: workspaceIds[0]!, connectionId: conn.id, name: "Del", metaAccountId: `act_del_${suffix}` } });
    const res = await connectionDelete(req(`/api/meta/connections/${conn.id}`, "DELETE"), { params: Promise.resolve({ id: conn.id }) });
    expect(res.status).toBe(200);
    const row = await prisma.metaConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(row.status).toBe("REVOKED");
    expect(row.tokenCiphertext).toBeNull();
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("PAUSED");
    const alerts = await prisma.alert.findMany({ where: { workspaceId: workspaceIds[0]!, type: "META_DISCONNECTED", entityId: conn.id } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe("OPEN");
    expect(alerts[0]!.severity).toBe("CRITICAL");
    // Tekrar DELETE: OPEN uyarı varken ikinci uyarı üretilmez.
    expect((await connectionDelete(req(`/api/meta/connections/${conn.id}`, "DELETE"), { params: Promise.resolve({ id: conn.id }) })).status).toBe(200);
    expect(await prisma.alert.count({ where: { workspaceId: workspaceIds[0]!, type: "META_DISCONNECTED", entityId: conn.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { orgId: orgIds[0], action: "META_DISCONNECTED", entityId: conn.id } })).toBe(2);

    // Mock modda REVOKED bağlantı "Yenile" ile otomatik CONNECTED olmaz (kullanıcı açıkça kesti).
    const refresh = await connectionRefresh(req(`/api/meta/connections/${conn.id}/refresh`, "POST", {}), { params: Promise.resolve({ id: conn.id }) });
    expect(refresh.status).toBe(409);
    expect((await prisma.metaConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("REVOKED");

    // Mock modda CONNECTED bağlantı yenilenir (süre uzar).
    const page = await prisma.metaConnection.findFirstOrThrow({ where: { orgId: orgIds[0], type: "PAGE", pageId: "page_mock_1" } });
    const ok = await connectionRefresh(req(`/api/meta/connections/${page.id}/refresh`, "POST", {}), { params: Promise.resolve({ id: page.id }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).connection.status).toBe("CONNECTED");
  });
});
