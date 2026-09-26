import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { loadEnv } from "@admedic/config";
import { buildApp, LOG_REDACT_PATHS } from "../src/app";
import { prisma, authorizeApiRequest, bearerToken, allowedOrigins, parseDays, tokenMatches } from "../src/lib";

let app: Awaited<ReturnType<typeof buildApp>>;

describe("api saf yardımcıları", () => {
  it("parseDays: 1–90 aralığı, varsayılan 7", () => {
    expect(parseDays({ days: "30" })).toBe(30);
    expect(parseDays({ days: "0" })).toBe(7);
    expect(parseDays({ days: "91" })).toBe(7);
    expect(parseDays({})).toBe(7);
    expect(parseDays(undefined)).toBe(7);
  });
  it("bearerToken + tokenMatches sabit zamanlı karşılaştırır", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches(null, "abc")).toBe(false);
  });
  it("authorizeApiRequest: belirteç yoksa mock modda izin, aksi halde 503; belirteç varsa Bearer zorunlu", () => {
    const base = loadEnv({ fresh: true });
    expect(authorizeApiRequest(undefined, { ...base, API_TOKEN: undefined, META_MOCK_MODE: true })).toEqual({ ok: true });
    expect(authorizeApiRequest(undefined, { ...base, API_TOKEN: undefined, META_MOCK_MODE: false })).toMatchObject({ ok: false, status: 503 });
    expect(authorizeApiRequest(undefined, { ...base, API_TOKEN: "secret", META_MOCK_MODE: true })).toMatchObject({ ok: false, status: 401 });
    expect(authorizeApiRequest("Bearer wrong", { ...base, API_TOKEN: "secret", META_MOCK_MODE: true })).toMatchObject({ ok: false, status: 401 });
    expect(authorizeApiRequest("Bearer secret", { ...base, API_TOKEN: "secret", META_MOCK_MODE: false })).toEqual({ ok: true });
  });
  it("CORS kaynakları: AUTH_URL origin + Tauri", () => {
    const base = loadEnv({ fresh: true });
    const origins = allowedOrigins({ ...base, AUTH_URL: "https://panel.example.com/login" });
    expect(origins).toContain("https://panel.example.com");
    expect(origins).toContain("tauri://localhost");
    expect(origins).toContain("http://tauri.localhost");
    expect(origins).not.toContain("*");
  });
  it("log redaksiyonu authorization/cookie/token/email/phone alanlarını kapsar", () => {
    for (const field of ["authorization", "cookie", "token", "email", "phone"]) {
      expect(LOG_REDACT_PATHS.some((p) => p === field || p === `*.${field}`)).toBe(true);
    }
    expect(LOG_REDACT_PATHS).toContain("req.headers.authorization");
    expect(LOG_REDACT_PATHS).toContain("req.headers.cookie");
  });
});

describe("api caps (read-only REST, ADR-0001/0003 sözleşmesi)", () => {
  beforeAll(async () => {
    vi.stubEnv("API_TOKEN", "");
    vi.stubEnv("META_MOCK_MODE", "true");
    loadEnv({ fresh: true });
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
    loadEnv({ fresh: true });
    await prisma.$disconnect();
  });

  it("health → ok; servis adı APP_NAME tabanlı (sabit yazılmaz)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: `${loadEnv().APP_NAME} API` });
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.json()).toMatchObject({ appName: loadEnv().APP_NAME });
    expect(root.json().endpoints).toContain("/v1/overview");
  });

  it("GET /v1/overview → tek kiracılı çalışma alanı + 7g metrikler + kampanya listesi", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/overview?days=7" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.appName).toBe(loadEnv().APP_NAME);
    expect(body.workspace.name).toBeTruthy();
    expect(body.days).toBe(7);
    expect(body.counts).toMatchObject({ campaigns: 5, adsets: 10, ads: 50 });
    expect(body.lastNDays.spendCents).toBeGreaterThan(0);
    expect(body.lastNDays.roas === null || typeof body.lastNDays.roas === "number").toBe(true);
    expect(body.approvals.pending).toBeGreaterThan(0);
    expect(body.alerts.open).toBeGreaterThan(0);
    expect(body.policy.mode).toBe("APPROVAL");
    expect(body.campaigns).toHaveLength(5);
    for (const c of body.campaigns) {
      expect(typeof c.dailyBudgetCents).toBe("number");
      expect(c.lastNDays).toHaveProperty("spendCents");
    }
  });

  it("GET /v1/campaigns → 5 kampanya, her biri adAccount + adSetCount + ROAS + dailyBudgetCents", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/campaigns?days=7" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.campaigns).toHaveLength(5);
    for (const c of body.campaigns) {
      expect(c.name).toBeTruthy();
      expect(c.adAccount.currency).toBeTruthy();
      expect(c.adSetCount).toBeGreaterThan(0);
      expect(typeof c.dailyBudgetCents).toBe("number");
      expect(c.lastNDays.roas === null || typeof c.lastNDays.roas === "number").toBe(true);
    }
  });

  it("GET /v1/decisions → onay özeti + karar listesi", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/decisions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toHaveProperty("PENDING");
    expect(body.decisions.length).toBeGreaterThan(0);
  });

  it("GET /v1/alerts → açık uyarı özeti (open/critical/warning)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/alerts" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.open).toBeGreaterThanOrEqual(body.summary.critical + body.summary.warning);
    expect(body.alerts.length).toBeGreaterThan(0);
  });

  it("API_TOKEN yokken mock kapalıysa /v1/* 503, /health açık", async () => {
    vi.stubEnv("META_MOCK_MODE", "false");
    loadEnv({ fresh: true });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/overview" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toContain("API_TOKEN");
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      vi.stubEnv("META_MOCK_MODE", "true");
      loadEnv({ fresh: true });
    }
  });

  it("API_TOKEN varken Bearer zorunlu: eksik/yanlış 401, doğru 200", async () => {
    vi.stubEnv("API_TOKEN", "test-token-123");
    loadEnv({ fresh: true });
    try {
      const missing = await app.inject({ method: "GET", url: "/v1/alerts" });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers["www-authenticate"]).toContain("Bearer");
      const wrong = await app.inject({ method: "GET", url: "/v1/alerts", headers: { authorization: "Bearer nope" } });
      expect(wrong.statusCode).toBe(401);
      const ok = await app.inject({ method: "GET", url: "/v1/alerts", headers: { authorization: "Bearer test-token-123" } });
      expect(ok.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      vi.stubEnv("API_TOKEN", "");
      loadEnv({ fresh: true });
    }
  });

  it("CORS: Tauri ve AUTH_URL kaynakları kabul, yabancı kaynak reddedilir", async () => {
    const tauri = await app.inject({ method: "GET", url: "/health", headers: { origin: "tauri://localhost" } });
    expect(tauri.headers["access-control-allow-origin"]).toBe("tauri://localhost");
    const panel = await app.inject({ method: "GET", url: "/health", headers: { origin: new URL(loadEnv().AUTH_URL).origin } });
    expect(panel.headers["access-control-allow-origin"]).toBe(new URL(loadEnv().AUTH_URL).origin);
    const foreign = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
