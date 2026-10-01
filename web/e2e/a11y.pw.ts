import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

/**
 * Otomatik erişilebilirlik kapısı (ADR-0021 · K11-B): her sayfa masaüstü (1366×768) ve telefon (390×844)
 * boyutunda axe-core ile WCAG 2.1 A/AA kurallarına göre taranır; ayrıca yatay taşma ve sayfa hatası aranır.
 * Yeni bir erişilebilirlik hatası giren değişiklik bu testte kırılır.
 *
 * Çalıştırma (veritabanı gerektirir): STUDIO_E2E=1 pnpm --filter web test:e2e -- a11y
 * Veri: test kendi kuruluşunu, hesap sahibini ve örnek kayıtları (lead + konuşma, kampanya, klinik) oluşturur,
 * bitince siler. Oturum çerezi doğrudan yazılır (giriş kotası harcanmaz).
 */
const axeSource = createRequire(__filename).resolve("axe-core/axe.min.js");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const VIEWPORTS = [
  { name: "masaüstü", width: 1366, height: 768, isMobile: false },
  { name: "telefon", width: 390, height: 844, isMobile: true },
] as const;

async function audit(page: Page) {
  await page.addScriptTag({ path: axeSource });
  // Next.js geliştirme göstergesi uygulamanın parçası değildir.
  await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((e) => e.remove()));
  return page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: tags } });
    return {
      violations: result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  }, TAGS);
}

/**
 * Sesli asistan (ADR-0028) sunucuda açık mı? Çerezsiz, Origin'siz istek: kapalıysa 404, açıksa kaynak denetimi 403.
 * Kayıt yazılmaz. Açıksa düğme her panel sayfasında taranır; panel ve diyalog ayrıca açılıp taranır (deneme modu).
 */
async function assistantEnabled(request: APIRequestContext, baseURL: string | undefined): Promise<boolean> {
  const res = await request.post(new URL("/api/assistant/events", baseURL ?? "http://localhost:3000").href, {
    data: {},
    headers: { "content-type": "application/json" },
  });
  return res.status() !== 404;
}

test.describe("erişilebilirlik kapısı", () => {
  test.skip(process.env.STUDIO_E2E !== "1", "Veritabanı fikstürü gerekir: STUDIO_E2E=1");
  const suffix = randomBytes(8).toString("hex");
  const token = randomBytes(32).toString("hex");
  let orgId = "";
  let userId = "";
  let leadId = "";
  let campaignId = "";

  test.beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `a11y-${suffix}@example.invalid`, name: "Erişilebilirlik Denetimi" } });
    userId = user.id;
    const org = await prisma.organization.create({
      data: {
        name: "Erişilebilirlik fikstürü",
        slug: `a11y-${suffix}`,
        members: { create: { userId, role: "OWNER" } },
        workspaces: { create: { name: "Erişilebilirlik", slug: "main" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    const workspaceId = org.workspaces[0].id;
    const account = await prisma.adAccount.create({ data: { orgId, workspaceId, name: "Hesap", currency: "EUR" } });
    const campaign = await prisma.campaign.create({
      data: { adAccountId: account.id, workspaceId, name: "Almanya — Saç ekimi", dailyBudget: 5000, workflowStatus: "IN_REVIEW" },
    });
    campaignId = campaign.id;
    const lead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, firstName: "Anna", lastName: "Schmidt", channel: "WHATSAPP", language: "de", country: "DE", status: "NEW" },
    });
    leadId = lead.id;
    const conversation = await prisma.conversation.create({ data: { leadId, workspaceId, channel: "WHATSAPP", status: "ESCALATED" } });
    await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INCOMING", channel: "WHATSAPP", content: "Guten Tag, was kostet eine Haartransplantation?", sender: "external" },
    });
    await prisma.webSession.create({
      data: { tokenHash: tokenHash(token), userId, workspaceId, expiresAt: new Date(Date.now() + 3600_000) },
    });
  });

  test.afterAll(async () => {
    if (orgId) await prisma.organization.delete({ where: { id: orgId } });
    if (userId) {
      // Sesli asistan oturum/olay kotaları (yalnızca asistan açıkken oluşur).
      await prisma.requestQuota.deleteMany({
        where: { OR: [{ key: { startsWith: `voice:${userId}:` } }, { key: { startsWith: `voice-event:${userId}:` } }] },
      });
      await prisma.user.delete({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  const routes = () => [
    "/",
    "/approvals",
    "/leads",
    `/leads/${leadId}`,
    "/studio",
    "/library",
    "/creative",
    "/tests",
    "/experiments",
    "/campaigns",
    `/campaigns/${campaignId}`,
    `/campaigns/${campaignId}?tab=performance`,
    "/campaign-planner",
    "/insights",
    "/recommendations",
    "/decisions",
    "/alerts",
    "/clinic",
    "/meta-connections",
    "/platforms",
    "/policies",
    "/policy-rules",
    "/billing",
    "/go-live",
  ];

  for (const vp of VIEWPORTS) {
    test(`tüm sayfalar · ${vp.name}`, async ({ browser, baseURL }) => {
      test.setTimeout(10 * 60_000);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.isMobile,
      });
      await context.addCookies([{ name: SESSION_COOKIE, value: token, url: baseURL ?? "http://localhost:3000" }]);
      const failures: string[] = [];
      const assistant = await assistantEnabled(context.request, baseURL);
      for (const route of [...routes(), "/login"]) {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        if (route === "/login") await context.clearCookies();
        const response = await page.goto(route, { waitUntil: "networkidle", timeout: 120_000 });
        if (!response || response.status() >= 400) failures.push(`${route}: HTTP ${response?.status()}`);
        const { violations, overflow } = await audit(page);
        for (const v of violations) failures.push(`${route}: ${v}`);
        if (overflow) failures.push(`${route}: yatay taşma`);
        // Asistan düğmesi taramaya dahil: açıksa her panel sayfasında tam bir tane; kapalıyken ve giriş sayfasında hiç
        // (özellik bayrağı sunucudan gelir, düğme 404 beklenmeden gizlenir).
        const fabs = await page.locator(".va-fab").count();
        const expectedFabs = assistant && route !== "/login" ? 1 : 0;
        if (fabs !== expectedFabs) failures.push(`${route}: asistan düğmesi ${fabs} (beklenen ${expectedFabs})`);
        for (const e of errors) failures.push(`${route}: sayfa hatası ${e.slice(0, 160)}`);
        await page.close();
      }
      await context.close();
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }

  // Sesli asistan: aydınlatma diyaloğu, açık panel ve ekrandaki modal onay penceresi (deneme modu, metin kipi) her iki
  // boyutta taranır.
  for (const vp of VIEWPORTS) {
    test(`sesli asistan · ${vp.name}`, async ({ browser, baseURL }) => {
      test.setTimeout(5 * 60_000);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.isMobile,
      });
      const enabled = await assistantEnabled(context.request, baseURL);
      if (!enabled) await context.close();
      test.skip(
        !enabled,
        "Sunucuda sesli asistan kapalı: VOICE_ASSISTANT_ENABLED=true, ELEVENLABS_ASSISTANT_AGENT_ID ve META_MOCK_MODE=true gerekir",
      );
      await context.addCookies([{ name: SESSION_COOKIE, value: token, url: baseURL ?? "http://localhost:3000" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto("/", { waitUntil: "networkidle", timeout: 120_000 });
      const failures: string[] = [];
      const check = async (label: string) => {
        const { violations, overflow } = await audit(page);
        for (const v of violations) failures.push(`${label}: ${v}`);
        if (overflow) failures.push(`${label}: yatay taşma`);
      };

      await page.getByRole("button", { name: /sesli asistan:/ }).click();
      const dialog = page.getByRole("dialog", { name: "Sesli asistan hakkında" });
      await expect(dialog).toBeVisible();
      await check("izin diyaloğu");

      await dialog.getByRole("button", { name: "Kabul ediyorum, başlat" }).click();
      const input = page.getByLabel("Asistana yazın");
      await expect(input).toBeEnabled({ timeout: 15_000 });
      await check("açık panel");

      // Konuşma satırları ve durum metni dolu panel.
      await input.fill("kampanyaları göster");
      await input.press("Enter");
      await expect(page.locator('.va-panel .va-line[data-role="agent"]')).toHaveCount(2, { timeout: 15_000 });
      await check("konuşmalı panel");

      // Ekrandaki modal onay penceresi (ADR-0028 Faz 4): R3 bütçe artışı en dolu hâlidir (alanlar eski → yeni, risk
      // rozeti, harcama uyarısı, geri sayım, "Harcamayı onayla"). Etkinleşmeden önce ve sonra taranır; Vazgeç ile
      // kapatılır, hiçbir yazma isteği gitmez. Kampanya ref'i (c1) yukarıdaki listeden gelir.
      await input.fill("bütçeyi 80 artır");
      await input.press("Enter");
      const screen = page.getByRole("dialog", { name: "Günlük bütçeyi artır" });
      await expect(screen).toBeVisible({ timeout: 15_000 });
      const confirmSpend = screen.getByRole("button", { name: "Harcamayı onayla" });
      await expect(confirmSpend).toHaveAttribute("aria-disabled", "true");
      await check("onay penceresi (R3, etkinleşmeden)");
      await expect(confirmSpend).not.toHaveAttribute("aria-disabled", "true");
      await check("onay penceresi (R3, etkin)");
      await screen.getByRole("button", { name: "Vazgeç" }).click();
      await expect(screen).toHaveCount(0);

      for (const e of errors) failures.push(`sayfa hatası ${e.slice(0, 160)}`);
      await context.close();
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});
