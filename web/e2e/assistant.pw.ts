import { test, expect, type APIRequestContext, type Browser, type Page, type Request } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

/**
 * Sesli komut asistanı uçtan uca (ADR-0028 · Faz 2, yalnızca R0). Deneme modunda çalışır: oturum ucu `mock: true`
 * döner ve istemci ElevenLabs yerine senaryolu bağdaştırıcıyı (`MockAdapter`) kullanır; araçlar gerçek `clientTools`
 * yolundan (rol süzgeci, ref'ler, temizleme, denetim olayı) ve kullanıcının oturum çereziyle gerçek `/api/*` uçlarından
 * geçer. Mikrofon ve ağ dışı servis kullanılmaz.
 *
 * Çalıştırma (veritabanı gerektirir; sunucu şu ortamla açılmış olmalı):
 *   VOICE_ASSISTANT_ENABLED=true ELEVENLABS_ASSISTANT_AGENT_ID=<yer tutucu> META_MOCK_MODE=true
 *   STUDIO_E2E=1 pnpm --filter web test:e2e -- assistant
 * Sunucuda özellik kapalıysa (uç 404) özelliğe bağlı testler atlanır; "kapalı" davranışı ayrıca ağ yanıtı taklidiyle
 * sınanır. Asistan adı koda yazılmadığı için testler adı değil, rolleri ve sabit Türkçe metinleri kullanır.
 */
const LIVE_SELECTOR = ".va-root [role=status]";
const ALERT_SELECTOR = ".va-root [role=alert]";
const FAB_NAME = /sesli asistan:/;
const INPUT_LABEL = "Asistana yazın";
const CONSENT_TITLE = "Sesli asistan hakkında";
const MOCK_NOTICE = "Deneme modu: asistan yazılı komutlarla çalışır";

/**
 * Özellik açık mı? Çerezsiz ve Origin başlığı olmadan olay ucuna gidilir: kapalıysa 404, açıksa kaynak denetimi
 * 403 döner. Hiçbir kayıt yazılmaz, kota harcanmaz.
 */
let enabledCache: boolean | null = null;
async function assistantEnabled(request: APIRequestContext): Promise<boolean> {
  if (enabledCache === null) {
    const res = await request.post("/api/assistant/events", { data: {}, headers: { "content-type": "application/json" } });
    enabledCache = res.status() !== 404;
  }
  return enabledCache;
}

const SKIP_REASON =
  "Sunucuda sesli asistan kapalı: VOICE_ASSISTANT_ENABLED=true, ELEVENLABS_ASSISTANT_AGENT_ID ve META_MOCK_MODE=true gerekir";

/** Canlı bölgenin (durum) tüm metin geçmişi: React metni hızla değiştirse de her ara değer kaydedilir. */
function recordLiveRegion(page: Page) {
  return page.addInitScript((selector) => {
    const history: string[] = [];
    (window as unknown as { __vaLive: string[] }).__vaLive = history;
    const push = (value: string | null | undefined) => {
      const text = (value ?? "").trim();
      if (text && history[history.length - 1] !== text) history.push(text);
    };
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        const el = m.target.nodeType === Node.TEXT_NODE ? m.target.parentElement : (m.target as Element);
        const live = el?.closest?.(selector);
        if (!live) continue;
        if (m.type === "characterData") push(m.oldValue);
        m.removedNodes.forEach((n) => push(n.textContent));
        push(live.textContent);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  }, LIVE_SELECTOR);
}

async function liveHistory(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __vaLive?: string[] }).__vaLive ?? []);
}

/** Asistanın gönderdiği denetim olayları (yalnızca gövde; konuşma metni içermemeli). */
function collectEvents(page: Page): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  page.on("request", (req: Request) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/assistant/events") {
      try {
        events.push(req.postDataJSON() as Record<string, unknown>);
      } catch {
        events.push({ unparsable: req.postData() });
      }
    }
  });
  return events;
}

function fab(page: Page) {
  return page.getByRole("button", { name: FAB_NAME });
}

function consentDialog(page: Page) {
  return page.getByRole("dialog", { name: CONSENT_TITLE });
}

function panel(page: Page) {
  return page.locator(".va-panel");
}

/** Düğmeye basar; aydınlatma diyaloğu gelirse kabul eder ve deneme oturumu bağlanana kadar bekler. */
async function startAssistant(page: Page) {
  await fab(page).click();
  await expect(consentDialog(page).or(panel(page))).toBeVisible();
  if (await consentDialog(page).isVisible()) {
    await consentDialog(page).getByRole("button", { name: "Kabul ediyorum, başlat" }).click();
  }
  await expect(panel(page)).toBeVisible();
  await expect(page.getByLabel(INPUT_LABEL), "deneme oturumu bağlanmadı").toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText(MOCK_NOTICE), "oturum deneme modunda değil (META_MOCK_MODE=true gerekir)").toBeVisible();
}

async function say(page: Page, text: string) {
  const agentLines = panel(page).locator('.va-line[data-role="agent"]');
  const before = await agentLines.count();
  await page.getByLabel(INPUT_LABEL).fill(text);
  await page.getByLabel(INPUT_LABEL).press("Enter");
  await expect(panel(page).locator('.va-line[data-role="user"]').last()).toContainText(text);
  await expect(agentLines).toHaveCount(before + 1, { timeout: 15_000 });
  return agentLines.last();
}

test.describe("sesli komut asistanı (deneme modu)", () => {
  test.skip(process.env.STUDIO_E2E !== "1", "Veritabanı fikstürü gerekir: STUDIO_E2E=1");
  const suffix = randomBytes(8).toString("hex");
  const ownerToken = randomBytes(32).toString("hex");
  const viewerToken = randomBytes(32).toString("hex");
  let orgId = "";
  let ownerId = "";
  let viewerId = "";
  let campaignIds: string[] = [];

  test.beforeAll(async () => {
    const owner = await prisma.user.create({ data: { email: `va-owner-${suffix}@example.invalid`, name: "Asistan Sahibi" } });
    ownerId = owner.id;
    const viewer = await prisma.user.create({ data: { email: `va-viewer-${suffix}@example.invalid`, name: "Asistan İzleyici" } });
    viewerId = viewer.id;
    const org = await prisma.organization.create({
      data: {
        name: "Asistan fikstürü",
        slug: `va-${suffix}`,
        members: { create: [{ userId: ownerId, role: "OWNER" }, { userId: viewerId, role: "VIEWER" }] },
        workspaces: { create: { name: "Asistan", slug: "main" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    const workspaceId = org.workspaces[0].id;
    const account = await prisma.adAccount.create({ data: { orgId, workspaceId, name: "Hesap", currency: "EUR" } });
    const campaigns = await Promise.all(
      ["Almanya — Saç ekimi", "Hollanda — Diş"].map((name) =>
        prisma.campaign.create({ data: { adAccountId: account.id, workspaceId, name, dailyBudget: 5000, workflowStatus: "DRAFT" } }),
      ),
    );
    campaignIds = campaigns.map((c) => c.id);
    // Kişisel veri içeren lead: asistanın hiçbir çıktısında görünmemeli.
    await prisma.lead.create({
      data: {
        workspaceId,
        organizationId: orgId,
        firstName: "Anna",
        lastName: "Schmidt",
        email: `anna-${suffix}@example.invalid`,
        phone: "+491701234567",
        channel: "WHATSAPP",
        language: "de",
        country: "DE",
        status: "NEW",
      },
    });
    const expiresAt = new Date(Date.now() + 3600_000);
    await prisma.webSession.createMany({
      data: [
        { tokenHash: tokenHash(ownerToken), userId: ownerId, workspaceId, expiresAt },
        { tokenHash: tokenHash(viewerToken), userId: viewerId, workspaceId, expiresAt },
      ],
    });
  });

  test.afterAll(async () => {
    if (orgId) await prisma.organization.delete({ where: { id: orgId } });
    for (const id of [ownerId, viewerId].filter(Boolean)) {
      await prisma.requestQuota.deleteMany({
        where: { OR: [{ key: { startsWith: `voice:${id}:` } }, { key: { startsWith: `voice-event:${id}:` } }] },
      });
      await prisma.user.delete({ where: { id } });
    }
    await prisma.$disconnect();
  });

  async function open(browser: Browser, baseURL: string | undefined, token: string | null, path = "/") {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    if (token) await context.addCookies([{ name: SESSION_COOKIE, value: token, url: baseURL ?? "http://localhost:3000" }]);
    const page = await context.newPage();
    await recordLiveRegion(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(path, { waitUntil: "networkidle", timeout: 120_000 });
    return { context, page, errors };
  }

  test("düğme: özellik açıkken panel sayfalarında görünür, giriş sayfasında yok", async ({ browser, baseURL, request }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, ownerToken);
    for (const path of ["/", "/campaigns", "/approvals", "/leads"]) {
      await page.goto(path, { waitUntil: "networkidle" });
      await expect(fab(page), path).toBeVisible();
      await expect(fab(page)).toHaveAttribute("aria-pressed", "false");
      await expect(fab(page)).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Space");
      // Canlı bölgeler her zaman DOM'da.
      await expect(page.locator(LIVE_SELECTOR)).toBeAttached();
      await expect(page.locator(ALERT_SELECTOR)).toBeAttached();
    }
    await context.clearCookies();
    await page.goto("/login", { waitUntil: "networkidle" });
    await expect(page.locator(".va-fab")).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("özellik kapalıyken (uç 404) düğme gizlenir ve sekme boyunca gizli kalır", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const { context, page } = await open(browser, baseURL, ownerToken);
    const notFound = { status: 404, json: { error: "Sesli asistan bu kurulumda etkin değil." } };
    await page.route("**/api/assistant/session", (route) => route.fulfill(notFound));
    await page.route("**/api/assistant/events", (route) => route.fulfill(notFound));
    await expect(fab(page)).toBeVisible();
    await fab(page).click();
    await consentDialog(page).getByRole("button", { name: "Kabul ediyorum, başlat" }).click();
    await expect(page.locator(".va-fab")).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator(LIVE_SELECTOR)).toBeAttached();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator(".va-fab")).toHaveCount(0);
    await context.close();
  });

  test("aydınlatma diyaloğu: vazgeç oturum açmaz, kabul bir kez sorulur ve denetime yazılır", async ({ browser, baseURL, request }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, ownerToken);
    const events = collectEvents(page);
    const sessionCalls: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/assistant/session") sessionCalls.push(r.method());
    });

    // Vazgeç: oturum isteği yok, odak düğmeye döner.
    await fab(page).click();
    await expect(consentDialog(page)).toBeVisible();
    await expect(consentDialog(page)).toContainText("ElevenLabs");
    await expect(consentDialog(page).getByRole("button", { name: "Vazgeç" })).toBeFocused();
    await consentDialog(page).getByRole("button", { name: "Vazgeç" }).click();
    await expect(consentDialog(page)).toBeHidden();
    await expect(fab(page)).toBeFocused();

    // Esc de diyaloğu kapatır, oturum açmaz.
    await fab(page).click();
    await expect(consentDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(consentDialog(page)).toBeHidden();
    expect(sessionCalls).toEqual([]);

    // Kabul: consent_given olayı, ardından deneme oturumu.
    await startAssistant(page);
    expect(sessionCalls).toEqual(["POST"]);
    expect(events).toContainEqual({ type: "consent_given" });
    await expect(fab(page)).toHaveAttribute("aria-pressed", "true");

    // Kapatıp yeniden başlatınca izin yeniden sorulmaz.
    await panel(page).getByRole("button", { name: "Asistanı kapat" }).click();
    await expect(panel(page)).toHaveCount(0);
    await fab(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(consentDialog(page)).toBeHidden();
    expect(events.filter((e) => e.type === "consent_given")).toHaveLength(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("yazılı komut: \"kampanyaları göster\" okuma aracını çalıştırır, yanıt panelde; kişisel veri sızmaz", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, ownerToken);
    const events = collectEvents(page);
    await startAssistant(page);

    const campaignsCall = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/campaigns" && r.request().method() === "GET",
    );
    const reply = await say(page, "kampanyaları göster");
    expect((await campaignsCall).ok()).toBe(true);
    await expect(reply).toContainText("2 kampanya var");
    await expect.poll(() => events.some((e) => e.tool === "list_campaigns" && e.outcome === "ok" && e.risk === "R0")).toBe(true);

    const leadReply = await say(page, "lead durumu");
    await expect(leadReply).toContainText("1 lead var");
    await expect.poll(() => events.some((e) => e.tool === "get_lead_stats" && e.outcome === "ok")).toBe(true);

    // Ne panelde ne denetim olaylarında kayıt kimliği ya da lead kişisel verisi var.
    const text = (await panel(page).innerText()) + JSON.stringify(events);
    for (const secret of ["Anna", "Schmidt", "@example.invalid", "+491701234567", ...campaignIds]) {
      expect(text, `asistan çıktısında "${secret}" görünmemeli`).not.toContain(secret);
    }
    // Olaylar yalnızca kayıttaki alanları taşır; konuşma metni gönderilmez.
    for (const e of events) {
      expect(Object.keys(e).every((k) => ["type", "tool", "risk", "outcome", "entityRef", "conversationId"].includes(k))).toBe(true);
    }
    expect(errors).toEqual([]);
    await context.close();
  });

  test("gezinme: \"onaylara git\" /approvals'ı açar, oturum sayfa değişiminde sürer", async ({ browser, baseURL, request }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, ownerToken, "/campaigns");
    await startAssistant(page);
    const reply = await say(page, "onaylara git");
    await expect(page).toHaveURL((url) => url.pathname === "/approvals");
    await expect(reply).toContainText("Onaylar sayfası açıldı");
    await expect(panel(page)).toBeVisible();
    await expect(page.getByLabel(INPUT_LABEL)).toBeEnabled();
    // Oturum yeni sayfada da çalışır.
    await expect(await say(page, "kampanyaları göster")).toContainText("2 kampanya var");
    expect(errors).toEqual([]);
    await context.close();
  });

  test("izleyici (VIEWER): yalnızca izinli araçlar; menüsünde olmayan sayfa ve yetkisiz araç reddedilir", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, viewerToken);
    const events = collectEvents(page);
    const alertCalls: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/alerts")) alertCalls.push(r.url());
    });
    await startAssistant(page);

    await expect(await say(page, "onaylara git")).toContainText("Bu sayfaya erişiminiz yok.");
    await expect(page).toHaveURL((url) => url.pathname === "/");

    // list_alerts izleyiciye hiç bağlanmaz: uç çağrılmaz, olay yazılmaz.
    await expect(await say(page, "uyarıları göster")).toContainText("Bu işlem için yetkiniz yok.");
    await expect(await say(page, "lead durumu")).toContainText("Bu işlem için yetkiniz yok.");
    expect(alertCalls).toEqual([]);

    // İzinli okuma aracı çalışır.
    await expect(await say(page, "kampanyaları göster")).toContainText("2 kampanya var");
    await expect.poll(() => events.some((e) => e.tool === "list_campaigns" && e.outcome === "ok")).toBe(true);

    const tools = new Set(events.filter((e) => e.type === "tool_call").map((e) => e.tool));
    for (const forbidden of ["list_alerts", "get_lead_stats", "open_approvals", "get_subscription", "open_lead"]) {
      expect(tools.has(forbidden), `izleyici ${forbidden} çalıştırmamalı`).toBe(false);
    }
    // navigate_to izleyiciye açıktır ama menü dışı sayfa reddedilir (denied).
    expect(events).toContainEqual(expect.objectContaining({ tool: "navigate_to", outcome: "denied" }));
    expect(errors).toEqual([]);
    await context.close();
  });

  test("Esc oturumu kapatır, odak düğmeye döner; canlı bölge durumları duyurur", async ({ browser, baseURL, request }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, ownerToken);
    await startAssistant(page);
    await say(page, "kampanyaları göster");
    await expect(page.getByLabel(INPUT_LABEL)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(fab(page)).toHaveAttribute("aria-pressed", "false");
    await expect(fab(page)).toBeFocused();
    await expect(page.locator(LIVE_SELECTOR)).toHaveText("Sesli asistan kapandı.");
    await expect(page.locator(ALERT_SELECTOR)).toHaveText("");

    const history = await liveHistory(page);
    for (const expected of ["Bağlanıyor…", "Dinliyorum…", "Düşünüyor…", "Sesli asistan kapandı."]) {
      expect(history, `canlı bölge "${expected}" duyurmalı; geçmiş: ${history.join(" | ")}`).toContain(expected);
    }
    expect(
      history.some((h) => h.includes("2 kampanya var")),
      `canlı bölge ajan yanıtını duyurmalı; geçmiş: ${history.join(" | ")}`,
    ).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("klavye kısayolu: Ctrl+Shift+Boşluk açar ve kapatır", async ({ browser, baseURL, request }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, ownerToken);
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press("Control+Shift+Space");
    await expect(consentDialog(page)).toBeVisible();
    await consentDialog(page).getByRole("button", { name: "Kabul ediyorum, başlat" }).click();
    await expect(page.getByLabel(INPUT_LABEL)).toBeEnabled({ timeout: 15_000 });
    await expect(fab(page)).toHaveAttribute("aria-pressed", "true");
    // Metin kutusundayken de çalışır.
    await expect(page.getByLabel(INPUT_LABEL)).toBeFocused();
    await page.keyboard.press("Control+Shift+Space");
    await expect(panel(page)).toHaveCount(0);
    await expect(fab(page)).toHaveAttribute("aria-pressed", "false");
    // İzin hatırlanır: kısayol doğrudan bağlanır.
    await page.keyboard.press("Control+Shift+Space");
    await expect(page.getByLabel(INPUT_LABEL)).toBeEnabled({ timeout: 15_000 });
    await expect(consentDialog(page)).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  });
});
