import { describe, expect, it, vi } from "vitest";
import type { AssistantEvent } from "../app/_lib/assistant/events";
import { ASSISTANT_TOOLS, type ToolDef } from "../app/_lib/assistant/registry";
import { createToolRuntime } from "../app/_lib/assistant/runtime";
import { RefMap } from "../app/_lib/assistant/ref-map";

/**
 * Değişmez (ADR-0028 §2 "Rol ve tenant", `ref-map.ts`): ajana (ElevenLabs, üçüncü taraf) ve panele giden hiçbir araç
 * çıktısında gerçek veritabanı kimliği yoktur; kayıtlar yalnızca oturum ref'iyle (`c1`, `e1` …) görünür.
 *
 * Kayıttaki **her** araç çalıştırılır (yeni araç eklenince örnek parametresi yoksa test düşer). Sahte uç yanıtının
 * her nesnesinde bilinen ve bilinmeyen kimlik alanları (id, campaignId, draftId, variantId, workspaceId …) gerçek
 * biçimli cuid'dir. Denetlenen çıktılar: araç sonucu (ajana gider), onay sonucu, bekleyen eylem görünümü (onay kartı,
 * ekrandaki pencere). Hariç tutulan tek kanal kendi denetim kaydımızdır (`/api/assistant/events`, `entityRef`):
 * ADR-0028 §"Denetim" gereği orada `entityId` gerçek kimliktir ve ajana gitmez (`ToolOutput.entityId`).
 */
const CUID = /c[a-z0-9]{20,}/;
/** Bekleyen eylem kimliği (`p_` + 32 onaltılık, rastgele; kayıt kimliği değil) cuid düzenine rastlantıyla uyabilir. */
const PENDING_ID = /\bp_[0-9a-f]{32}\b/g;

let seq = 0;
/** Gerçek biçimli cuid (c + 24 küçük harf/rakam). */
function cuid(): string {
  seq += 1;
  return `c${seq.toString(36).padStart(4, "0")}q855000pscu6uver2l33`.slice(0, 25);
}

/**
 * Kişisel veri sızıntısı (ADR-0028 §4): elle girilen lead ülke/dil/kanal alanına yazılmış ad + telefon, bağlantı etiketi
 * (personelin adı ya da ham bağlantı cuid'i) gömülü uyarı başlıkları ve reklam adındaki `#xxxxxx` kimlik parçası.
 */
const PERSON = "Sahteadı Örnekoğlu";
const PHONE = "+49 151 0000000";
const FREE_TEXT = `${PERSON} ${PHONE}`;
const AD_ID_FRAGMENT = "#a1b2c3";
const PII_MARKERS = ["Sahteadı", "Örnekoğlu", "+49 151", "151 0000000", "a1b2c3"];

const ID = {
  campaign: cuid(),
  lead: cuid(),
  alert: cuid(),
  recommendation: cuid(),
  decision: cuid(),
  studio: cuid(),
  experiment: cuid(),
};

/** Bilinmeyen kimlik alanları: sanitizer beyaz listede olmadıkları için düşürmeli. */
const EXTRA_ID_KEYS = [
  "workspaceId",
  "orgId",
  "userId",
  "campaignId",
  "leadId",
  "draftId",
  "variantId",
  "adSetId",
  "adId",
  "metaCampaignId",
  "metaAdAccountId",
  "experimentId",
  "recommendationId",
  "targetId",
  "createdById",
  "stripeCustomerId",
] as const;

/** Her nesneye (iç içe dahil) bilinmeyen kimlik alanları eklenir; var olan değerler korunur. */
function poison<T>(value: T): T {
  if (Array.isArray(value)) return value.map(poison) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of EXTRA_ID_KEYS) out[key] = key === "campaignId" || key === "targetId" ? ID.campaign : cuid();
    for (const [k, v] of Object.entries(value)) out[k] = poison(v);
    return out as T;
  }
  return value;
}

const metrics = [
  { id: cuid(), spend: 10, clicks: 20, leads: 2 },
  { id: cuid(), spend: 5, clicks: 10, leads: 1 },
];

function campaignRow(state: Record<string, unknown>) {
  return {
    id: ID.campaign,
    name: "Sahte kampanya",
    status: "ACTIVE",
    workflowStatus: "ACTIVE",
    budgetCents: 20_000,
    dailyBudgetCents: 20_000,
    currency: "EUR",
    metaCampaignId: cuid(),
    review: { status: "APPROVED", disapproved: 0, withIssues: 0 },
    readiness: { ready: true },
    publish: { id: cuid(), status: "DONE" },
    ...state,
  };
}

/** Ham bağlantı kimliği etiket olarak (ad ve hesap kimliği yokken `conn.id`). */
const CONN_LABEL = cuid();

/** Başlığına etiket gömülen uyarılar (`scheduler.ts`, `meta/connections/[id]`) ve reddedilen reklam (`ad-review.ts`). */
function connectionAlerts() {
  return [
    { id: cuid(), type: "META_DISCONNECTED", severity: "CRITICAL", status: "OPEN", title: `Meta bağlantısı REVOKED: ${PERSON}` },
    { id: cuid(), type: "META_DISCONNECTED", severity: "CRITICAL", status: "OPEN", title: `Meta bağlantısı EXPIRED: ${CONN_LABEL}` },
    { id: cuid(), type: "TOKEN_EXPIRING", severity: "WARNING", status: "OPEN", title: `Meta token'ı süresi dolmak üzere: ${PERSON}` },
    { id: cuid(), type: "AD_DISAPPROVED", severity: "WARNING", status: "OPEN", title: `Meta reklamı reddetti: Sahte kampanya — Taslak (de) ${AD_ID_FRAGMENT}` },
  ];
}

/** Tüm uçlar için tek yanıt: her aracın okuduğu anahtarlar bir arada (fazla anahtarlar sanitizer'da düşer). */
function response(state: Record<string, unknown>) {
  const campaign = campaignRow(state);
  return poison({
    // Kabuk
    user: { id: cuid(), workspaceName: "Deneme çalışma alanı", roleLabel: "Sahip" },
    counts: { approvals: 1, leads: 2, alerts: 3 },
    notifications: [
      { id: cuid(), title: "Bildirim", severity: "INFO", createdAt: "2026-09-30T10:00:00.000Z" },
      { id: cuid(), title: `Meta bağlantısı REVOKED: ${PERSON}`, severity: "CRITICAL" },
      { id: cuid(), title: `Meta token'ı süresi dolmak üzere: ${CONN_LABEL}`, severity: "WARNING" },
      { id: cuid(), title: `Meta reklamı reddetti: Sahte kampanya ${AD_ID_FRAGMENT}`, severity: "WARNING" },
    ],
    // Kampanya listesi / ayrıntı / yazma sonuçları; review-sync satırları da buradan (campaignId)
    campaigns: [{ ...campaign, campaignId: ID.campaign, ads: 2, newlyDisapproved: 0 }],
    campaign,
    metrics: { days7: { spend: 100, clicks: 3 }, days30: { spend: 300, clicks: 9 } },
    adSets: [{ id: cuid(), name: "Ad set" }],
    decisions: [
      { id: ID.decision, targetType: "CAMPAIGN", targetId: ID.campaign, action: "INCREASE", approval: "PENDING", reason: "Gerekçe" },
    ],
    publish: { id: cuid(), status: "DONE" },
    synced: 1,
    // İçgörü ve rapor
    currency: "EUR",
    insights: {
      period: { days: 7 },
      summary: { totalSpend: 1000, totalLeads: 3 },
      campaigns: [{ id: ID.campaign, name: "Sahte kampanya", spentCents: 1000, leadCount: 3 }],
      byCountry: [{ country: "DE", leads: 3, qualified: 1 }, { country: FREE_TEXT, leads: 1, qualified: 0 }],
      byLanguage: [{ language: "de", leads: 3, qualified: 1 }, { language: FREE_TEXT, leads: 1, qualified: 0 }],
    },
    pendingRecommendations: [{ id: ID.recommendation }],
    report: {
      period: { start: "2026-09-23", end: "2026-09-30" },
      summary: { totalSpend: 1000 },
      campaigns: [{ id: ID.campaign, name: "Sahte kampanya", status: "ACTIVE" }],
      unreadAlerts: [{ id: ID.alert, severity: "HIGH", title: "Uyarı" }, ...connectionAlerts()],
    },
    // Uyarı, öneri
    alerts: [{ id: ID.alert, type: "CPL", severity: "HIGH", status: "OPEN", title: "Uyarı başlığı", message: "Gövde" }, ...connectionAlerts()],
    alert: { id: ID.alert, status: "RESOLVED" },
    recommendations: [{ id: ID.recommendation, status: "DRAFT", priority: "HIGH", title: "Öneri", action: { type: "BUDGET_INCREASE", campaignId: ID.campaign } }],
    recommendation: { id: ID.recommendation, status: "APPROVED", type: "BUDGET_INCREASE", action: { type: "BUDGET_INCREASE", campaignId: ID.campaign } },
    appliedCampaignId: ID.campaign,
    previousDailyBudgetCents: 20_000,
    // Politika, abonelik
    optimizationPolicy: { id: cuid(), enabled: true, mode: "SUGGEST" },
    optimizationRules: [{ id: cuid(), active: true }],
    subscription: { id: cuid(), plan: "PRO", status: "ACTIVE", stripeSubscriptionId: cuid() },
    mock: true,
    // Lead
    leads: [
      { id: ID.lead, status: "NEW", channel: "LEAD_AD", country: "DE", language: "de", inbox: { needsReply: true, handedOff: false } },
      { id: cuid(), status: "NEW", channel: FREE_TEXT, country: FREE_TEXT, language: FREE_TEXT, inbox: { needsReply: false } },
    ],
    lead: { id: ID.lead, status: "LOST" },
    pending: 1,
    attempted: 1,
    recovered: 1,
    results: [{ leadId: ID.lead, ok: true }],
    // Stüdyo
    content: {
      variants: [
        { id: cuid(), headline: "Başlık A", text: "Metin", cta: "LEARN_MORE" },
        { id: cuid(), headline: "Başlık B", text: "Metin", cta: "LEARN_MORE" },
      ],
    },
    policy: { risk: "LOW" },
    draft: { id: ID.studio, version: 3, status: "DRAFT", name: "Taslak", policy: { risk: "LOW" } },
    // A/B testi
    experiments: [
      { id: ID.experiment, draftId: ID.studio, draft: { id: ID.studio, name: "Taslak" }, status: "RUNNING", elapsedDays: 2, snapshot: { duration: 7 }, metrics },
    ],
    experiment: { id: ID.experiment, version: 2, status: "RUNNING", elapsedDays: 3, draftId: ID.studio, metrics },
  });
}

const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  navigate_to: { pageKey: "campaigns" },
  open_campaign: { ref: "c1", tab: "performance" },
  open_lead: { ref: "l1" },
  get_campaign: { ref: "c1" },
  list_experiments: { status: "RUNNING" },
  create_campaign_draft: { title: "Deneme taslağı", dailyBudget: 50 },
  submit_campaign_for_review: { ref: "c1" },
  update_alert: { ref: "a1", status: "RESOLVED" },
  update_lead_status: { ref: "l1", status: "LOST", lostReason: "Fiyat" },
  generate_ad_copy: { clinic: "Deneme Klinik", service: "Saç ekimi", market: "Almanya", language: "DE", budget: 1000, duration: 14 },
  submit_studio_draft: { ref: "s1" },
  submit_recommendation_for_review: { ref: "r1" },
  refetch_leads: { ref: "l1" },
  update_experiment_metrics: { ref: "e1", variant: "B", spend: 120, clicks: 300, leads: 12, elapsedDays: 3 },
  publish_campaign_paused: { ref: "c1" },
  pause_campaign: { ref: "c1" },
  archive_campaign: { ref: "c1" },
  activate_campaign: { ref: "c1" },
  decrease_budget: { ref: "c1", dailyBudget: 100 },
  increase_budget: { ref: "c1", dailyBudget: 300 },
  sync_meta_review: { ref: "c1" },
  apply_recommendation: { ref: "r1" },
};

/** Boş parametreyle çağrılabilen araçlar (parametresiz ya da tüm alanları isteğe bağlı). */
const NO_PARAMS = new Set((ASSISTANT_TOOLS as readonly ToolDef[]).filter((t) => t.parameters.safeParse({}).success).map((t) => t.name));

/** R2/R3 hazırlığının ön koşulu (assistant-approval ile aynı). */
const CAMPAIGN_STATE: Record<string, Record<string, unknown>> = {
  publish_campaign_paused: { workflowStatus: "APPROVED", readiness: { ready: true } },
  archive_campaign: { workflowStatus: "PUBLISHED_PAUSED" },
  activate_campaign: { workflowStatus: "PUBLISHED_PAUSED" },
};

describe("araç çıktılarında gerçek kimlik yok (yalnızca ref)", () => {
  it("örnek sahte kimlikler cuid düzenine uyar (test kendini doğrular)", () => {
    for (const id of Object.values(ID)) expect(id).toMatch(CUID);
    expect(JSON.stringify(response({}))).toMatch(CUID);
    for (const marker of PII_MARKERS) expect(JSON.stringify(response({}))).toContain(marker);
  });

  it("kayıttaki her araç: sonuç, onay sonucu ve bekleyen eylem görünümü cuid içermez", async () => {
    const tools = ASSISTANT_TOOLS as readonly ToolDef[];
    let state: Record<string, unknown> = {};
    const api = vi.fn(async () => response(state) as never);
    const refs = new RefMap();
    for (const [kind, id] of Object.entries(ID)) refs.ref(kind as keyof typeof ID, id);
    const events: AssistantEvent[] = [];
    const outputs: { tool: string; channel: string; text: string }[] = [];
    let clock = 0;
    const runtime = createToolRuntime({
      role: "OWNER",
      canApproveSpend: true,
      router: { push: vi.fn() },
      api,
      refs,
      reportEvent: (e) => {
        events.push(e);
      },
      getConversationId: () => "conv_fake_1",
      openLeadSearch: () => undefined,
      stop: () => undefined,
      location: () => ({ pathname: `/tests/${ID.experiment}`, search: "" }),
      pending: { timers: false },
      now: () => (clock += 2_500),
    });
    runtime.onPendingChange((view, _reason, ended) => {
      for (const v of [view, ended]) if (v) outputs.push({ tool: v.tool, channel: "pending", text: JSON.stringify(v) });
    });

    const exercised: string[] = [];
    for (const t of tools) {
      if (t.name === "confirm_pending_action" || t.name === "cancel_pending_action") continue;
      const params = SAMPLE_PARAMS[t.name] ?? (NO_PARAMS.has(t.name) ? {} : undefined);
      expect(params, `${t.name}: örnek parametre ekleyin`).toBeDefined();
      state = CAMPAIGN_STATE[t.name] ?? {};
      const raw = await runtime.clientTools[t.name](params);
      expect(raw, t.name).not.toMatch(/"ok":false/);
      outputs.push({ tool: t.name, channel: "result", text: raw });
      const parsed = (() => {
        try {
          return JSON.parse(raw) as { pendingId?: string; status?: string };
        } catch {
          return {};
        }
      })();
      if (parsed.status === "awaiting_confirmation" && parsed.pendingId) {
        runtime.noteUserTurn("evet");
        const confirmed = await runtime.clientTools.confirm_pending_action({ pendingId: parsed.pendingId });
        expect(confirmed, t.name).not.toMatch(/"ok":false/);
        outputs.push({ tool: t.name, channel: "confirm", text: confirmed });
      } else if (parsed.status === "awaiting_screen_confirmation" && parsed.pendingId) {
        const confirmed = await runtime.pending.confirmOnScreen(parsed.pendingId);
        expect(confirmed, t.name).not.toMatch(/"ok":false/);
        outputs.push({ tool: t.name, channel: "confirmOnScreen", text: confirmed });
      }
      exercised.push(t.name);
    }
    // Kayıttaki onay araçları da çağrılır (bekleyen eylem yokken).
    for (const name of ["confirm_pending_action", "cancel_pending_action"]) {
      outputs.push({ tool: name, channel: "result", text: await runtime.clientTools[name]({ pendingId: `p_${"0".repeat(32)}` }) });
      exercised.push(name);
    }

    expect(exercised.sort()).toEqual(tools.map((t) => t.name).sort());
    expect(api).toHaveBeenCalled();
    const leaks = outputs
      .map((o) => ({ ...o, text: o.text.replace(PENDING_ID, "p_ID") }))
      .filter((o) => CUID.test(o.text))
      .map((o) => `${o.tool} (${o.channel}): ${o.text.match(CUID)?.[0]}`);
    expect(leaks).toEqual([]);
    // Ad, telefon ve reklam kimliği parçası hiçbir çıktıda yok (lead ülke/dil/kanal, uyarı/bildirim başlıkları).
    const piiLeaks = outputs.flatMap((o) => PII_MARKERS.filter((m) => o.text.includes(m)).map((m) => `${o.tool} (${o.channel}): ${m}`));
    expect(piiLeaks).toEqual([]);
    // Denetimin gerçekten bu sinkleri çalıştırdığını doğrula.
    const byTool = (name: string) => outputs.find((o) => o.tool === name && o.channel === "result")?.text ?? "";
    expect(byTool("list_alerts")).toContain("Meta bağlantısı kesildi");
    expect(byTool("get_lead_stats")).toContain("OTHER");
    expect(byTool("get_insights")).toContain("OTHER");
    // Kendi denetim kaydımız gerçek kimliği taşır (ajana gitmez); bu yüzden yukarıdaki denetimin dışında.
    expect(events.some((e) => e.entityRef === ID.experiment)).toBe(true);
  });
});
