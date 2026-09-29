import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";

const { debug, accounts } = vi.hoisted(() => ({ debug: vi.fn(), accounts: vi.fn() }));
vi.mock("@admedic/meta-api", async (orig) => ({
  ...(await orig<typeof import("@admedic/meta-api")>()),
  getAppAccessToken: () => "app|secret",
  getTokenDebug: debug,
  createMetaClient: () => ({ getAdAccounts: accounts }),
}));

import { metaChecks } from "../app/_lib/go-live";
import { encrypt } from "../app/_lib/encrypt";

/** Canlı modda Meta denetimi (ADR-0023): token, izin ve hesap sonuçları; Meta yanıtı sahte, yazma yok. */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("canlıya geçiş: Meta denetimi (canlı mod)", () => {
  const suffix = randomBytes(6).toString("hex");
  let orgId = "";

  beforeAll(async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "false", META_API_VERSION: "v26.0", META_APP_ID: "1", META_APP_SECRET: "s".repeat(32) } });
    const org = await prisma.organization.create({ data: { name: "Canlı Meta", slug: `golive-meta-${suffix}` } });
    orgId = org.id;
    await prisma.metaConnection.create({
      data: { orgId, type: "BUSINESS_MANAGER", name: "Klinik BM", tokenCiphertext: encrypt("user-token"), pageId: "p1" },
    });
  });
  afterAll(async () => {
    loadEnv({ fresh: true });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("eksik izni ve yakında dolacak anahtarı bildirir; reklam hesaplarını okur", async () => {
    const now = new Date("2026-10-01T00:00:00Z");
    debug.mockResolvedValue({
      isValid: true,
      expiresAt: new Date("2026-10-04T00:00:00Z"),
      scopes: ["ads_management", "ads_read", "business_management", "pages_show_list"],
      userId: "u",
      appId: "1",
    });
    accounts.mockResolvedValue([{ id: "act_1" }]);
    const result = await metaChecks(orgId, now);
    expect(result.live).toBe(true);
    const checks = Object.fromEntries(result.connections[0].checks.map((c) => [c.key, c]));
    expect(debug).toHaveBeenCalledWith("user-token", "app|secret");
    expect(checks.token).toMatchObject({ status: "warn" });
    expect(checks.scopes.status).toBe("fail");
    expect(checks.accounts).toMatchObject({ status: "ok" });
    expect(checks.page.status).toBe("ok");
    expect(checks.pixel.status).toBe("warn");
    expect(JSON.stringify(result)).not.toContain("user-token");
  });

  it("sayfa bağlantısında lead bildirimi aboneliğini okur", async () => {
    const page = await prisma.metaConnection.create({
      data: { orgId, type: "PAGE", name: "Klinik Sayfası", tokenCiphertext: encrypt("page-token"), pageId: "p42" },
    });
    debug.mockResolvedValue({ isValid: true, expiresAt: null, scopes: ["ads_management", "ads_read", "business_management", "pages_show_list", "leads_retrieval"], userId: "u", appId: "1" });
    accounts.mockResolvedValue([]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain("/p42/subscribed_apps");
      expect(url).toContain("appsecret_proof=");
      return new Response(JSON.stringify({ data: [{ id: "1", subscribed_fields: ["messages"] }] }), { status: 200 });
    });
    const result = await metaChecks(orgId);
    fetchSpy.mockRestore();
    const pageReport = result.connections.find((c) => c.id === page.id)!;
    expect(pageReport.checks.find((c) => c.key === "subscription")).toMatchObject({ status: "fail" });
    await prisma.metaConnection.delete({ where: { id: page.id } });
  });

  it("geçersiz anahtar engel olarak görünür", async () => {
    debug.mockResolvedValue({ isValid: false, expiresAt: null, scopes: [], userId: null, appId: null, error: "Session expired" });
    accounts.mockResolvedValue([]);
    const result = await metaChecks(orgId);
    expect(result.connections[0].checks.find((c) => c.key === "token")).toMatchObject({ status: "fail" });
  });
});
