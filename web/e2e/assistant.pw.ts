import { test, expect, type APIRequestContext, type Browser, type Page, type Request } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { formatMoney } from "../app/_lib/format";
import { CLIENT_END_GRACE_SECONDS, SESSION_END_GRACE_SECONDS, sessionMinutesLabel } from "../app/_lib/assistant/limits";

/**
 * Sesli komut asistanı uçtan uca (ADR-0028 · Faz 2–5: R0 okuma/gezinme, R1 sözlü/kart onayı, R2/R3 yalnızca ekrandaki
 * modal onay penceresi, Faz 5 oturum süre sınırı, kuruluş günlük oturum sınırı ve A/B testi araçları). Deneme modunda çalışır: oturum ucu `mock: true`
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
/** Kibar canlı bölgelerin hepsi: durum (role=status) ve ajan yanıtı/onay kartı duyuruları (ayrı bölge). */
const LIVE_HISTORY_SELECTOR = ".va-root [aria-live=polite]";
const ALERT_SELECTOR = ".va-root [role=alert]";
const FAB_NAME = /sesli asistan:/;
const INPUT_LABEL = "Asistana yazın";
const CONSENT_TITLE = "Sesli asistan hakkında";
const MOCK_NOTICE = "Deneme modu: asistan yazılı komutlarla çalışır";
const CONFIRM_CARD_TITLE = "Onayınız bekleniyor";
const CONFIRM_QUESTION = "Onaylıyor musunuz?";
const FORBIDDEN = "Bu işlem için yetkiniz yok.";
const SCREEN_CONFIRM = "Lütfen ekrandaki onay penceresinden onaylayın; bu işlem sesle onaylanamaz.";
const SCREEN_DIALOG_TITLE = "Lead aşamasını değiştir";
const PAUSE_DIALOG_TITLE = "Kampanyayı duraklat";
const BUDGET_UP_DIALOG_TITLE = "Günlük bütçeyi artır";
const SPEND_WARNING = "Bu işlem reklam harcamasını başlatır ya da artırır.";
/** Sesli "evet" R2/R3'ü onaylamaz (pending.ts `not_confirmable`). */
const NOT_CONFIRMABLE = "Bu işlem sesle onaylanamaz";
/** Faz 5: kuruluşun günlük oturum sınırı (429) için istemcinin gösterdiği metin (i18n `assistant.error.dailyCap`). */
const DAILY_CAP_TEXT = "Kuruluşunuzun bugünkü sesli asistan oturum sınırı doldu. Yarın yeniden deneyin ya da yöneticinize başvurun.";
const SESSION_REMAINING = /Oturumun bitmesine \d+ saniye kaldı\./;

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

/** Kibar canlı bölgelerin (durum + ileti) tüm metin geçmişi: React metni hızla değiştirse de her ara değer kaydedilir. */
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
  }, LIVE_HISTORY_SELECTOR);
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

/** Yazma istekleri (GET dışı) — `pathPrefix` altındaki her istek "PATCH /api/alerts/…" biçiminde kaydedilir. */
function collectWrites(page: Page, pathPrefix: string): string[] {
  const writes: string[] = [];
  page.on("request", (req: Request) => {
    const { pathname } = new URL(req.url());
    if (req.method() !== "GET" && req.method() !== "HEAD" && pathname.startsWith(pathPrefix)) writes.push(`${req.method()} ${pathname}`);
  });
  return writes;
}

/** Yazma isteği ve JSON gövdesi (gövdesi okunamayan istekte `null`). */
interface WriteRequest {
  method: string;
  path: string;
  body: unknown;
}

/** `collectWrites` gibi, ama gövdeyle: R2/R3'te tek ve doğru isteğin gittiği (ör. `{action: "PAUSE"}`) denetlenir. */
function collectWriteRequests(page: Page, pathPrefix: string): WriteRequest[] {
  const writes: WriteRequest[] = [];
  page.on("request", (req: Request) => {
    const { pathname } = new URL(req.url());
    if (req.method() === "GET" || req.method() === "HEAD" || !pathname.startsWith(pathPrefix)) return;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    writes.push({ method: req.method(), path: pathname, body });
  });
  return writes;
}

/** R2/R3 eylemi için ekrandaki modal onay penceresi (sayfanın üst katmanında; panelin içinde değil). */
function screenDialog(page: Page, title: string = SCREEN_DIALOG_TITLE) {
  return page.getByRole("dialog", { name: title });
}

/** Bekleyen R1 eyleminin onay kartı (ADR-0028 §2, Faz 3). */
function confirmCard(page: Page) {
  return panel(page).getByRole("group", { name: CONFIRM_CARD_TITLE });
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

/**
 * Modal onay penceresi açıkken sayfanın geri kalanı (panelin metin kutusu dahil) inert'tir: klavye ve fare ulaşamaz.
 * Sesli kipte ise kullanıcının sözü pencereden bağımsız olarak ajana gider. Bunu taklit etmek için metin kutusunun
 * değeri ve formun gönderimi programatik yapılır (aynı `onSend` → bağdaştırıcı yolu); tıklama ya da odak çalınmaz.
 */
async function sayBehindModal(page: Page, text: string) {
  const agentLines = panel(page).locator('.va-line[data-role="agent"]');
  const before = await agentLines.count();
  await page.evaluate((value) => {
    const input = document.querySelector<HTMLInputElement>(".va-panel__form input");
    if (!input) throw new Error("asistan metin kutusu yok");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await expect(page.locator(".va-panel__form input")).toHaveValue(text);
  await page.evaluate(() => document.querySelector<HTMLFormElement>(".va-panel__form")!.requestSubmit());
  await expect(panel(page).locator('.va-line[data-role="user"]').last()).toContainText(text);
  await expect(agentLines).toHaveCount(before + 1, { timeout: 15_000 });
  return agentLines.last();
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
  let workspaceId = "";
  let alertIds: string[] = [];
  // Faz 4 (R2/R3) fikstürü: ayrı kuruluş ve çalışma alanı, tek kampanya (ilk listede hep "c1"). Diğer testlerin
  // kampanya sayımı bozulmasın diye ana çalışma alanından ayrıdır. Sahip aynı kullanıcıdır (ikinci oturum çerezi);
  // MEDIA_BUYER'a harcama yetkisi verilmez (canApproveSpend varsayılan false).
  const spendOwnerToken = randomBytes(32).toString("hex");
  const buyerToken = randomBytes(32).toString("hex");
  let buyerId = "";
  let spendOrgId = "";
  let spendCampaignId = "";
  const SPEND_CAMPAIGN_NAME = "Polonya — Diş implantı";
  const SPEND_CURRENCY = "USD";
  const SPEND_DAILY_CENTS = 5000;
  // Faz 5 günlük oturum sınırı fikstürü: ayrı kullanıcı ve kuruluş. Sınır sayacı (`voice-org:<orgId>`) testte
  // doldurulur; diğer kuruluşların ve kullanıcının saatlik sınırı etkilenmez.
  const capOwnerToken = randomBytes(32).toString("hex");
  let capOwnerId = "";
  let capOrgId = "";

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
    workspaceId = org.workspaces[0].id;
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
    // R1 (Faz 3) uyarı senaryoları: biri onayla çözülür, diğeri süre dolumu testinde açık kalır.
    const alerts = await Promise.all(
      ["ROAS düştü", "Harcama sıçradı"].map((title) =>
        prisma.alert.create({ data: { workspaceId, type: "ROAS_DROP", severity: "WARNING", title, message: "Fikstür uyarısı" } }),
      ),
    );
    alertIds = alerts.map((a) => a.id);
    const expiresAt = new Date(Date.now() + 3600_000);
    await prisma.webSession.createMany({
      data: [
        { tokenHash: tokenHash(ownerToken), userId: ownerId, workspaceId, expiresAt },
        { tokenHash: tokenHash(viewerToken), userId: viewerId, workspaceId, expiresAt },
      ],
    });

    const buyer = await prisma.user.create({ data: { email: `va-buyer-${suffix}@example.invalid`, name: "Asistan Medya Alıcısı" } });
    buyerId = buyer.id;
    const spendOrg = await prisma.organization.create({
      data: {
        name: "Asistan harcama fikstürü",
        slug: `va-spend-${suffix}`,
        members: { create: [{ userId: ownerId, role: "OWNER" }, { userId: buyerId, role: "MEDIA_BUYER" }] },
        workspaces: { create: { name: "Asistan harcama", slug: "main" } },
      },
      include: { workspaces: true },
    });
    spendOrgId = spendOrg.id;
    const spendWorkspaceId = spendOrg.workspaces[0].id;
    // META_MOCK_MODE=true: bağlantı CONNECTED olmalı; Meta çağrıları sahte istemciye gider.
    const conn = await prisma.metaConnection.create({ data: { orgId: spendOrgId, type: "BUSINESS_MANAGER", status: "CONNECTED" } });
    const spendAccount = await prisma.adAccount.create({
      data: { orgId: spendOrgId, workspaceId: spendWorkspaceId, connectionId: conn.id, name: "Harcama hesabı", currency: SPEND_CURRENCY },
    });
    const spendCampaign = await prisma.campaign.create({
      data: {
        adAccountId: spendAccount.id,
        workspaceId: spendWorkspaceId,
        name: SPEND_CAMPAIGN_NAME,
        dailyBudget: SPEND_DAILY_CENTS,
        status: "ACTIVE",
        workflowStatus: "ACTIVE",
        metaCampaignId: `mock-va-${suffix}`,
      },
    });
    spendCampaignId = spendCampaign.id;
    await prisma.webSession.createMany({
      data: [
        { tokenHash: tokenHash(spendOwnerToken), userId: ownerId, workspaceId: spendWorkspaceId, expiresAt },
        { tokenHash: tokenHash(buyerToken), userId: buyerId, workspaceId: spendWorkspaceId, expiresAt },
      ],
    });

    const capOwner = await prisma.user.create({ data: { email: `va-cap-${suffix}@example.invalid`, name: "Asistan Sınır Sahibi" } });
    capOwnerId = capOwner.id;
    const capOrg = await prisma.organization.create({
      data: {
        name: "Asistan sınır fikstürü",
        slug: `va-cap-${suffix}`,
        members: { create: [{ userId: capOwnerId, role: "OWNER" }] },
        workspaces: { create: { name: "Asistan sınır", slug: "main" } },
      },
      include: { workspaces: true },
    });
    capOrgId = capOrg.id;
    await prisma.webSession.create({
      data: { tokenHash: tokenHash(capOwnerToken), userId: capOwnerId, workspaceId: capOrg.workspaces[0].id, expiresAt },
    });
  });

  /** Her Faz 4 testi kampanyayı aynı başlangıç durumuna getirir (yayında, günlük 50 USD); testler birbirine bağlı değil. */
  async function resetSpendCampaign() {
    await prisma.campaign.update({
      where: { id: spendCampaignId },
      data: { status: "ACTIVE", workflowStatus: "ACTIVE", dailyBudget: SPEND_DAILY_CENTS },
    });
  }

  test.afterAll(async () => {
    if (orgId) await prisma.organization.delete({ where: { id: orgId } });
    if (spendOrgId) await prisma.organization.delete({ where: { id: spendOrgId } });
    if (capOrgId) await prisma.organization.delete({ where: { id: capOrgId } });
    // Kuruluş günlük oturum sayaçları (Faz 5) kuruluşla birlikte silinmez.
    for (const id of [orgId, spendOrgId, capOrgId].filter(Boolean))
      await prisma.requestQuota.deleteMany({ where: { key: { startsWith: `voice-org:${id}:` } } });
    for (const id of [ownerId, viewerId, buyerId, capOwnerId].filter(Boolean)) {
      await prisma.requestQuota.deleteMany({
        where: { OR: [{ key: { startsWith: `voice:${id}:` } }, { key: { startsWith: `voice-event:${id}:` } }] },
      });
      await prisma.user.delete({ where: { id } });
    }
    await prisma.$disconnect();
  });

  async function open(
    browser: Browser,
    baseURL: string | undefined,
    token: string | null,
    path = "/",
    options: { clock?: boolean } = {},
  ) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    if (token) await context.addCookies([{ name: SESSION_COOKIE, value: token, url: baseURL ?? "http://localhost:3000" }]);
    const page = await context.newPage();
    // Sahte saat sayfa yüklenmeden kurulur (zamanlayıcılar baştan sahte olsun); kurulduktan sonra zaman doğal akar.
    if (options.clock) await page.clock.install();
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

  // ---------------------------------------------------------------- Faz 3: iç yazma (R1), sözlü ya da ekran onayı

  test("R1 uyarı: \"uyarıyı kapat\" onay kartı açar, istek gitmez; \"hayır\" iptal eder, \"evet\" tek PATCH gönderir", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, ownerToken);
    const events = collectEvents(page);
    const writes = collectWrites(page, "/api/alerts");
    await startAssistant(page);

    // Ref yalnızca önceki araç sonucundan gelir: önce uyarılar listelenir (a1, a2 …).
    await expect(await say(page, "uyarıları göster")).toContainText(/\d+ uyarı var/);

    // 1) Bekleyen eylem: özet + soru, kart görünür; onaylanana kadar hiçbir yazma isteği yok.
    await expect(await say(page, "uyarıyı kapat")).toContainText(CONFIRM_QUESTION);
    await expect(confirmCard(page)).toBeVisible();
    await expect(confirmCard(page)).toContainText("a1");
    await expect(confirmCard(page).getByRole("button", { name: "Onayla" })).toBeVisible();
    await expect(confirmCard(page).getByRole("button", { name: "Vazgeç" })).toBeVisible();
    // Bekleyen eylemin oluşması denetime yazılmaz.
    expect(events.some((e) => e.tool === "update_alert")).toBe(false);
    expect(writes).toEqual([]);

    // 2) "hayır": istek yok, kart kapanır, R1 aracı `cancelled` olarak kaydedilir.
    await expect(await say(page, "hayır")).toContainText("İşlem iptal edildi");
    await expect(confirmCard(page)).toHaveCount(0);
    await expect
      .poll(() => events.some((e) => e.tool === "update_alert" && e.risk === "R1" && e.outcome === "cancelled"))
      .toBe(true);
    expect(writes).toEqual([]);

    // 3) Yeniden iste, "evet": tam olarak bir PATCH, kart kapanır, `ok` kaydı.
    await expect(await say(page, "uyarıyı kapat")).toContainText(CONFIRM_QUESTION);
    await expect(confirmCard(page)).toBeVisible();
    expect(writes).toEqual([]);
    const patched = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname.startsWith("/api/alerts/"),
    );
    await expect(await say(page, "evet")).toContainText("İşlem tamamlandı.");
    expect((await patched).ok()).toBe(true);
    await expect(confirmCard(page)).toHaveCount(0);
    await expect.poll(() => events.some((e) => e.tool === "update_alert" && e.risk === "R1" && e.outcome === "ok")).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^PATCH \/api\/alerts\/[^/]+$/);
    expect(await prisma.alert.count({ where: { id: { in: alertIds }, status: "RESOLVED" } })).toBe(1);

    // Aynı onay ikinci kez kullanılamaz: yeni "evet" bekleyen eylem bulamaz, istek gitmez.
    await expect(await say(page, "evet")).not.toContainText("İşlem tamamlandı.");
    expect(writes).toHaveLength(1);

    // Kayıt kimlikleri panelde görünmez; olaylar yalnızca kayıttaki alanları taşır.
    const panelText = await panel(page).innerText();
    for (const id of alertIds) expect(panelText).not.toContain(id);
    for (const e of events) {
      expect(Object.keys(e).every((k) => ["type", "tool", "risk", "outcome", "entityRef", "conversationId"].includes(k))).toBe(true);
    }
    expect(errors).toEqual([]);
    await context.close();
  });

  test("R1 süre dolumu: onaylanmayan eylem süresi dolunca istek göndermez ve iptal olarak kaydedilir", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, ownerToken, "/", { clock: true });
    const events = collectEvents(page);
    const writes = collectWrites(page, "/api/alerts");
    await startAssistant(page);

    await expect(await say(page, "uyarıları göster")).toContainText(/\d+ uyarı var/);
    await expect(await say(page, "uyarıyı kapat")).toContainText(CONFIRM_QUESTION);
    await expect(confirmCard(page)).toBeVisible();

    // Onay süresi (60 sn) sahte saatle atlanır.
    await page.clock.fastForward("01:05");
    await expect(confirmCard(page)).toHaveCount(0);
    await expect
      .poll(() => events.some((e) => e.tool === "update_alert" && e.risk === "R1" && e.outcome === "cancelled"))
      .toBe(true);
    await expect
      .poll(async () => (await liveHistory(page)).some((h) => h.includes("Onay süresi doldu; işlem yapılmadı.")))
      .toBe(true);
    expect(writes).toEqual([]);

    // Süresi dolmuş eylem sonradan "evet" ile de çalışmaz.
    await expect(await say(page, "evet")).not.toContainText("İşlem tamamlandı.");
    expect(events.some((e) => e.tool === "update_alert" && e.outcome === "ok")).toBe(false);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("R2 lead: /leads/[id] sayfasında \"bu lead'i kazanıldı yap\" yalnızca ekrandaki pencereden onaylanır; tek PATCH, kişisel veri sızmaz", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    // Bu teste özel lead: "kazanıldı" (TREATED) yalnızca TRAVEL_PLANNED'dan geçilebilir. Diğer testlerin lead sayımı
    // bozulmasın diye sonunda silinir. Aşama değişikliği Meta'ya dönüşüm bildirebildiği için araç R2'dir (ADR-0028 Faz 4).
    const pii = { firstName: "Lotte", lastName: "Visser", email: `lotte-${suffix}@example.invalid`, phone: "+31612345678" };
    const lead = await prisma.lead.create({
      data: { workspaceId, organizationId: orgId, ...pii, channel: "WHATSAPP", language: "nl", country: "NL", status: "TRAVEL_PLANNED" },
    });
    try {
      const { context, page, errors } = await open(browser, baseURL, ownerToken, `/leads/${lead.id}`);
      const events = collectEvents(page);
      const writes = collectWrites(page, "/api/leads");
      const leadPatches = () => writes.filter((w) => w === `PATCH /api/leads/${lead.id}`);
      await startAssistant(page);

      // 1) Lead ref'i açık sayfadan (get_current_context) gelir; kimlik ajana gitmez. Kart değil modal pencere açılır:
      //    odak "Vazgeç"te, "Onayla" ilk saniye etkin değil. Esc iptal eder; istek gitmez.
      await expect(await say(page, "bu lead'i kazanıldı yap")).toContainText(SCREEN_CONFIRM);
      await expect(screenDialog(page)).toBeVisible();
      await expect(confirmCard(page)).toHaveCount(0);
      await expect(screenDialog(page).getByRole("button", { name: "Vazgeç" })).toBeFocused();
      await expect(screenDialog(page).getByRole("button", { name: "Onayla" })).toHaveAttribute("aria-disabled", "true");
      // Risk rozeti yalnızca renkle değil metinle: R2 = dış etki, harcama yok.
      await expect(screenDialog(page)).toContainText("Risk:");
      await expect(screenDialog(page)).toContainText("Dış etki");
      expect(leadPatches()).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(screenDialog(page)).toHaveCount(0);
      await expect
        .poll(() => events.some((e) => e.tool === "update_lead_status" && e.risk === "R2" && e.outcome === "cancelled"))
        .toBe(true);
      expect(leadPatches()).toEqual([]);

      // 2) Yeniden iste; "Onayla" etkinleşince gerçek tıklama: tam olarak bir PATCH.
      await expect(await say(page, "bu lead'i kazanıldı yap")).toContainText(SCREEN_CONFIRM);
      const confirm = screenDialog(page).getByRole("button", { name: "Onayla" });
      await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
      const dialogText = await screenDialog(page).innerText();
      const patched = page.waitForResponse(
        (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/leads/${lead.id}`,
      );
      await confirm.click();
      expect((await patched).ok()).toBe(true);
      await expect(screenDialog(page)).toHaveCount(0);
      await expect
        .poll(() => events.some((e) => e.tool === "update_lead_status" && e.risk === "R2" && e.outcome === "ok"))
        .toBe(true);
      expect(leadPatches()).toHaveLength(1);
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("TREATED");

      // Sayfanın kendisi lead'i gösterir; panel, pencere, canlı bölgeler ve denetim olayları ise kişisel veri taşımaz.
      const text =
        dialogText + (await panel(page).innerText()) + JSON.stringify(events) + (await liveHistory(page)).join("\n");
      for (const secret of [pii.firstName, pii.lastName, pii.email, pii.phone, "@example.invalid"]) {
        expect(text, `asistan çıktısında "${secret}" görünmemeli`).not.toContain(secret);
      }
      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await prisma.lead.delete({ where: { id: lead.id } }).catch(() => undefined);
    }
  });

  test("izleyici (VIEWER): R1 araçları bağlanmaz; \"yetkiniz yok\", onay kartı ve yazma isteği yok", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    const { context, page, errors } = await open(browser, baseURL, viewerToken);
    const events = collectEvents(page);
    // R1 araçlarının yazdığı uçlara giden her yazma isteği.
    const writes = collectWrites(page, "/api/");
    const appWrites = () => writes.filter((w) => / \/api\/(alerts|leads|campaigns|studio|recommendations)\b/.test(w));
    await startAssistant(page);

    for (const command of ["uyarıyı kapat", "bu lead'i kazanıldı yap", "kampanyayı onaya gönder", "taslağı kaydet"]) {
      await expect(await say(page, command), command).toContainText(FORBIDDEN);
      await expect(confirmCard(page)).toHaveCount(0);
      await expect(page.getByRole("dialog"), command).toHaveCount(0);
    }
    // Bekleyen eylem olmadığından "evet" hiçbir şeyi onaylamaz.
    await expect(await say(page, "evet")).toContainText("Onay bekleyen bir işlem yok.");

    expect(appWrites()).toEqual([]);
    expect(events.filter((e) => e.risk === "R1" || e.risk === "R2" || e.risk === "R3")).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });

  // ---------------------------------------------------------------- Faz 4: dış etki (R2) ve harcama (R3), yalnızca ekran onayı

  test("R2 duraklat: modal pencere açılır (odak Vazgeç'te), istek gitmez; sesli \"evet\" ve Vazgeç çalıştırmaz, Onayla tek POST PAUSE", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    await resetSpendCampaign();
    const { context, page, errors } = await open(browser, baseURL, spendOwnerToken);
    const events = collectEvents(page);
    const writes = collectWriteRequests(page, "/api/campaigns");
    const publishPath = `/api/campaigns/${spendCampaignId}/publish`;
    const dialog = screenDialog(page, PAUSE_DIALOG_TITLE);
    await startAssistant(page);

    // Ref yalnızca önceki araç sonucundan gelir: kampanya listelenir (tek kampanya → c1).
    await expect(await say(page, "kampanyaları göster")).toContainText("1 kampanya var");

    // 1) Bekleyen eylem: kart değil modal pencere; kampanya adı görünür. Odak "Vazgeç"te, "Onayla" ilk saniye etkin
    //    değil. Hiçbir yazma isteği yok.
    await expect(await say(page, "ilk kampanyayı duraklat")).toContainText(SCREEN_CONFIRM);
    await expect(dialog).toBeVisible();
    await expect(confirmCard(page)).toHaveCount(0);
    await expect(dialog).toContainText(SPEND_CAMPAIGN_NAME);
    await expect(dialog).toContainText("Dış etki");
    await expect(dialog.getByRole("button", { name: "Vazgeç" })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Onayla" })).toHaveAttribute("aria-disabled", "true");
    expect(writes).toEqual([]);
    expect(events.some((e) => e.tool === "pause_campaign" && e.outcome === "ok")).toBe(false);

    // 2) Sesli "evet" (pencere açıkken gelen tur) R2'yi onaylamaz: `not_confirmable`, istek yok, pencere açık kalır.
    await expect(await sayBehindModal(page, "evet")).toContainText(NOT_CONFIRMABLE);
    await expect(dialog).toBeVisible();
    await expect.poll(() => events.some((e) => e.tool === "confirm_pending_action" && e.outcome === "denied")).toBe(true);
    expect(writes).toEqual([]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: spendCampaignId } })).workflowStatus).toBe("ACTIVE");

    // 3) Vazgeç: pencere kapanır, istek yok, eylem `cancelled` olarak kaydedilir.
    await dialog.getByRole("button", { name: "Vazgeç" }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => events.some((e) => e.tool === "pause_campaign" && e.risk === "R2" && e.outcome === "cancelled"))
      .toBe(true);
    expect(writes).toEqual([]);

    // 4) Yeniden iste; "Onayla" etkinleşince gerçek tıklama: tam olarak bir POST publish {action: "PAUSE"}.
    await expect(await say(page, "ilk kampanyayı duraklat")).toContainText(SCREEN_CONFIRM);
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Onayla" });
    await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
    const published = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === publishPath);
    await confirm.click();
    expect((await published).ok()).toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => events.some((e) => e.tool === "pause_campaign" && e.risk === "R2" && e.outcome === "ok")).toBe(true);
    expect(writes).toEqual([{ method: "POST", path: publishPath, body: { action: "PAUSE" } }]);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: spendCampaignId } })).toMatchObject({
      workflowStatus: "PUBLISHED_PAUSED",
      status: "PAUSED",
    });

    // Kayıt kimliği panelde görünmez; olaylar yalnızca kayıttaki alanları taşır.
    expect(await panel(page).innerText()).not.toContain(spendCampaignId);
    for (const e of events) {
      expect(Object.keys(e).every((k) => ["type", "tool", "risk", "outcome", "entityRef", "conversationId"].includes(k))).toBe(true);
    }
    expect(errors).toEqual([]);
    await context.close();
  });

  test("R3 bütçe artışı (Owner): pencere eski → yeni tutarı para birimiyle ve harcama uyarısıyla gösterir; tıklamayla tek PATCH", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    await resetSpendCampaign();
    const { context, page, errors } = await open(browser, baseURL, spendOwnerToken);
    const events = collectEvents(page);
    const writes = collectWriteRequests(page, "/api/campaigns");
    const budgetPath = `/api/campaigns/${spendCampaignId}/budget`;
    const dialog = screenDialog(page, BUDGET_UP_DIALOG_TITLE);
    const newCents = 8000;
    await startAssistant(page);

    await expect(await say(page, "kampanyaları göster")).toContainText("1 kampanya var");
    // "yap" yön söylemez: senaryolu ajan önce azaltmayı dener, araç "bu bir artıştır" deyince increase_budget'a geçer.
    await expect(await say(page, `bütçeyi ${newCents / 100} yap`)).toContainText(SCREEN_CONFIRM);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Vazgeç" })).toBeFocused();
    const confirm = dialog.getByRole("button", { name: "Harcamayı onayla" });
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(writes).toEqual([]);

    // İçerik: kampanya adı, risk "Harcama", günlük ve aylık bütçe eski → yeni (hesabın para birimiyle), uyarı.
    await expect(dialog).toContainText(SPEND_CAMPAIGN_NAME);
    await expect(dialog.locator(".va-screen__risk")).toContainText("Harcama");
    const daily = dialog.locator(".va-screen__row", { hasText: "Günlük bütçe" });
    await expect(daily).toContainText(formatMoney(SPEND_DAILY_CENTS, SPEND_CURRENCY));
    await expect(daily).toContainText(formatMoney(newCents, SPEND_CURRENCY));
    await expect(daily).toContainText("Şu an:");
    await expect(daily).toContainText("Yeni:");
    await expect(daily).toContainText("$");
    const monthly = dialog.locator(".va-screen__row", { hasText: "Aylık tahmin" });
    await expect(monthly).toContainText(formatMoney(SPEND_DAILY_CENTS * 30, SPEND_CURRENCY));
    await expect(monthly).toContainText(formatMoney(newCents * 30, SPEND_CURRENCY));
    await expect(dialog).toContainText("Uyarı:");
    await expect(dialog).toContainText(SPEND_WARNING);

    // Etkinleşince gerçek tıklama: tam olarak bir PATCH, gövde ana birimle.
    await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
    const patched = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === budgetPath);
    await confirm.click();
    expect((await patched).ok()).toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => events.some((e) => e.tool === "increase_budget" && e.risk === "R3" && e.outcome === "ok")).toBe(true);
    expect(writes).toEqual([{ method: "PATCH", path: budgetPath, body: { dailyBudget: newCents / 100 } }]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: spendCampaignId } })).dailyBudget).toBe(newCents);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("MEDIA_BUYER (harcama yetkisi yok): R3 komutları \"yetkiniz yok\", pencere ve istek yok; R2 duraklatma penceresi açılır", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    await resetSpendCampaign();
    const { context, page, errors } = await open(browser, baseURL, buyerToken);
    const events = collectEvents(page);
    const writes = collectWrites(page, "/api/");
    const appWrites = () => writes.filter((w) => / \/api\/(campaigns|recommendations|meta)\b/.test(w));
    await startAssistant(page);

    await expect(await say(page, "kampanyaları göster")).toContainText("1 kampanya var");
    // R3 araçları (etkinleştir, bütçe artır, öneri uygula) bu kullanıcıya hiç bağlanmaz: istemci ön süzgeci.
    // Sunucu yine de reddeder (bkz. tests/assistant-spend.integration.test.ts); asistan yetki sınırı değildir.
    for (const command of ["ilk kampanyayı aktifleştir", "bütçeyi 80 artır", "ilk öneriyi uygula"]) {
      await expect(await say(page, command), command).toContainText(FORBIDDEN);
      await expect(page.getByRole("dialog"), command).toHaveCount(0);
      await expect(confirmCard(page)).toHaveCount(0);
    }
    expect(appWrites()).toEqual([]);
    expect(events.filter((e) => e.risk === "R3")).toEqual([]);

    // R2 (düzenleme rolü yeterli) açıktır: duraklatma penceresi açılır; Vazgeç ile istek gitmez.
    await expect(await say(page, "ilk kampanyayı duraklat")).toContainText(SCREEN_CONFIRM);
    const dialog = screenDialog(page, PAUSE_DIALOG_TITLE);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Vazgeç" }).click();
    await expect(dialog).toHaveCount(0);
    expect(appWrites()).toEqual([]);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: spendCampaignId } })).toMatchObject({
      workflowStatus: "ACTIVE",
      dailyBudget: SPEND_DAILY_CENTS,
    });
    expect(errors).toEqual([]);
    await context.close();
  });

  // ---------------------------------------------------------------- Faz 5: oturum ve maliyet sınırları, A/B testi araçları

  test("süre sınırı: oturum en uzun sürede kendiliğinden kapanır; son saniyeler gösterilir, süre bir kez bildirilir", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    // Sunucu sınırı (`VOICE_ASSISTANT_MAX_SESSION_SECONDS`, en az 60 sn) oturum yanıtından okunur; süre sahte saatle atlanır.
    const { context, page, errors } = await open(browser, baseURL, ownerToken, "/", { clock: true });
    const events = collectEvents(page);
    const sessionResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/assistant/session" && r.request().method() === "POST",
    );
    await startAssistant(page);
    const session = (await (await sessionResponse).json()) as { maxSessionSeconds?: unknown; sessionRef?: unknown };
    expect(typeof session.maxSessionSeconds, "oturum yanıtında maxSessionSeconds yok").toBe("number");
    const max = session.maxSessionSeconds as number;
    expect(max).toBeGreaterThanOrEqual(60);
    await expect(await say(page, "kampanyaları göster")).toContainText("2 kampanya var");
    const remaining = page.getByTestId("va-session-remaining");
    await expect(remaining).toHaveCount(0);

    // Son 30 saniye: kalan süre panelde görünür ve duyurulur; oturum açık kalır, henüz süre bildirilmez.
    await page.clock.fastForward((max - 25) * 1000);
    await expect(remaining).toBeVisible();
    await expect(remaining).toHaveText(SESSION_REMAINING);
    await expect.poll(async () => (await liveHistory(page)).some((h) => SESSION_REMAINING.test(h))).toBe(true);
    await expect(panel(page)).toBeVisible();
    expect(events.filter((e) => e.type === "session_ended")).toEqual([]);

    const endedRows = () => prisma.auditLog.count({ where: { orgId, action: "VOICE_SESSION_ENDED" } });
    const endedBefore = await endedRows();

    // Sınır + istemci payı: senaryolu ajan kapatmaz, tarayıcı oturumu kibarca kapatır ve süre sınırını duyurur.
    await page.clock.fastForward((25 + CLIENT_END_GRACE_SECONDS + 1) * 1000);
    await expect(panel(page)).toHaveCount(0);
    await expect(fab(page)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(LIVE_SELECTOR)).toHaveText(
      `Oturum süre sınırına (${sessionMinutesLabel(max, "tr")} dakika) ulaştı ve kapandı. Devam etmek için asistanı yeniden başlatabilirsiniz.`,
    );
    // Oturum sonu tam olarak bir kez, yalnızca süreyle (konuşma metni yok) bildirilir ve denetime yazılır.
    await expect.poll(() => events.filter((e) => e.type === "session_ended").length).toBe(1);
    const ended = events.find((e) => e.type === "session_ended")!;
    expect(Object.keys(ended).every((k) => ["type", "sessionRef", "durationSeconds", "conversationId"].includes(k))).toBe(true);
    expect(ended.sessionRef).toBe(session.sessionRef);
    expect(ended.durationSeconds).toBeGreaterThanOrEqual(max);
    expect(ended.durationSeconds).toBeLessThanOrEqual(max + SESSION_END_GRACE_SECONDS);
    await expect.poll(endedRows).toBeGreaterThan(endedBefore);

    // Kapandıktan sonra zaman ilerlese de ikinci bildirim yok.
    await page.clock.fastForward(10_000);
    expect(events.filter((e) => e.type === "session_ended")).toHaveLength(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("günlük kuruluş sınırı: oturum ucu 429 döner, panel Türkçe sınır iletisini gösterir; oturum açılmaz", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    // Sayaç `quota('voice-org:<orgId>', n, 1 gün)` biçimindedir (assistant-usage.ts). Sunucudaki n bilinmediği için sayaç
    // her makul sınırın üstüne çekilir; gün dönümüne denk gelmesin diye sonraki pencere de doldurulur.
    const day = 86_400_000;
    const current = Math.floor(Date.now() / day);
    for (const w of [current, current + 1]) {
      await prisma.requestQuota.upsert({
        where: { key: `voice-org:${capOrgId}:${w}` },
        create: { key: `voice-org:${capOrgId}:${w}`, count: 1_000_000, expiresAt: new Date((w + 1) * day) },
        update: { count: 1_000_000 },
      });
    }
    const { context, page, errors } = await open(browser, baseURL, capOwnerToken);
    const sessionResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/assistant/session" && r.request().method() === "POST",
    );
    await fab(page).click();
    await consentDialog(page).getByRole("button", { name: "Kabul ediyorum, başlat" }).click();
    const res = await sessionResponse;
    test.skip(res.status() === 200, "Sunucuda günlük kuruluş sınırı kapalı (VOICE_ASSISTANT_DAILY_SESSIONS_PER_ORG=0)");
    expect(res.status()).toBe(429);
    expect(((await res.json()) as { error?: unknown }).error).toBe(DAILY_CAP_TEXT);

    // Panelin hata bloğunda ve uyarı bölgesinde (role=alert) sabit Türkçe sınır iletisi; genel hız sınırı metni değil.
    await expect(panel(page).locator(".va-panel__error")).toContainText(DAILY_CAP_TEXT);
    await expect(page.locator(ALERT_SELECTOR)).toHaveText(DAILY_CAP_TEXT);
    await expect(page.getByLabel(INPUT_LABEL)).toHaveCount(0);
    await expect(fab(page)).toBeVisible();
    // Reddedilen oturum için ne açılış ne kapanış kaydı yazılır.
    expect(
      await prisma.auditLog.count({
        where: { orgId: capOrgId, action: { in: ["VOICE_SESSION_STARTED", "VOICE_SESSION_ENDED"] } },
      }),
    ).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("A/B testi ölçümü (R1): liste ref verir; \"b varyantı harcama …\" onay kartı açar, onaya dek yazma yok, \"evet\" tek PATCH", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    test.skip(!(await assistantEnabled(request)), SKIP_REASON);
    // Bu teste özel A/B testi (ana çalışma alanında); sonunda taslakla birlikte silinir.
    const snapshot = {
      clinic: "Sahte Klinik",
      service: "Saç ekimi",
      market: "DE",
      language: "DE",
      duration: 7,
      budget: 700,
      variants: [
        { headline: "A", text: "Metin", cta: "Bilgi al" },
        { headline: "B", text: "Metin", cta: "Bilgi al" },
      ],
    };
    const draft = await prisma.studioDraft.create({
      data: {
        workspaceId,
        name: `Asistan A/B ${suffix}`,
        content: snapshot,
        policy: { version: 1, risk: "LOW", findings: [] },
        status: "APPROVED",
      },
    });
    const experiment = await prisma.studioExperiment.create({
      data: {
        draftId: draft.id,
        snapshot,
        metrics: [
          { spend: 10, clicks: 20, leads: 2 },
          { spend: 5, clicks: 10, leads: 1 },
        ],
        status: "RUNNING",
        elapsedDays: 2,
      },
    });
    try {
      const { context, page, errors } = await open(browser, baseURL, ownerToken);
      const events = collectEvents(page);
      const writes = collectWriteRequests(page, "/api/experiments");
      const experimentPath = `/api/experiments/${experiment.id}`;
      await startAssistant(page);

      // R0: liste ref verir (e1); deney kimliği ve reklam metni ajana gitmez.
      await expect(await say(page, "a/b testlerini göster")).toContainText("1 A/B testi var");
      await expect
        .poll(() => events.some((e) => e.tool === "list_experiments" && e.risk === "R0" && e.outcome === "ok"))
        .toBe(true);

      // 1) Bekleyen eylem: kart özeti ref + varyant + yeni değerler; onaylanana dek yazma isteği ve denetim olayı yok.
      await expect(await say(page, "ilk testin b varyantı harcama 120 tıklama 300 lead 12 3 gün")).toContainText(CONFIRM_QUESTION);
      await expect(confirmCard(page)).toBeVisible();
      await expect(confirmCard(page)).toContainText(
        "e1 A/B testinin B varyantına harcama 120, tıklama 300, lead 12 yazılacak; geçen gün 3.",
      );
      expect(writes).toEqual([]);
      expect(events.some((e) => e.tool === "update_experiment_metrics")).toBe(false);
      expect(await prisma.studioExperiment.findUniqueOrThrow({ where: { id: experiment.id } })).toMatchObject({
        version: 1,
        elapsedDays: 2,
      });

      // 2) "evet": tam olarak bir PATCH; sürüm, A varyantı ve durum hazırlıktaki gibi dondurulmuş.
      const patched = page.waitForResponse(
        (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === experimentPath,
      );
      await expect(await say(page, "evet")).toContainText("İşlem tamamlandı.");
      expect((await patched).ok()).toBe(true);
      await expect(confirmCard(page)).toHaveCount(0);
      await expect
        .poll(() => events.some((e) => e.tool === "update_experiment_metrics" && e.risk === "R1" && e.outcome === "ok"))
        .toBe(true);
      expect(writes).toEqual([
        {
          method: "PATCH",
          path: experimentPath,
          body: {
            version: 1,
            metrics: [
              { spend: 10, clicks: 20, leads: 2 },
              { spend: 120, clicks: 300, leads: 12 },
            ],
            elapsedDays: 3,
            status: "RUNNING",
          },
        },
      ]);
      expect(await prisma.studioExperiment.findUniqueOrThrow({ where: { id: experiment.id } })).toMatchObject({
        version: 2,
        elapsedDays: 3,
        status: "RUNNING",
      });

      // Aynı onay ikinci kez kullanılamaz.
      await expect(await say(page, "evet")).not.toContainText("İşlem tamamlandı.");
      expect(writes).toHaveLength(1);

      // Panel (ajanın gördüğü ve söylediği her şey) kayıt kimliği ve reklam içeriği taşımaz.
      const panelText = await panel(page).innerText();
      for (const secret of [experiment.id, draft.id, "Sahte Klinik", "Bilgi al"]) {
        expect(panelText, `asistan çıktısında "${secret}" görünmemeli`).not.toContain(secret);
      }
      // Denetim olayları kendi sunucumuza gider (ajana değil); ADR-0028 gereği `entityRef` = denetim satırının
      // `entityId`'si, yani yazılan deneyin gerçek kimliği. Başka hiçbir yerde kimlik ya da içerik yok.
      const eventsWithoutAuditEntity = JSON.stringify(
        events.map((e) => (e.tool === "update_experiment_metrics" && e.entityRef === experiment.id ? { ...e, entityRef: "<denetim>" } : e)),
      );
      for (const secret of [experiment.id, draft.id, "Sahte Klinik", "Bilgi al"]) {
        expect(eventsWithoutAuditEntity, `denetim olaylarında "${secret}" görünmemeli`).not.toContain(secret);
      }
      expect(events.filter((e) => e.entityRef === experiment.id).map((e) => e.tool)).toEqual(["update_experiment_metrics"]);
      for (const e of events) {
        expect(Object.keys(e).every((k) => ["type", "tool", "risk", "outcome", "entityRef", "conversationId"].includes(k))).toBe(true);
      }
      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await prisma.studioDraft.delete({ where: { id: draft.id } }).catch(() => undefined);
    }
  });
});
