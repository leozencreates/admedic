import { describe, expect, it, vi } from "vitest";
import { ASSISTANT_TOOLS, toolsFor, type ToolDef } from "../app/_lib/assistant/registry";
import { createToolRuntime } from "../app/_lib/assistant/runtime";
import { PendingActionError } from "../app/_lib/assistant/pending";
import { RefMap } from "../app/_lib/assistant/ref-map";

/**
 * ADR-0002 `approval.test.ts`'in sesli asistan karşılığı (ADR-0028 §2, R4): sesle hiçbir zaman onay/ret, silme,
 * gizlilik, harcama yetkisi, tavan, faturalama ödemesi, OAuth/bağlantı, hasta mesajı, arama, politika kuralı, canlıya
 * geçiş ya da giriş/çıkış yapılamaz. Hem kayıttaki bildirilen uçlar hem de araçların gerçekte çağırdığı uçlar ve
 * gövdeler denetlenir.
 * Faz 3: R1 (iç yazma) yazma uçları yalnızca onaydan sonra çağrılır.
 * Faz 4: R2/R3 (dış etki, harcama) uçları — yayın, bütçe, öneri uygulama, Meta inceleme eşitlemesi — yalnızca
 * ekrandaki modal onay penceresinden (`pending.confirmOnScreen`) çağrılır; sesli "evet" (`confirm_pending_action`) ve
 * R1 onay kartı (`pending.confirm`) bunları hiçbir zaman çalıştıramaz.
 */
const FORBIDDEN_ENDPOINT =
  /approve|reject|privacy|delete|spend-authority|spend-cap|monthly-cap|\/cap\b|checkout|stripe|portal|oauth|connect|disconnect|messages|conversations|ai\/chat|escalat|capi|go-live|policy-rules|login|logout|members|invit|billing\/(?!subscription$)|\/calls?\b/i;
/** Yalnızca R2/R3 (ekranda onay) araçlarının yazabileceği uçlar. */
const SCREEN_ONLY_ENDPOINT = /\/publish\b|\/budget\b|\/apply\b|review-sync/;
const FORBIDDEN_TOOL_NAME = /approve|reject|delete|privacy|erase|authority|cap\b|_cap|checkout|billing_change|plan_change|oauth|connect|message|chat|escalat|send|go_live|login|logout|call|grant|policy_rule/;
/** Yalnızca R2/R3 araçlarının adında geçebilecek dış etki / harcama sözcükleri. */
const SCREEN_ONLY_TOOL_NAME = /apply|publish|activate|budget|pause|archive|meta_review/;
/** Hiçbir araç gövdesinde onay kararı, rıza, iletişim bilgisi, harcama yetkisi ya da tavan taşınamaz. */
const R4_BODY =
  /"status":"(APPROVED|REJECTED|APPLIED|ACTIVE)"|"approved"|acknowledgeWarning|consent|email|phone|metadata|canApproveSpend|granted|monthlyAdBudgetCap|cap/i;
/** R0/R1 gövdesinde ayrıca yayın/harcama eylemi ve kampanya kimliği taşınamaz. */
const R1_BODY = /"action":"(?!submit")|ACTIVATE|PUBLISH|PAUSE|ARCHIVE|campaignId|dailyBudget/i;
/** R2/R3 gövdeleri: yalnızca bu biçimler. */
const SCREEN_BODIES: { url: RegExp; body: RegExp }[] = [
  { url: /\/publish$/, body: /^\{"action":"(PUBLISH|PAUSE|ARCHIVE|ACTIVATE)"\}$/ },
  { url: /\/budget$/, body: /^\{"dailyBudget":\d+(\.\d+)?\}$/ },
  { url: /\/apply$/, body: /^\{\}$/ },
  { url: /review-sync$/, body: /^\{("campaignId":"[^"]+")?\}$/ },
  { url: /\/api\/leads\/[^/]+$/, body: /^\{"status":"[A-Z_]+"(,"lostReason":"[^"]+")?\}$/ },
];

const tools = ASSISTANT_TOOLS as readonly ToolDef[];
const isScreen = (t: ToolDef) => t.risk === "R2" || t.risk === "R3";

const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  navigate_to: { pageKey: "campaigns" },
  open_campaign: { ref: "c1", tab: "performance" },
  open_lead: { ref: "l1" },
  get_campaign: { ref: "c1" },
  create_campaign_draft: { title: "Deneme taslağı", dailyBudget: 50 },
  submit_campaign_for_review: { ref: "c1" },
  update_alert: { ref: "a1", status: "RESOLVED" },
  update_lead_status: { ref: "l1", status: "LOST", lostReason: "Fiyat" },
  generate_ad_copy: { clinic: "Deneme Klinik", service: "Saç ekimi", market: "Almanya", language: "DE", budget: 1000, duration: 14 },
  submit_studio_draft: { ref: "s1" },
  submit_recommendation_for_review: { ref: "r1" },
  refetch_leads: { ref: "l1" },
  publish_campaign_paused: { ref: "c1" },
  pause_campaign: { ref: "c1" },
  archive_campaign: { ref: "c1" },
  activate_campaign: { ref: "c1" },
  decrease_budget: { ref: "c1", dailyBudget: 100 },
  increase_budget: { ref: "c1", dailyBudget: 300 },
  sync_meta_review: { ref: "c1" },
  update_experiment_metrics: { ref: "e1", variant: "B", spend: 120.5, clicks: 300, leads: 12, elapsedDays: 5 },
  list_experiments: { status: "RUNNING" },
  apply_recommendation: { ref: "r1" },
};

/** R2/R3 hazırlığının ön koşulunu sağlayan sahte kampanya durumu (bütçe 200,00 = 20000 cent). */
const CAMPAIGN_STATE: Record<string, Record<string, unknown>> = {
  publish_campaign_paused: { workflowStatus: "APPROVED", readiness: { ready: true } },
  pause_campaign: { workflowStatus: "ACTIVE", metaCampaignId: "meta_fake_1" },
  archive_campaign: { workflowStatus: "PUBLISHED_PAUSED", metaCampaignId: "meta_fake_1" },
  activate_campaign: { workflowStatus: "PUBLISHED_PAUSED", metaCampaignId: "meta_fake_1" },
  sync_meta_review: { workflowStatus: "ACTIVE", metaCampaignId: "meta_fake_1" },
};

function endpointPattern(endpoint: string): { method: string; path: RegExp } {
  const [method, path] = endpoint.split(" ");
  return { method, path: new RegExp(`^${path.replace(/:[a-z]+/g, "[^/?]+")}(\\?.*)?$`) };
}

const GENERATED = {
  content: {
    clinic: "Deneme Klinik",
    service: "Saç ekimi",
    market: "Almanya",
    language: "DE",
    budget: 1000,
    duration: 14,
    variants: [
      { headline: "Başlık A", text: "Metin", cta: "LEARN_MORE" },
      { headline: "Başlık B", text: "Metin", cta: "LEARN_MORE" },
    ],
  },
  policy: { risk: "LOW" },
};

describe("sesli asistan onay kapısı (ADR-0028 R4 ≈ ADR-0002)", () => {
  it("kayıtta R4 işlemine giden araç adı yok; dış etki/harcama adları yalnızca R2/R3'te", () => {
    for (const t of tools) {
      expect(t.name, t.name).not.toMatch(FORBIDDEN_TOOL_NAME);
      if (SCREEN_ONLY_TOOL_NAME.test(t.name)) expect(isScreen(t), t.name).toBe(true);
    }
  });

  it("Faz 4: her R2/R3 aracı yalnızca ekranda onaylanır (screenOnly); R0/R1 değil", () => {
    expect(tools.filter(isScreen).length).toBeGreaterThan(0);
    for (const t of tools) expect(t.screenOnly === true, t.name).toBe(isScreen(t));
  });

  it("R0 araçları yalnızca GET bildirir; yazma uçları R1–R3'te; yayın/bütçe/uygulama yalnızca R2/R3; hiçbiri R4 ucu değil", () => {
    for (const t of tools)
      for (const endpoint of t.endpoints) {
        expect(endpoint, t.name).toMatch(/^(GET|POST|PATCH) \/api\//);
        expect(endpoint, t.name).not.toMatch(FORBIDDEN_ENDPOINT);
        if (!endpoint.startsWith("GET ")) expect(t.risk, `${t.name} → ${endpoint}`).not.toBe("R0");
        if (SCREEN_ONLY_ENDPOINT.test(endpoint)) expect(isScreen(t), `${t.name} → ${endpoint}`).toBe(true);
      }
  });

  it("R3 araçları harcama yetkisi olmadan hiçbir role bağlanmaz", () => {
    for (const role of ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST", "VIEWER"] as const)
      expect(toolsFor(role, false).filter((t) => t.risk === "R3"), role).toEqual([]);
  });

  it("araçlar yalnızca bildirdikleri uçları çağırır; R1 yazması onaydan sonra; R2/R3 yazması yalnızca ekran onayıyla", async () => {
    const calls: { url: string; method: string; data: unknown }[] = [];
    let campaign: Record<string, unknown> = {};
    const api = vi.fn(async (url: string, method = "GET", data?: unknown) => {
      calls.push({ url, method, data });
      if (url === "/api/studio/generate") return GENERATED as never;
      if (url.startsWith("/api/studio/") && method === "GET") return { draft: { id: "draft_fake_1", version: 3, status: "DRAFT" } } as never;
      if (url === "/api/campaigns/cmp_fake_1" && method === "GET")
        return { campaign: { id: "cmp_fake_1", name: "Sahte kampanya", budgetCents: 20_000, currency: "EUR", ...campaign } } as never;
      if (url === "/api/recommendations/rec_fake_1" && method === "GET")
        return { recommendation: { id: "rec_fake_1", status: "APPROVED", type: "BUDGET_INCREASE", action: { campaignId: "cmp_fake_1" } } } as never;
      if (url === "/api/experiments/exp_fake_1" && method === "GET")
        return {
          experiment: { id: "exp_fake_1", version: 2, status: "RUNNING", elapsedDays: 3, metrics: [{ spend: 10, clicks: 20, leads: 1 }, { spend: 0, clicks: 0, leads: 0 }] },
        } as never;
      return {} as never;
    });
    const refs = new RefMap();
    refs.ref("campaign", "cmp_fake_1");
    refs.ref("lead", "lead_fake_1");
    refs.ref("alert", "alert_fake_1");
    refs.ref("recommendation", "rec_fake_1");
    refs.ref("studio", "draft_fake_1");
    refs.ref("experiment", "exp_fake_1");
    const push = vi.fn();
    let clock = 0;
    const runtime = createToolRuntime({
      role: "OWNER",
      canApproveSpend: true,
      router: { push },
      api,
      refs,
      reportEvent: () => undefined,
      openLeadSearch: () => undefined,
      stop: () => undefined,
      location: () => ({ pathname: "/leads/lead_fake_1", search: "" }),
      pending: { timers: false },
      // Her saat okumasında 2,5 sn ilerler: tüm araçlar dakikada 30 çağrı sınırına takılmadan, bekleyen eylemler
      // dolmadan çalışır.
      now: () => (clock += 2_500),
    });
    expect(Object.keys(runtime.clientTools)).toHaveLength(tools.length);
    const notConfirmable = new PendingActionError("not_confirmable").message;
    for (const t of tools) {
      if (t.name === "confirm_pending_action" || t.name === "cancel_pending_action") continue;
      campaign = CAMPAIGN_STATE[t.name] ?? { workflowStatus: "ACTIVE", metaCampaignId: "meta_fake_1" };
      const before = calls.length;
      const raw = await runtime.clientTools[t.name](SAMPLE_PARAMS[t.name] ?? {});
      expect(raw, t.name).not.toMatch(/"ok":false/);
      if (t.risk === "R1") {
        // Hazırlık: yazma yok (yalnızca bildirilen GET okumaları).
        for (const call of calls.slice(before)) expect(call.method, t.name).toBe("GET");
        const { pendingId, status } = JSON.parse(raw) as { pendingId: string; status: string };
        expect(status, t.name).toBe("awaiting_confirmation");
        runtime.noteUserTurn("evet");
        const confirmed = await runtime.clientTools.confirm_pending_action({ pendingId });
        expect(confirmed, t.name).not.toMatch(/"ok":false/);
      }
      if (isScreen(t)) {
        const { pendingId, status, next } = JSON.parse(raw) as { pendingId: string; status: string; next: string };
        expect(status, t.name).toBe("awaiting_screen_confirmation");
        expect(next, t.name).toBe("Kullanıcı ekrandaki onay penceresinden onaylamalı; sesle onaylanamaz.");
        expect(runtime.pending.current()?.confirmation?.risk, t.name).toBe(t.risk);
        // Sesli "evet" + confirm_pending_action ve R1 kartı: reddedilir, yazma yok, eylem beklemeye devam eder.
        runtime.noteUserTurn("evet, onaylıyorum");
        expect(JSON.parse(await runtime.clientTools.confirm_pending_action({ pendingId })).error, t.name).toBe(notConfirmable);
        expect(JSON.parse(await runtime.pending.confirm(pendingId)).error, t.name).toBe(notConfirmable);
        for (const call of calls.slice(before)) expect(call.method, t.name).toBe("GET");
        expect(runtime.pending.current()?.pendingId, t.name).toBe(pendingId);
        // Yalnızca ekrandaki pencere çalıştırır: tam bir yazma.
        expect(await runtime.pending.confirmOnScreen(pendingId), t.name).not.toMatch(/"ok":false/);
        expect(calls.slice(before).filter((c) => c.method !== "GET"), t.name).toHaveLength(1);
      }
      const made = calls.slice(before);
      const writes = made.filter((c) => c.method !== "GET");
      expect(new Set(made.map((c) => `${c.method} ${c.url}`)).size, t.name).toBeLessThanOrEqual(t.endpoints.length);
      expect(writes.length, t.name).toBe(t.endpoints.filter((e) => !e.startsWith("GET ")).length);
      for (const call of made) {
        expect(call.url, t.name).not.toMatch(FORBIDDEN_ENDPOINT);
        expect(
          t.endpoints.some((e) => endpointPattern(e).method === call.method && endpointPattern(e).path.test(call.url)),
          `${t.name} → ${call.method} ${call.url}`,
        ).toBe(true);
        if (call.method === "GET") {
          expect(call.data, t.name).toBeUndefined();
          continue;
        }
        const body = JSON.stringify(call.data ?? {});
        expect(body, t.name).not.toMatch(R4_BODY);
        if (isScreen(t)) {
          expect(SCREEN_ONLY_ENDPOINT.test(call.url) || t.name === "update_lead_status", `${t.name} → ${call.url}`).toBe(true);
          const shape = SCREEN_BODIES.find((b) => b.url.test(call.url));
          expect(shape, `${t.name} → ${call.url}`).toBeDefined();
          expect(body, t.name).toMatch(shape!.body);
        } else {
          expect(call.url, t.name).not.toMatch(SCREEN_ONLY_ENDPOINT);
          expect(body, t.name).not.toMatch(R1_BODY);
        }
      }
    }
    // Gezinme araçları da yasak sayfalara gitmez (onaylar sayfası açılır ama onay vermez).
    for (const [href] of push.mock.calls) expect(String(href)).not.toMatch(/^\/api\/|approve|privacy|oauth/);
  });
});
