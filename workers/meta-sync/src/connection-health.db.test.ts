import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { prisma } from "@admedic/database";
import { encryptField, loadEnv } from "@admedic/config";
import { checkConnectionHealth } from "./scheduler";

const DAY_MS = 24 * 3600 * 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("meta-sync bağlantı sağlığı (DB)", () => {
  const suffix = randomBytes(6).toString("hex");
  let orgId = "";
  let workspaceId = "";
  const webhookCalls: unknown[] = [];

  beforeAll(async () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "true", META_DISCONNECTED_WEBHOOK_URL: "" } });
    const org = await prisma.organization.create({
      data: { name: "Health fixture", slug: `health-${suffix}`, workspaces: { create: { name: "W", slug: "w" } } },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0]!.id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    webhookCalls.length = 0;
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: orgId } });
    vi.unstubAllEnvs();
    loadEnv({ fresh: true });
    await prisma.$disconnect();
  });

  async function workspace() {
    return prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, include: { adAccounts: { include: { connection: true } } } });
  }

  it("kopmuş bağlantı: reklam hesapları PAUSED, uyarı bir kez (OPEN dedup), çözüldükten 24 saat sonra yeniden", async () => {
    const conn = await prisma.metaConnection.create({
      data: { orgId, type: "BUSINESS_MANAGER", status: "EXPIRED", lastError: "Token süresi doldu.", name: "BM" },
    });
    const a1 = await prisma.adAccount.create({ data: { orgId, workspaceId, connectionId: conn.id, name: "A1", metaAccountId: `act_h1_${suffix}` } });
    const a2 = await prisma.adAccount.create({ data: { orgId, workspaceId, connectionId: conn.id, name: "A2", metaAccountId: `act_h2_${suffix}` } });

    const first = await checkConnectionHealth(await workspace());
    expect(first.alerts).toBe(1);
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: a1.id } })).status).toBe("PAUSED");
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: a2.id } })).status).toBe("PAUSED");
    const alert = await prisma.alert.findFirstOrThrow({ where: { workspaceId, type: "META_DISCONNECTED", entityId: conn.id } });
    expect(alert.severity).toBe("CRITICAL");
    expect(alert.message).toContain(a1.id);
    expect(alert.message).toContain(a2.id);

    // Bağlantı bazlı döngü: iki reklam hesabı olsa da tek uyarı; OPEN varken tekrar yok.
    expect((await checkConnectionHealth(await workspace())).alerts).toBe(0);
    expect(await prisma.alert.count({ where: { workspaceId, type: "META_DISCONNECTED", entityId: conn.id } })).toBe(1);

    // ACK edildi (createdAt taze) → 24 saat boyunca yine üretilmez.
    await prisma.alert.update({ where: { id: alert.id }, data: { status: "ACKED" } });
    expect((await checkConnectionHealth(await workspace())).alerts).toBe(0);

    // 25 saat önce çözülmüş → yeni uyarı.
    await prisma.alert.update({ where: { id: alert.id }, data: { status: "RESOLVED", resolvedAt: new Date(Date.now() - 25 * 3600 * 1000), createdAt: new Date(Date.now() - 26 * 3600 * 1000) } });
    expect((await checkConnectionHealth(await workspace())).alerts).toBe(1);
    expect(await prisma.alert.count({ where: { workspaceId, type: "META_DISCONNECTED", entityId: conn.id } })).toBe(2);
    await prisma.metaConnection.delete({ where: { id: conn.id } });
  });

  it("süresi dolmuş token → EXPIRED + lastError kalıcılaşır, hesaplar durur, webhook bir kez gider", async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "false", META_APP_ID: "app_x", META_APP_SECRET: "secret_x", META_DISCONNECTED_WEBHOOK_URL: "https://hooks.example.invalid/meta" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      webhookCalls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true });
    });
    const conn = await prisma.metaConnection.create({
      data: {
        orgId, type: "BUSINESS_MANAGER", status: "CONNECTED", name: "Expired BM",
        tokenCiphertext: encryptField("user-token-old"), expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const acc = await prisma.adAccount.create({ data: { orgId, workspaceId, connectionId: conn.id, name: "A3", metaAccountId: `act_h3_${suffix}` } });
    try {
      const result = await checkConnectionHealth(await workspace());
      expect(result.alerts).toBe(1);
      expect(result.webhooks).toBe(1);
      const updated = await prisma.metaConnection.findUniqueOrThrow({ where: { id: conn.id } });
      expect(updated.status).toBe("EXPIRED");
      expect(updated.lastError).toBe("Token süresi doldu.");
      expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: acc.id } })).status).toBe("PAUSED");
      // debug_token/exchange çağrısı yapılmadı; yalnızca webhook gitti.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((webhookCalls[0] as { body: { status: string; adAccountIds: string[] } }).body.status).toBe("EXPIRED");
      expect((webhookCalls[0] as { body: { adAccountIds: string[] } }).body.adAccountIds).toEqual([acc.id]);
      // İkinci tur: OPEN uyarı var → yeni uyarı/webhook yok.
      const again = await checkConnectionHealth(await workspace());
      expect(again.alerts).toBe(0);
      expect(again.webhooks).toBe(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await prisma.metaConnection.delete({ where: { id: conn.id } });
      loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "true" } });
    }
  });

  it("son kullanma bilinmeyen token debug_token ile kontrol edilir; geçersizse REVOKED + lastError", async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "false", META_APP_ID: "app_x", META_APP_SECRET: "secret_x", META_DISCONNECTED_WEBHOOK_URL: "" } });
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/debug_token"))
        return jsonResponse({ data: { is_valid: false, error: { code: 190, message: "The session has been invalidated" } } });
      return jsonResponse({ error: { code: 1, message: "beklenmeyen çağrı" } }, 400);
    });
    const conn = await prisma.metaConnection.create({
      data: {
        orgId, type: "PAGE", status: "CONNECTED", name: "Sayfa", pageId: `page_${suffix}`,
        tokenCiphertext: encryptField("page-token"), expiresAt: null,
      },
    });
    try {
      const result = await checkConnectionHealth(await workspace());
      expect(result.alerts).toBe(1);
      expect(calls.some((u) => u.includes("/debug_token"))).toBe(true);
      const updated = await prisma.metaConnection.findUniqueOrThrow({ where: { id: conn.id } });
      expect(updated.status).toBe("REVOKED");
      expect(updated.lastError).toContain("invalidated");
      const alert = await prisma.alert.findFirstOrThrow({ where: { workspaceId, type: "META_DISCONNECTED", entityId: conn.id } });
      expect(alert.title).toContain("REVOKED");
    } finally {
      await prisma.metaConnection.delete({ where: { id: conn.id } });
      loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "true" } });
    }
  });

  it("mock modda CONNECTED bağlantıya dokunulmaz", async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "true" } });
    const conn = await prisma.metaConnection.create({ data: { orgId, type: "BUSINESS_MANAGER", status: "CONNECTED", name: "Mock BM", expiresAt: new Date(Date.now() - DAY_MS) } });
    try {
      const result = await checkConnectionHealth(await workspace());
      expect(result.alerts).toBe(0);
      expect((await prisma.metaConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("CONNECTED");
    } finally {
      await prisma.metaConnection.delete({ where: { id: conn.id } });
    }
  });
});
