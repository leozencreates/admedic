import { test, expect, type Page } from "@playwright/test";
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
    if (userId) await prisma.user.delete({ where: { id: userId } });
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
        for (const e of errors) failures.push(`${route}: sayfa hatası ${e.slice(0, 160)}`);
        await page.close();
      }
      await context.close();
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});
