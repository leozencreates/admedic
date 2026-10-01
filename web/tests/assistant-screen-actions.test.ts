import { describe, expect, it, vi } from "vitest";
import type { Role } from "@admedic/database";
import { ApiError } from "../app/_lib/client-api";
import { AssistantEventSchema, type AssistantEvent } from "../app/_lib/assistant/events";
import { PendingActionError, PENDING_TTL_BY_RISK } from "../app/_lib/assistant/pending";
import { RefMap } from "../app/_lib/assistant/ref-map";
import { createToolRuntime, SCREEN_CONFIRMATION_INSTRUCTION, TOOL_MESSAGES } from "../app/_lib/assistant/runtime";
import { formatCents, recommendedBudgetCents, SCREEN_ACTION_MESSAGES } from "../app/_lib/assistant/tools/screen-actions";
import { MOCK_MESSAGES, MockAdapter, matchMockCommand, type AdapterMessage } from "../app/_lib/assistant/adapter";

// Faz 4 (ADR-0028 §2–3): R2/R3 araçları yalnızca bekleyen eylem oluşturur; yazma isteği yalnızca ekrandaki modal onay
// penceresinden (`pending.confirmOnScreen`) ve bir kez gider. Veriler sahtedir; gerçek kişi yoktur.

type Call = { url: string; method: string; data: unknown };

const CAMPAIGN = { id: "cmp_fake_1", name: "Ekim saç ekimi", budgetCents: 20_000, currency: "EUR", budgetType: "DAILY" };

function setup(
  options: { role?: Role; canApproveSpend?: boolean; campaign?: Record<string, unknown>; responses?: Record<string, unknown> } = {},
) {
  const events: AssistantEvent[] = [];
  const calls: Call[] = [];
  const state = { campaign: { ...CAMPAIGN, workflowStatus: "ACTIVE", metaCampaignId: "meta_fake_1", ...options.campaign } as Record<string, unknown> };
  const responses = options.responses ?? {};
  const api = vi.fn(async (url: string, method = "GET", data?: unknown) => {
    calls.push({ url, method, data });
    const key = `${method} ${url}`;
    if (key in responses) {
      const value = responses[key];
      if (value instanceof Error) throw value;
      return (typeof value === "function" ? (value as () => unknown)() : value) as never;
    }
    if (key === "GET /api/campaigns/cmp_fake_1") return { campaign: state.campaign } as never;
    return {} as never;
  });
  const refs = new RefMap();
  refs.ref("campaign", "cmp_fake_1");
  refs.ref("lead", "lead_fake_1");
  refs.ref("recommendation", "rec_fake_1");
  let clock = 0;
  const runtime = createToolRuntime({
    role: options.role ?? "OWNER",
    canApproveSpend: options.canApproveSpend ?? true,
    router: { push: vi.fn() },
    api,
    refs,
    reportEvent: (e) => {
      events.push(e);
    },
    getConversationId: () => "conv_fake_1",
    location: () => ({ pathname: "/campaigns/cmp_fake_1", search: "" }),
    now: () => clock,
    pending: { timers: false },
  });
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { runtime, calls, writes, events, state, tick: (ms: number) => (clock += ms) };
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;
const NOT_CONFIRMABLE = new PendingActionError("not_confirmable").message;

describe("R2/R3: araç çağrısı yazma yapmaz; yalnızca ekran onayı bir kez yazar", () => {
  it("pause_campaign: özet + ekranda onay talimatı döner; yalnızca GET; olay yazılmaz", async () => {
    const { runtime, calls, writes, events } = setup();
    const out = parse(await runtime.clientTools.pause_campaign({ ref: "c1" }));
    expect(out).toMatchObject({
      status: "awaiting_screen_confirmation",
      summary: "\"Ekim saç ekimi\" kampanyası Meta'da duraklatılacak; harcama durur.",
      next: SCREEN_CONFIRMATION_INSTRUCTION,
      expiresInSeconds: PENDING_TTL_BY_RISK.R2 / 1000,
    });
    expect(SCREEN_CONFIRMATION_INSTRUCTION).toBe("Kullanıcı ekrandaki onay penceresinden onaylamalı; sesle onaylanamaz.");
    expect(String(out.pendingId)).toMatch(/^p_[0-9a-f]{32}$/);
    expect(JSON.stringify(out)).not.toMatch(/cmp_fake_1|meta_fake_1/);
    expect(calls).toEqual([{ url: "/api/campaigns/cmp_fake_1", method: "GET", data: undefined }]);
    expect(writes()).toEqual([]);
    expect(events).toEqual([]);
    const view = runtime.pending.current()!;
    expect(view).toMatchObject({ tool: "pause_campaign", risk: "R2" });
    expect(view.confirmation).toEqual({
      title: "Kampanyayı duraklat",
      campaignName: "Ekim saç ekimi",
      fields: [{ label: "Durum", before: "Yayında", after: "Etkinleştirme bekliyor" }],
      risk: "R2",
      riskLabel: "Dış etki · harcama yok",
    });
  });

  it("sesli 'evet', confirm_pending_action ve R1 kartı R2/R3'ü çalıştıramaz; ekran onayı tek yazma yapar", async () => {
    const { runtime, writes, events } = setup({
      campaign: { workflowStatus: "PUBLISHED_PAUSED" },
      responses: { "POST /api/campaigns/cmp_fake_1/publish": { campaign: { id: "cmp_fake_1", action: "ACTIVATE", workflowStatus: "ACTIVE", status: "ACTIVE", policyWarning: "Sahte bulgu", metaCampaignId: "meta_fake_1" } } },
    });
    const { pendingId } = parse(await runtime.clientTools.activate_campaign({ ref: "c1" }));
    for (const reply of ["evet", "Evet, onaylıyorum.", "tamam yap"]) {
      runtime.noteUserTurn(reply);
      expect(parse(await runtime.clientTools.confirm_pending_action({ pendingId })).error, reply).toBe(NOT_CONFIRMABLE);
    }
    expect(parse(await runtime.pending.confirm(String(pendingId))).error).toBe(NOT_CONFIRMABLE);
    expect(writes()).toEqual([]);
    expect(runtime.pending.current()?.pendingId).toBe(pendingId);
    expect(events.map((e) => [e.tool, e.risk, e.outcome])).toEqual([
      ["confirm_pending_action", "R0", "denied"],
      ["confirm_pending_action", "R0", "denied"],
      ["confirm_pending_action", "R0", "denied"],
    ]);
    const done = await runtime.pending.confirmOnScreen(String(pendingId));
    expect(parse(done)).toEqual({ ok: true, ref: "c1", action: "ACTIVATE", workflowStatus: "ACTIVE", status: "ACTIVE", policyWarning: true });
    expect(done).not.toMatch(/Sahte bulgu|meta_fake_1/);
    expect(writes()).toEqual([{ url: "/api/campaigns/cmp_fake_1/publish", method: "POST", data: { action: "ACTIVATE" } }]);
    // Tekrar oynatma: ikinci ekran onayı da reddedilir.
    expect(parse(await runtime.pending.confirmOnScreen(String(pendingId))).ok).toBe(false);
    expect(writes()).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "tool_call", tool: "activate_campaign", risk: "R3", outcome: "ok", entityRef: "cmp_fake_1", conversationId: "conv_fake_1" });
    for (const e of events) expect(AssistantEventSchema.safeParse(e).success).toBe(true);
  });

  it("parametreler dondurulur: ekran onayı hazırlıktaki tutarı gönderir", async () => {
    const { runtime, writes } = setup({ responses: { "PATCH /api/campaigns/cmp_fake_1/budget": { campaign: { id: "cmp_fake_1", dailyBudgetCents: 12_550, dailyBudget: 125.5 } } } });
    const { pendingId } = parse(await runtime.clientTools.decrease_budget({ ref: "c1", dailyBudget: 125.5 }));
    const done = parse(await runtime.pending.confirmOnScreen(String(pendingId)));
    expect(done).toEqual({ ok: true, ref: "c1", dailyBudget: 125.5, currency: "EUR" });
    expect(writes()).toEqual([{ url: "/api/campaigns/cmp_fake_1/budget", method: "PATCH", data: { dailyBudget: 125.5 } }]);
  });

  it("iptal ve süre dolumu yazma yapmaz; R2/R3 süresi 120 sn; son sonuç 'cancelled'", async () => {
    const { runtime, writes, events, tick } = setup();
    const a = parse(await runtime.clientTools.pause_campaign({ ref: "c1" }));
    expect(parse(await runtime.clientTools.cancel_pending_action({ pendingId: a.pendingId }))).toMatchObject({ ok: true, status: "cancelled" });
    const b = parse(await runtime.clientTools.pause_campaign({ ref: "c1" }));
    tick(60_000);
    expect(runtime.pending.current()?.pendingId).toBe(b.pendingId);
    tick(60_000);
    expect(parse(await runtime.pending.confirmOnScreen(String(b.pendingId))).error).toMatch(/süresi doldu/);
    expect(writes()).toEqual([]);
    expect(events.map((e) => [e.tool, e.risk, e.outcome])).toEqual([
      ["pause_campaign", "R2", "cancelled"],
      ["pause_campaign", "R2", "cancelled"],
    ]);
  });
});

describe("bütçe yönü hazırlıkta taze bütçeyle denetlenir", () => {
  it("decrease_budget ile artış, increase_budget ile azaltma ve aynı tutar reddedilir; bekleyen eylem oluşmaz", async () => {
    const { runtime, writes } = setup();
    const up = parse(await runtime.clientTools.decrease_budget({ ref: "c1", dailyBudget: 500 }));
    expect(up).toMatchObject({ ok: false });
    expect(String(up.error)).toContain("increase_budget");
    expect(String(up.error)).toContain(formatCents(20_000, "EUR"));
    const down = parse(await runtime.clientTools.increase_budget({ ref: "c1", dailyBudget: 100 }));
    expect(String(down.error)).toContain("decrease_budget");
    expect(parse(await runtime.clientTools.increase_budget({ ref: "c1", dailyBudget: 200 })).error).toBe(SCREEN_ACTION_MESSAGES.sameBudget);
    expect(runtime.pending.current()).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("onay görünümü: eski → yeni günlük ve aylık bütçe minor unit'ten para birimiyle; R3'te harcama uyarısı", async () => {
    const { runtime } = setup();
    parse(await runtime.clientTools.increase_budget({ ref: "c1", dailyBudget: 300 }));
    const view = runtime.pending.current()!;
    expect(view.risk).toBe("R3");
    expect(view.summary).toBe(`"Ekim saç ekimi" kampanyasının günlük bütçesi ${formatCents(20_000, "EUR")} → ${formatCents(30_000, "EUR")} olacak; harcama artar.`);
    expect(view.confirmation).toMatchObject({
      title: "Günlük bütçeyi artır",
      campaignName: "Ekim saç ekimi",
      risk: "R3",
      riskLabel: "Harcama",
      fields: [
        { label: "Günlük bütçe", before: formatCents(20_000, "EUR"), after: formatCents(30_000, "EUR") },
        { label: "Aylık tahmin (30 gün)", before: formatCents(600_000, "EUR"), after: formatCents(900_000, "EUR") },
      ],
    });
    expect(view.confirmation!.fields[0].before).toMatch(/200/);
    expect(view.confirmation!.fields[0].before).toMatch(/€|EUR/);
    expect(view.confirmation!.spendWarning).toMatch(/harcama yetkinizi/);
    // Azaltma R2: harcama uyarısı yok.
    parse(await runtime.clientTools.decrease_budget({ ref: "c1", dailyBudget: 150.25 }));
    expect(runtime.pending.current()!.confirmation).not.toHaveProperty("spendWarning");
    expect(runtime.pending.current()!.confirmation!.fields[0].after).toBe(formatCents(15_025, "EUR"));
    expect(formatCents(15_025, "EUR")).toMatch(/150,25/);
  });

  it("bütçe hazırlık ile tıklama arasında değiştiyse yazma yapılmaz", async () => {
    const { runtime, writes, state } = setup();
    const { pendingId } = parse(await runtime.clientTools.decrease_budget({ ref: "c1", dailyBudget: 150 }));
    // Bu arada başka biri bütçeyi 100'e düşürdü: 150 artık bir artış olurdu.
    state.campaign = { ...state.campaign, budgetCents: 10_000 };
    const out = parse(await runtime.pending.confirmOnScreen(String(pendingId)));
    expect(out.error).toBe(SCREEN_ACTION_MESSAGES.budgetChanged);
    expect(writes()).toEqual([]);
  });

  it("etkinleştirme: ekranda gösterilen bütçe ya da durum tıklamadan önce değiştiyse yayın isteği gitmez", async () => {
    const { runtime, writes, state } = setup({ campaign: { workflowStatus: "PUBLISHED_PAUSED" } });
    const first = parse(await runtime.clientTools.activate_campaign({ ref: "c1" }));
    // Onay penceresi açıkken başka bir yetkili günlük bütçeyi 200'den 2.000'e çıkardı.
    state.campaign = { ...state.campaign, budgetCents: 200_000 };
    expect(parse(await runtime.pending.confirmOnScreen(String(first.pendingId))).error).toBe(SCREEN_ACTION_MESSAGES.budgetChanged);
    expect(writes()).toEqual([]);

    state.campaign = { ...state.campaign, budgetCents: 20_000 };
    const second = parse(await runtime.clientTools.activate_campaign({ ref: "c1" }));
    state.campaign = { ...state.campaign, workflowStatus: "ACTIVE" };
    expect(parse(await runtime.pending.confirmOnScreen(String(second.pendingId))).error).toBe(SCREEN_ACTION_MESSAGES.notActivatable);
    expect(writes()).toEqual([]);
  });

  it("arşivlenmiş ya da ömür boyu bütçeli kampanyada bekleyen eylem oluşmaz", async () => {
    for (const campaign of [{ workflowStatus: "ARCHIVED" }, { budgetType: "LIFETIME" }, { lifetimeBudget: 100_000 }]) {
      const { runtime, writes } = setup({ campaign });
      expect(parse(await runtime.clientTools.decrease_budget({ ref: "c1", dailyBudget: 10 })).ok, JSON.stringify(campaign)).toBe(false);
      expect(runtime.pending.current()).toBeNull();
      expect(writes()).toEqual([]);
    }
  });
});

describe("ön koşullar (yanlış durumda bekleyen eylem oluşmaz)", () => {
  it.each([
    ["publish_campaign_paused", { workflowStatus: "DRAFT" }, SCREEN_ACTION_MESSAGES.notApproved],
    ["publish_campaign_paused", { workflowStatus: "ACTIVE" }, SCREEN_ACTION_MESSAGES.alreadyPublished],
    ["publish_campaign_paused", { workflowStatus: "APPROVED", metaCampaignId: null, readiness: { ready: false } }, SCREEN_ACTION_MESSAGES.notReady],
    ["pause_campaign", { workflowStatus: "PUBLISHED_PAUSED" }, SCREEN_ACTION_MESSAGES.notActive],
    ["archive_campaign", { workflowStatus: "DRAFT", metaCampaignId: null }, SCREEN_ACTION_MESSAGES.notArchivable],
    ["activate_campaign", { workflowStatus: "ACTIVE" }, SCREEN_ACTION_MESSAGES.notActivatable],
    ["sync_meta_review", { workflowStatus: "DRAFT", metaCampaignId: null }, SCREEN_ACTION_MESSAGES.notPublished],
  ] as const)("%s %j", async (tool, campaign, message) => {
    const { runtime, writes } = setup({ campaign });
    expect(parse(await runtime.clientTools[tool]({ ref: "c1" }))).toEqual({ ok: false, error: message, retryable: false });
    expect(runtime.pending.current()).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("yayınla: onaylı kampanya PAUSED yüklenir; yarım kalırsa ajana sayfa önerisi döner", async () => {
    const { runtime, writes } = setup({
      campaign: { workflowStatus: "APPROVED", metaCampaignId: null, readiness: { ready: true } },
      responses: {
        "POST /api/campaigns/cmp_fake_1/publish": {
          campaign: { id: "cmp_fake_1", action: "PUBLISH", workflowStatus: "APPROVED", status: "PAUSED", metaCampaignId: "meta_new" },
          publish: { status: "IN_PROGRESS", warnings: ["Sahte uyarı"] },
        },
      },
    });
    const prep = parse(await runtime.clientTools.publish_campaign_paused({ ref: "c1" }));
    expect(runtime.pending.current()!.confirmation).toMatchObject({
      fields: [{ label: "Durum", before: "Meta'ya yüklenmeye hazır", after: "Etkinleştirme bekliyor" }],
      notes: ["Kampanya Meta'da duraklatılmış (PAUSED) kurulur; harcama başlamaz."],
    });
    expect(runtime.pending.current()!.confirmation).not.toHaveProperty("spendWarning");
    const done = await runtime.pending.confirmOnScreen(String(prep.pendingId));
    expect(parse(done)).toMatchObject({ ok: true, publishStatus: "IN_PROGRESS", next: expect.stringContaining("Yükleme") });
    expect(done).not.toMatch(/Sahte uyarı|meta_new/);
    expect(writes()).toEqual([{ url: "/api/campaigns/cmp_fake_1/publish", method: "POST", data: { action: "PUBLISH" } }]);
  });

  it("Meta inceleme eşitlemesi: tek kampanya ya da tümü; yalnızca sayılar ve ref'ler döner", async () => {
    const { runtime, writes } = setup({
      responses: {
        "POST /api/meta/review-sync": {
          synced: 1,
          campaigns: [{ campaignId: "cmp_fake_1", name: "Ekim saç ekimi", status: "DISAPPROVED", ads: 3, newlyDisapproved: 1, error: "Sahte hata" }],
        },
      },
    });
    const one = parse(await runtime.clientTools.sync_meta_review({ ref: "c1" }));
    const done = await runtime.pending.confirmOnScreen(String(one.pendingId));
    expect(parse(done)).toEqual({
      ok: true,
      synced: 1,
      byStatus: { DISAPPROVED: 1 },
      newlyDisapproved: 1,
      campaigns: [{ ref: "c1", status: "DISAPPROVED", ads: 3, newlyDisapproved: 1 }],
    });
    expect(done).not.toMatch(/Sahte hata|cmp_fake_1/);
    const all = parse(await runtime.clientTools.sync_meta_review({}));
    expect(runtime.pending.current()!.confirmation!.fields).toEqual([{ label: "Kapsam", after: "Yayındaki tüm kampanyalar (en çok 50)" }]);
    await runtime.pending.confirmOnScreen(String(all.pendingId));
    expect(writes().map((w) => w.data)).toEqual([{ campaignId: "cmp_fake_1" }, {}]);
  });
});

describe("apply_recommendation (R3)", () => {
  const recommendation = (over: Record<string, unknown> = {}) => ({
    recommendation: { id: "rec_fake_1", status: "APPROVED", type: "BUDGET_INCREASE", title: "Sahte", action: { campaignId: "cmp_fake_1" }, ...over },
  });

  it("onaylı öneri: hedef kampanya ve bütçe eski → yeni gösterilir; gövdesiz tek POST", async () => {
    const { runtime, writes, calls } = setup({
      responses: {
        "GET /api/recommendations/rec_fake_1": recommendation(),
        "POST /api/recommendations/rec_fake_1/apply": { ok: true, status: "APPLIED", appliedCampaignId: "cmp_fake_1", campaignId: "cmp_fake_1", previousDailyBudgetCents: 20_000, dailyBudgetCents: 24_000, metaSynced: true },
      },
    });
    const prep = parse(await runtime.clientTools.apply_recommendation({ ref: "r1" }));
    expect(prep.summary).toBe(`r1 önerisi "Ekim saç ekimi" kampanyasına uygulanacak: günlük bütçe ${formatCents(20_000, "EUR")} → ${formatCents(24_000, "EUR")}.`);
    expect(runtime.pending.current()!.confirmation).toMatchObject({
      risk: "R3",
      fields: [{ label: "Öneri", after: "r1" }, { label: "Öneri türü", after: "Bütçe artışı" }, { label: "Günlük bütçe" }, { label: "Aylık tahmin (30 gün)" }],
      spendWarning: expect.any(String),
    });
    expect(writes()).toEqual([]);
    const done = parse(await runtime.pending.confirmOnScreen(String(prep.pendingId)));
    expect(done).toEqual({ ok: true, ref: "r1", status: "APPLIED", campaignRef: "c1", previousDailyBudget: 200, dailyBudget: 240, metaSynced: true });
    expect(writes()).toEqual([{ url: "/api/recommendations/rec_fake_1/apply", method: "POST", data: undefined }]);
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([
      "/api/recommendations/rec_fake_1",
      "/api/campaigns/cmp_fake_1",
      "/api/recommendations/rec_fake_1",
      "/api/campaigns/cmp_fake_1",
    ]);
  });

  it.each([
    [{ status: "PENDING" }, SCREEN_ACTION_MESSAGES.recommendationNotApproved],
    [{ status: "APPLIED" }, SCREEN_ACTION_MESSAGES.recommendationApplied],
    [{ type: "EXPERIMENT_END" }, SCREEN_ACTION_MESSAGES.recommendationNotApplicable],
    [{ action: {} }, SCREEN_ACTION_MESSAGES.recommendationNoTarget],
  ])("%j → bekleyen eylem yok", async (over, message) => {
    const { runtime, writes } = setup({ responses: { "GET /api/recommendations/rec_fake_1": recommendation(over) } });
    expect(parse(await runtime.clientTools.apply_recommendation({ ref: "r1" })).error).toBe(message);
    expect(runtime.pending.current()).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("öneri hedefi tıklamadan önce değiştiyse yazma yapılmaz", async () => {
    let target = "cmp_fake_1";
    const { runtime, writes } = setup({
      responses: { "GET /api/recommendations/rec_fake_1": () => recommendation({ action: { campaignId: target } }) },
    });
    const prep = parse(await runtime.clientTools.apply_recommendation({ ref: "r1" }));
    target = "cmp_other";
    expect(parse(await runtime.pending.confirmOnScreen(String(prep.pendingId))).error).toBe(SCREEN_ACTION_MESSAGES.recommendationChanged);
    expect(writes()).toEqual([]);
  });

  it("gösterim hesabı sunucuyla aynı (×1,2; dağıtım payı; yüzde azaltma)", () => {
    expect(recommendedBudgetCents("BUDGET_INCREASE", {}, 10_000)).toBe(12_000);
    expect(recommendedBudgetCents("BUDGET_REALLOCATION", {}, 10_000)).toBe(7_000);
    expect(recommendedBudgetCents("BUDGET_REALLOCATION", { budgetSplit: [55] }, 10_000)).toBe(5_500);
    expect(recommendedBudgetCents("BUDGET_DECREASE", { pct: 25 }, 10_000)).toBe(7_500);
    expect(recommendedBudgetCents("BUDGET_DECREASE", { pct: 150 }, 10_000)).toBeNull();
  });
});

describe("R3 harcama yetkisi ve sunucu hataları", () => {
  it("canApproveSpend false: R3 araçları bağlanmaz; saplama yazma yapmaz ve 'denied' bildirir; R2 bağlıdır", async () => {
    const { runtime, calls, events } = setup({ role: "MEDIA_BUYER", canApproveSpend: false });
    for (const name of ["activate_campaign", "increase_budget", "apply_recommendation"]) {
      expect(runtime.clientTools[name], name).toBeUndefined();
      expect(runtime.tools.map((t) => t.name)).not.toContain(name);
      expect(parse(await runtime.deniedTools[name]({ ref: "c1" }))).toEqual({ ok: false, error: TOOL_MESSAGES.forbidden, retryable: false });
    }
    for (const name of ["pause_campaign", "decrease_budget", "publish_campaign_paused"]) expect(runtime.clientTools[name], name).toBeTypeOf("function");
    expect(calls).toEqual([]);
    expect(events.map((e) => [e.tool, e.risk, e.outcome])).toEqual([
      ["activate_campaign", "R3", "denied"],
      ["increase_budget", "R3", "denied"],
      ["apply_recommendation", "R3", "denied"],
    ]);
  });

  it("izleyici, analist ve hasta koordinatörü kampanya R2/R3 aracını bağlamaz", () => {
    for (const role of ["VIEWER", "ANALYST", "PATIENT_COORDINATOR"] as const) {
      const { runtime } = setup({ role, canApproveSpend: true });
      for (const name of ["pause_campaign", "decrease_budget", "activate_campaign", "increase_budget", "apply_recommendation", "sync_meta_review"])
        expect(runtime.clientTools[name], `${role}/${name}`).toBeUndefined();
    }
    expect(setup({ role: "PATIENT_COORDINATOR" }).runtime.clientTools.update_lead_status).toBeTypeOf("function");
  });

  it.each([
    [403, "Bu işlem yalnızca kuruluş sahibi (Owner) veya Owner'ın harcama yetkisi verdiği üye tarafından yapılabilir.", TOOL_MESSAGES.spendForbidden, "denied"],
    [403, "Bu işlem için yetkiniz yok.", TOOL_MESSAGES.forbidden, "denied"],
    [422, "Aylık bütçe üst sınırı aşılıyor: aktif kampanyalar €1.000 + bu kampanya €9.000 = €10.000 > kuruluş sınırı €5.000.", `${TOOL_MESSAGES.notApplicable}: monthly_cap`, "error"],
    [409, "Kampanyanın yayın durumu Meta'daki kayıtla uyuşmuyor. Sayfayı yenileyip tekrar deneyin.", `${TOOL_MESSAGES.notApplicable}: meta_mismatch`, "error"],
    [409, "Arşivlenmiş veya silinmiş kampanyanın bütçesi değiştirilemez.", `${TOOL_MESSAGES.notApplicable}: archived`, "error"],
  ] as const)("bütçe artışı %i → sabit ileti", async (status, message, expected, outcome) => {
    const { runtime, events, writes } = setup({ responses: { "PATCH /api/campaigns/cmp_fake_1/budget": new ApiError(message, status) } });
    const { pendingId } = parse(await runtime.clientTools.increase_budget({ ref: "c1", dailyBudget: 300 }));
    const raw = await runtime.pending.confirmOnScreen(String(pendingId));
    expect(parse(raw)).toEqual({ ok: false, error: expected, retryable: false });
    expect(raw).not.toContain("€");
    expect(writes()).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ tool: "increase_budget", risk: "R3", outcome, entityRef: "cmp_fake_1" });
  });

  it.each([
    ["pause_campaign", "Yalnızca yayındaki kampanya duraklatılabilir. Sayfayı yenileyip kampanyanın durumunu kontrol edin.", "invalid_state"],
    ["activate_campaign", "Önce kampanyayı yayınlayın.", "not_published"],
    ["activate_campaign", "Kampanya durumu eşzamanlı olarak değişti; yenileyip tekrar deneyin.", "changed_meanwhile"],
    ["publish_campaign_paused", "Kampanya henüz onaylanmadı. Yayınlamadan önce kampanyayı onaya gönderip onaylatın.", "not_approved"],
    ["publish_campaign_paused", "Bu kampanyanın Meta yayını şu anda sürüyor; birkaç saniye sonra tekrar deneyin.", "publish_in_progress"],
  ] as const)("%s 409 → %s", async (tool, message, code) => {
    const campaign =
      tool === "pause_campaign"
        ? { workflowStatus: "ACTIVE" }
        : tool === "activate_campaign"
          ? { workflowStatus: "PUBLISHED_PAUSED" }
          : { workflowStatus: "APPROVED", metaCampaignId: null };
    const { runtime } = setup({ campaign, responses: { "POST /api/campaigns/cmp_fake_1/publish": new ApiError(message, 409) } });
    const { pendingId } = parse(await runtime.clientTools[tool]({ ref: "c1" }));
    expect(parse(await runtime.pending.confirmOnScreen(String(pendingId))).error).toBe(`${TOOL_MESSAGES.notApplicable}: ${code}`);
  });
});

describe("senaryolu (mock) ajan: R2/R3", () => {
  const credentials = { connection: "webrtc" as const, conversationToken: "mock", conversationId: "conv_mock_1", serverLocation: "us", mock: true };

  it("R2/R3 kalıpları", () => {
    expect(matchMockCommand("kampanyayı duraklat")).toEqual({ tool: "pause_campaign", params: { ref: "c1" } });
    expect(matchMockCommand("ikinci kampanyayı duraklat")).toEqual({ tool: "pause_campaign", params: { ref: "c2" } });
    expect(matchMockCommand("bu kampanyayı duraklat")).toEqual({ tool: "pause_campaign", params: {}, context: "campaignRef" });
    expect(matchMockCommand("kampanyayı aktifleştir")).toEqual({ tool: "activate_campaign", params: { ref: "c1" } });
    expect(matchMockCommand("yayınla")).toEqual({ tool: "publish_campaign_paused", params: { ref: "c1" } });
    expect(matchMockCommand("bütçeyi 500 yap")).toEqual({
      tool: "decrease_budget",
      params: { ref: "c1", dailyBudget: 500 },
      alternate: "increase_budget",
    });
    expect(matchMockCommand("ikinci kampanyanın bütçesini 50 düşür")).toEqual({ tool: "decrease_budget", params: { ref: "c2", dailyBudget: 50 } });
    expect(matchMockCommand("öneriyi uygula")).toEqual({ tool: "apply_recommendation", params: { ref: "r1" } });
  });

  async function started(options: Parameters<typeof setup>[0]) {
    const s = setup(options);
    const adapter = new MockAdapter({ delayMs: 0 });
    const messages: AdapterMessage[] = [];
    adapter.on("message", (m) => {
      messages.push(m);
      if (m.role === "user") s.runtime.noteUserTurn(m.text);
    });
    await adapter.start({ credentials, clientTools: s.runtime.clientTools });
    return { ...s, adapter, messages };
  }

  it("'bütçeyi 500 yap' (mevcut 200) → artış aracına geçer, ekranda onay ister; 'evet' yazma yapmaz", async () => {
    const { adapter, messages, writes, runtime } = await started({});
    await adapter.sendUserMessage("bütçeyi 500 yap");
    expect(messages.at(-1)?.text).toBe(
      `"Ekim saç ekimi" kampanyasının günlük bütçesi ${formatCents(20_000, "EUR")} → ${formatCents(50_000, "EUR")} olacak; harcama artar. ${MOCK_MESSAGES.screenConfirm}`,
    );
    expect(runtime.pending.current()).toMatchObject({ tool: "increase_budget", risk: "R3" });
    await adapter.sendUserMessage("evet");
    expect(messages.at(-1)?.text).toBe(NOT_CONFIRMABLE);
    expect(writes()).toEqual([]);
    expect(runtime.pending.current()).not.toBeNull();
  });

  it("'kampanyayı duraklat' → 'hayır' iptal eder; yazma yok", async () => {
    const { adapter, messages, writes, runtime } = await started({});
    await adapter.sendUserMessage("kampanyayı duraklat");
    expect(messages.at(-1)?.text).toContain(MOCK_MESSAGES.screenConfirm);
    await adapter.sendUserMessage("hayır");
    expect(messages.at(-1)?.text).toBe("İşlem iptal edildi; hiçbir değişiklik yapılmadı.");
    expect(runtime.pending.current()).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("harcama yetkisi yoksa 'kampanyayı aktifleştir' → 'yetkiniz yok'", async () => {
    const { adapter, messages, calls } = await started({ role: "MEDIA_BUYER", canApproveSpend: false });
    await adapter.sendUserMessage("kampanyayı aktifleştir");
    expect(messages.at(-1)?.text).toBe(TOOL_MESSAGES.forbidden);
    expect(calls).toEqual([]);
  });
});
