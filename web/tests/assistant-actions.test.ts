import { describe, expect, it, vi } from "vitest";
import type { Role } from "@admedic/database";
import { ApiError } from "../app/_lib/client-api";
import { AssistantEventSchema, type AssistantEvent } from "../app/_lib/assistant/events";
import { PendingActionError, PENDING_TTL_MS, type PendingView } from "../app/_lib/assistant/pending";
import { RefMap } from "../app/_lib/assistant/ref-map";
import { createToolRuntime, reasonCode, TOOL_MESSAGES } from "../app/_lib/assistant/runtime";
import { MOCK_MESSAGES, MockAdapter, matchMockCommand, type AdapterMessage } from "../app/_lib/assistant/adapter";

// Faz 3 (ADR-0028 §2–3): R1 araçları yalnızca bekleyen eylem oluşturur; yazma isteği onaydan sonra, bir kez gider.
// Veriler sahtedir; gerçek kişi yoktur.

type Call = { url: string; method: string; data: unknown };

function setup(role: Role = "OWNER", responses: Record<string, unknown> = {}, location = { pathname: "/leads/lead_fake_1", search: "" }) {
  const events: AssistantEvent[] = [];
  const calls: Call[] = [];
  const api = vi.fn(async (url: string, method = "GET", data?: unknown) => {
    calls.push({ url, method, data });
    const value = responses[`${method} ${url}`] ?? {};
    if (value instanceof Error) throw value;
    return value as never;
  });
  let clock = 0;
  const refs = new RefMap();
  refs.ref("campaign", "cmp_fake_1");
  refs.ref("lead", "lead_fake_1");
  refs.ref("alert", "alert_fake_1");
  const runtime = createToolRuntime({
    role,
    canApproveSpend: false,
    router: { push: vi.fn() },
    api,
    refs,
    reportEvent: (e) => {
      events.push(e);
    },
    getConversationId: () => "conv_fake_1",
    location: () => location,
    now: () => clock,
    pending: { timers: false },
  });
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { runtime, api, calls, writes, events, tick: (ms: number) => (clock += ms) };
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

/** Kullanıcı "evet" der, ardından ajan onaylar (ajan yolu kullanıcı turu olmadan onaylayamaz). */
async function agentConfirm(runtime: ReturnType<typeof setup>["runtime"], params: Record<string, unknown>, reply = "evet") {
  runtime.noteUserTurn(reply);
  return runtime.clientTools.confirm_pending_action(params);
}

describe("R1 akışı: araç çağrısı → onay → tek yazma", () => {
  it("araç çağrısı yazma yapmaz; özet + pendingId + onay sorusu döner; olay yazılmaz", async () => {
    const { runtime, calls, events } = setup();
    const out = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "RESOLVED" }));
    expect(out).toMatchObject({
      status: "awaiting_confirmation",
      summary: "a1 uyarısı \"Çözüldü\" olarak işaretlenecek.",
      question: "Onaylıyor musunuz?",
      expiresInSeconds: PENDING_TTL_MS / 1000,
    });
    expect(String(out.pendingId)).toMatch(/^p_[0-9a-f]{32}$/);
    expect(String(out.next)).toContain("confirm_pending_action");
    expect(JSON.stringify(out)).not.toContain("alert_fake_1");
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("onay tam bir yazma isteği yapar (dondurulmuş parametrelerle); tekrar onay reddedilir", async () => {
    const { runtime, calls, events } = setup("OWNER", {
      "PATCH /api/alerts/alert_fake_1": { ok: true, alert: { id: "alert_fake_1", status: "RESOLVED", message: "Sahte gövde metni" } },
    });
    const { pendingId } = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "RESOLVED" }));
    const result = parse(await agentConfirm(runtime, { pendingId }));
    expect(result).toEqual({ ok: true, ref: "a1", status: "RESOLVED" });
    expect(calls).toEqual([{ url: "/api/alerts/alert_fake_1", method: "PATCH", data: { status: "RESOLVED" } }]);
    expect(events).toEqual([
      { type: "tool_call", tool: "update_alert", risk: "R1", outcome: "ok", entityRef: "alert_fake_1", conversationId: "conv_fake_1" },
    ]);
    const again = parse(await agentConfirm(runtime, { pendingId }));
    expect(again).toMatchObject({ ok: false });
    expect(String(again.error)).toMatch(/zaten/);
    expect(calls).toHaveLength(1);
    for (const e of events) expect(AssistantEventSchema.safeParse(e).success).toBe(true);
  });

  it("iptal ve süre dolumu hiç yazma yapmaz; son sonuç 'cancelled' olarak bildirilir", async () => {
    const { runtime, calls, events, tick } = setup();
    const a = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "ACKED" }));
    expect(a.summary).toBe("a1 uyarısı \"Görüldü\" olarak işaretlenecek.");
    expect(parse(await runtime.clientTools.cancel_pending_action({ pendingId: a.pendingId }))).toMatchObject({ ok: true, status: "cancelled" });
    const b = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "RESOLVED" }));
    tick(PENDING_TTL_MS);
    const late = parse(await agentConfirm(runtime, { pendingId: b.pendingId }));
    expect(String(late.error)).toMatch(/süresi doldu/);
    expect(calls).toEqual([]);
    expect(events.map((e) => [e.tool, e.risk, e.outcome, e.entityRef])).toEqual([
      ["update_alert", "R1", "cancelled", "alert_fake_1"],
      ["update_alert", "R1", "cancelled", "alert_fake_1"],
      ["confirm_pending_action", "R0", "error", undefined],
    ]);
  });

  it("yeni R1 isteği öncekinin yerini alır; eski kimlik onaylanamaz", async () => {
    const { runtime, writes, events } = setup();
    const first = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "ACKED" }));
    const second = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "RESOLVED" }));
    expect(second.previousPendingCancelled).toBe(true);
    expect(parse(await agentConfirm(runtime, { pendingId: first.pendingId })).ok).toBe(false);
    expect(writes()).toEqual([]);
    await agentConfirm(runtime, { pendingId: second.pendingId });
    expect(writes()).toEqual([{ url: "/api/alerts/alert_fake_1", method: "PATCH", data: { status: "RESOLVED" } }]);
    expect(events[0]).toMatchObject({ tool: "update_alert", outcome: "cancelled" });
  });

  it("uydurma pendingId biçim denetiminde reddedilir", async () => {
    const { runtime, writes } = setup();
    await runtime.clientTools.update_alert({ ref: "a1", status: "ACKED" });
    for (const pendingId of ["p_123", "alert_fake_1", "p_" + "0".repeat(32)])
      expect(parse(await agentConfirm(runtime, { pendingId })).ok).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("ekrandaki onay aynı yoldan geçer; kart görünümü onPendingChange ile gelir", async () => {
    const { runtime, writes, events } = setup();
    const seen: (PendingView | null)[] = [];
    runtime.onPendingChange((p) => seen.push(p));
    const { pendingId } = parse(await runtime.clientTools.submit_campaign_for_review({ ref: "c1" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pendingId, tool: "submit_campaign_for_review", risk: "R1", summary: "c1 kampanyası onaya gönderilecek." });
    expect(JSON.stringify(seen[0])).not.toContain("cmp_fake_1");
    expect(runtime.pending.current()?.pendingId).toBe(pendingId);
    expect(parse(await runtime.pending.confirm(String(pendingId))).ok).toBe(true);
    expect(seen.at(-1)).toBeNull();
    expect(writes()).toEqual([{ url: "/api/campaigns/cmp_fake_1/submit", method: "POST", data: undefined }]);
    expect(parse(await agentConfirm(runtime, { pendingId })).ok).toBe(false);
    expect(writes()).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "submit_campaign_for_review", outcome: "ok", entityRef: "cmp_fake_1" });
  });

  it("dispose bekleyen eylemi iptal eder", async () => {
    const { runtime, writes, events } = setup();
    await runtime.clientTools.refetch_leads({});
    runtime.dispose();
    expect(runtime.pending.current()).toBeNull();
    expect(writes()).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ tool: "refetch_leads", risk: "R1", outcome: "cancelled" })]);
  });
});

describe("R1 sözlü onay: kullanıcı turu gerekir", () => {
  it("oluşturup aynı turda onaylamak reddedilir (denied); eylem bekler, kullanıcı 'evet' deyince geçer", async () => {
    const { runtime, writes, events } = setup("OWNER", { "PATCH /api/alerts/alert_fake_1": { ok: true } });
    runtime.noteUserTurn("kampanyaları göster");
    const { pendingId } = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "RESOLVED" }));
    const early = parse(await runtime.clientTools.confirm_pending_action({ pendingId }));
    expect(early).toMatchObject({ ok: false });
    expect(String(early.error)).toMatch(/henüz açıkça onaylamadı/);
    expect(writes()).toEqual([]);
    expect(runtime.pending.current()?.pendingId).toBe(pendingId);
    expect(events).toEqual([expect.objectContaining({ tool: "confirm_pending_action", outcome: "denied" })]);
    runtime.noteUserTurn("Evet, onaylıyorum.");
    expect(parse(await runtime.clientTools.confirm_pending_action({ pendingId }))).toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it("eylemden sonraki kullanıcı turu onay değilse (ya da ret içeriyorsa) ajan onaylayamaz", async () => {
    const { runtime, writes } = setup();
    const { pendingId } = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "ACKED" }));
    for (const reply of ["teşekkürler", "hayır", "evet ama hayır iptal et", "kampanyaları göster"]) {
      runtime.noteUserTurn(reply);
      expect(parse(await runtime.clientTools.confirm_pending_action({ pendingId })).ok, reply).toBe(false);
    }
    expect(writes()).toEqual([]);
  });

  it("onaydan önce gelen 'evet' sonraki eyleme taşınmaz", async () => {
    const { runtime, writes } = setup();
    runtime.noteUserTurn("evet");
    const { pendingId } = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "ACKED" }));
    expect(parse(await runtime.clientTools.confirm_pending_action({ pendingId })).ok).toBe(false);
    // Yerine yenisi gelirse eski tur yeni eylemi de onaylamaz.
    runtime.noteUserTurn("evet");
    const second = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "RESOLVED" }));
    expect(parse(await runtime.clientTools.confirm_pending_action({ pendingId: second.pendingId })).ok).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("ekrandaki onay kullanıcı turu gerektirmez (tıklamanın kendisi kullanıcı onayıdır)", async () => {
    const { runtime, writes } = setup();
    const { pendingId } = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "ACKED" }));
    expect(parse(await runtime.pending.confirm(String(pendingId))).ok).toBe(true);
    expect(writes()).toHaveLength(1);
  });
});

describe("R1 rol süzgeci", () => {
  it("izleyici ve analist R1 aracını bağlamaz; saplama yazma yapmaz", async () => {
    for (const role of ["VIEWER", "ANALYST"] as const) {
      const { runtime, calls } = setup(role);
      expect(runtime.clientTools.update_alert).toBeUndefined();
      expect(runtime.clientTools.update_lead_status).toBeUndefined();
      expect(parse(await runtime.deniedTools.update_lead_status({ ref: "l1", status: "LOST" }))).toMatchObject({ ok: false, error: TOOL_MESSAGES.forbidden });
      expect(calls).toEqual([]);
    }
  });

  it("hasta koordinatörü lead durumunu değiştirebilir, kampanya taslağı oluşturamaz", () => {
    const { runtime } = setup("PATIENT_COORDINATOR");
    expect(runtime.clientTools.update_lead_status).toBeTypeOf("function");
    expect(runtime.clientTools.create_campaign_draft).toBeUndefined();
    expect(runtime.clientTools.submit_recommendation_for_review).toBeUndefined();
  });

  it("sunucu 403 dönerse 'yetkiniz yok' ve denied; tekrar denenmez", async () => {
    const { runtime, events, writes } = setup("PATIENT_COORDINATOR", {
      "PATCH /api/alerts/alert_fake_1": new ApiError("Bu uyarıyı kapatma yetkiniz yok. Hesap sahibi …", 403),
    });
    const { pendingId } = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "RESOLVED" }));
    expect(parse(await agentConfirm(runtime, { pendingId }))).toEqual({ ok: false, error: TOOL_MESSAGES.forbidden, retryable: false });
    expect(writes()).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ tool: "update_alert", risk: "R1", outcome: "denied", entityRef: "alert_fake_1" })]);
  });
});

describe("R1 hata eşleme: sunucu serbest metni ajana gitmez", () => {
  it.each([
    [400, "Reklam hesabı bulunamadı. Platformlar sayfasından …", "no_ad_account"],
    [409, "Lead bu durumdan seçilen duruma geçirilemez. Sayfayı yenileyip …", "invalid_transition"],
    [409, "Kampanya zaten incelemede veya daha ileri bir aşamada.", "already_done"],
    [422, "Aylık bütçe üst sınırı aşılıyor: aktif kampanyalar 1.000 € + …", "monthly_cap"],
    [422, "İçerik kontrolü orta risk buldu. Uyarıyı inceleyip …", "policy_warning"],
    [422, "Sahte Kişi <sahte@example.test> için bilinmeyen hata", "validation_failed"],
    [409, "bilinmeyen çakışma", "state_conflict"],
  ] as const)("%i %s → %s", async (status, message, code) => {
    const { runtime } = setup("OWNER", { "PATCH /api/alerts/alert_fake_1": new ApiError(message, status) });
    const { pendingId } = parse(await runtime.clientTools.update_alert({ ref: "a1", status: "RESOLVED" }));
    const raw = await agentConfirm(runtime, { pendingId });
    expect(parse(raw)).toEqual({ ok: false, error: `${TOOL_MESSAGES.notApplicable}: ${code}`, retryable: false });
    expect(raw).not.toContain(message.slice(0, 12));
    expect(raw).not.toContain("example.test");
    expect(reasonCode(status, message)).toBe(code);
  });

  it("404 ve 429 kısa Türkçe ileti", async () => {
    for (const [status, msg] of [
      [404, TOOL_MESSAGES.notFound],
      [429, TOOL_MESSAGES.rateLimited],
    ] as const) {
      const { runtime } = setup("OWNER", { "POST /api/leads/refetch": new ApiError("ham", status) });
      const { pendingId } = parse(await runtime.clientTools.refetch_leads({}));
      expect(parse(await agentConfirm(runtime, { pendingId })).error).toBe(msg);
    }
  });
});

describe("R1 araçları: parametre ve gövde", () => {
  it("lead kaybı için listeden neden gerekir; serbest metin reddedilir (Faz 4: R2, ekranda onay)", async () => {
    const { runtime, calls } = setup();
    expect(parse(await runtime.clientTools.update_lead_status({ ref: "l1", status: "LOST" })).error).toMatch(/kayıp nedeni/);
    expect(parse(await runtime.clientTools.update_lead_status({ ref: "l1", status: "LOST", lostReason: "hasta kalp rahatsızlığı" })).ok).toBe(false);
    expect(parse(await runtime.clientTools.update_lead_status({ ref: "l1", status: "QUALIFIED", lostReason: "Fiyat" })).ok).toBe(false);
    const ok = parse(await runtime.clientTools.update_lead_status({ ref: "l1", status: "LOST", lostReason: "Fiyat" }));
    expect(ok.status).toBe("awaiting_screen_confirmation");
    expect(ok.summary).toBe("l1 lead'i \"Kaybedildi\" olarak işaretlenecek. Kayıp nedeni: Fiyat.");
    // Sesli "evet" (kullanıcı turuyla bile) R2'yi çalıştıramaz.
    expect(parse(await agentConfirm(runtime, { pendingId: ok.pendingId })).error).toBe(new PendingActionError("not_confirmable").message);
    expect(calls).toEqual([]);
    const view = runtime.pending.current()!;
    expect(view.confirmation).toMatchObject({
      risk: "R2",
      fields: [
        { label: "Lead", after: "l1" },
        { label: "Yeni aşama", after: "Kaybedildi" },
        { label: "Kayıp nedeni", after: "Fiyat" },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("lead_fake_1");
    await runtime.pending.confirmOnScreen(String(ok.pendingId));
    expect(calls).toEqual([{ url: "/api/leads/lead_fake_1", method: "PATCH", data: { status: "LOST", lostReason: "Fiyat" } }]);
  });

  it("çalışma alanı ve ham kimlik parametresi reddedilir; ref uydurulamaz", async () => {
    const { runtime, calls } = setup();
    expect(parse(await runtime.clientTools.update_alert({ ref: "a1", status: "ACKED", workspaceId: "ws_other" })).ok).toBe(false);
    expect(parse(await runtime.clientTools.update_alert({ ref: "alert_fake_1", status: "ACKED" })).ok).toBe(false);
    expect(parse(await runtime.clientTools.update_alert({ ref: "a9", status: "ACKED" })).ok).toBe(false);
    expect(parse(await runtime.clientTools.submit_campaign_for_review({ ref: "l1" })).ok).toBe(false);
    expect(runtime.pending.current()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("kampanya taslağı: yalnızca ad, günlük bütçe ve hedef gönderilir; yanıttaki politika metni ajana gitmez", async () => {
    const { runtime, calls } = setup("MEDIA_BUYER", {
      "POST /api/campaigns": {
        campaign: { id: "cmp_new_1", workflowStatus: "DRAFT", status: "PAUSED", budgetCents: 5000, currency: "EUR", policyRisk: "MEDIUM", policyWarning: "Sahte Kişi örnek bulgusu", adSets: 0 },
      },
    });
    const prep = parse(await runtime.clientTools.create_campaign_draft({ title: "Ekim saç ekimi", dailyBudget: 50 }));
    expect(prep.summary).toBe("\"Ekim saç ekimi\" adlı taslak kampanya oluşturulacak: günlük bütçe 50 (reklam hesabının para biriminde), hedef Satış. Kampanya duraklatılmış taslak olarak kalır.");
    const done = parse(await agentConfirm(runtime, { pendingId: prep.pendingId }));
    expect(calls).toEqual([{ url: "/api/campaigns", method: "POST", data: { name: "Ekim saç ekimi", budget: 50, objective: "MAX_ROAS" } }]);
    expect(done).toMatchObject({ ok: true, ref: "c2", workflowStatus: "DRAFT", dailyBudget: 50, policyRisk: "MEDIUM" });
    expect(JSON.stringify(done)).not.toMatch(/Sahte Kişi|cmp_new_1/);
  });

  it("reklam metni üret → kaydet → onaya gönder (sürüm hazırlıkta okunur ve dondurulur)", async () => {
    const content = {
      clinic: "Deneme Klinik",
      service: "Saç ekimi",
      market: "Almanya",
      language: "DE",
      budget: 1000,
      duration: 14,
      variants: [
        { headline: "Başlık A", text: "Gövde metni", cta: "LEARN_MORE" },
        { headline: "Başlık B", text: "Gövde metni", cta: "LEARN_MORE" },
      ],
      instantForm: { questions: ["Soru 1", "Soru 2"] },
      whatsapp: { welcome: "Merhaba" },
      profile: { brandTone: "Sahte marka tonu" },
    };
    const { runtime, calls, writes } = setup("OWNER", {
      "POST /api/studio/generate": { content, policy: { risk: "LOW", findings: [] } },
      "POST /api/studio": { draft: { id: "draft_fake_1", status: "DRAFT", version: 1, policy: { risk: "LOW" } } },
      "GET /api/studio/draft_fake_1": { draft: { id: "draft_fake_1", status: "DRAFT", version: 1, content } },
      "PATCH /api/studio/draft_fake_1": { draft: { id: "draft_fake_1", status: "IN_REVIEW", version: 2, policy: { risk: "LOW" } } },
    });
    expect(parse(await runtime.clientTools.save_studio_draft({})).error).toMatch(/Önce generate_ad_copy/);
    const brief = { clinic: "Deneme Klinik", service: "Saç ekimi", market: "Almanya", language: "DE", budget: 1000, duration: 14 };
    const gen = parse(await runtime.clientTools.generate_ad_copy(brief));
    expect(calls).toEqual([]);
    const generated = parse(await agentConfirm(runtime, { pendingId: gen.pendingId }));
    expect(generated).toMatchObject({
      ok: true,
      variants: [{ headline: "Başlık A", text: "Gövde metni", cta: "LEARN_MORE" }, { headline: "Başlık B" }],
      instantFormQuestions: 2,
      whatsappWelcome: true,
      policyRisk: "LOW",
    });
    expect(JSON.stringify(generated)).not.toMatch(/Soru 1|Sahte marka|Merhaba/);
    const save = parse(await runtime.clientTools.save_studio_draft({}));
    expect(save.summary).toBe("\"Deneme Klinik · Saç ekimi\" reklam taslağı kaydedilecek.");
    const saved = parse(await agentConfirm(runtime, { pendingId: save.pendingId }));
    expect(saved).toEqual({ ok: true, ref: "s1", status: "DRAFT", policyRisk: "LOW" });
    expect(writes().at(-1)).toEqual({ url: "/api/studio", method: "POST", data: { content } });
    const submit = parse(await runtime.clientTools.submit_studio_draft({ ref: "s1" }));
    expect(calls.at(-1)).toMatchObject({ url: "/api/studio/draft_fake_1", method: "GET" });
    await agentConfirm(runtime, { pendingId: submit.pendingId });
    expect(writes().at(-1)).toEqual({ url: "/api/studio/draft_fake_1", method: "PATCH", data: { action: "submit", version: 1 } });
    expect(writes()).toHaveLength(3);
  });

  it("incelemedeki taslak yeniden gönderilmez (bekleyen eylem oluşmaz)", async () => {
    const { runtime, writes } = setup("OWNER", { "GET /api/studio/draft_fake_9": { draft: { id: "draft_fake_9", status: "IN_REVIEW", version: 4 } } }, {
      pathname: "/studio",
      search: "?id=draft_fake_9",
    });
    const ctx = parse(await runtime.clientTools.get_current_context({}));
    expect(ctx).toEqual({ page: "studio", studioDraftRef: "s1" });
    expect(parse(await runtime.clientTools.submit_studio_draft({ ref: "s1" })).error).toMatch(/zaten incelemede/);
    expect(runtime.pending.current()).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("öneri yalnızca onay kuyruğuna gönderilir (status=PENDING); ret sesle yok", async () => {
    const { runtime, calls } = setup("ADMIN", {
      "PATCH /api/recommendations/rec_fake_1": { ok: true, recommendation: { id: "rec_fake_1", status: "PENDING", title: "Sahte" } },
    });
    runtime.refs.ref("recommendation", "rec_fake_1");
    const prep = parse(await runtime.clientTools.submit_recommendation_for_review({ ref: "r1" }));
    expect(parse(await agentConfirm(runtime, { pendingId: prep.pendingId }))).toEqual({ ok: true, ref: "r1", status: "PENDING" });
    expect(calls).toEqual([{ url: "/api/recommendations/rec_fake_1", method: "PATCH", data: { status: "PENDING" } }]);
  });

  it("yeniden çekme yalnızca sayıları döndürür", async () => {
    const { runtime } = setup("OWNER", {
      "POST /api/leads/refetch": { attempted: 2, recovered: 1, failed: 1, skipped: 0, remaining: 3, results: [{ leadId: "lead_fake_1", error: "Sahte Kişi" }] },
    });
    const prep = parse(await runtime.clientTools.refetch_leads({ ref: "l1" }));
    const done = await agentConfirm(runtime, { pendingId: prep.pendingId });
    expect(parse(done)).toEqual({ ok: true, attempted: 2, recovered: 1, failed: 1, skipped: 0, remaining: 3 });
    expect(done).not.toMatch(/lead_fake_1|Sahte/);
  });
});

describe("get_current_context", () => {
  it("lead sayfasında yalnızca lead ref'i döner (ad yok)", async () => {
    const { runtime, calls } = setup();
    expect(parse(await runtime.clientTools.get_current_context({}))).toEqual({ page: "leads", leadRef: "l1" });
    expect(calls).toEqual([]);
  });

  it("kampanya sayfası; menüde olmayan kayıt türü ve güvenli olmayan kimlik ref'e dönüşmez", async () => {
    expect(parse(await setup("OWNER", {}, { pathname: "/campaigns/cmp_fake_1", search: "?tab=content" }).runtime.clientTools.get_current_context({}))).toEqual({
      page: "campaigns",
      campaignRef: "c1",
    });
    expect(parse(await setup("PATIENT_COORDINATOR", {}, { pathname: "/campaigns/cmp_fake_1", search: "" }).runtime.clientTools.get_current_context({}))).toEqual({});
    expect(parse(await setup("OWNER", {}, { pathname: "/leads/Sahte%20Ki%C5%9Fi", search: "" }).runtime.clientTools.get_current_context({}))).toEqual({
      page: "leads",
    });
  });
});

describe("senaryolu (mock) ajan: sözlü onay", () => {
  const credentials = { connection: "webrtc" as const, conversationToken: "mock", conversationId: "conv_mock_1", serverLocation: "us", mock: true };

  it("R1 kalıpları", () => {
    expect(matchMockCommand("uyarıyı kapat")).toEqual({ tool: "update_alert", params: { ref: "a1", status: "RESOLVED" } });
    expect(matchMockCommand("ikinci uyarıyı gördüm")).toEqual({ tool: "update_alert", params: { ref: "a2", status: "ACKED" } });
    expect(matchMockCommand("bu lead'i kazanıldı yap")).toEqual({ tool: "update_lead_status", params: { status: "TREATED" }, context: "leadRef" });
    expect(matchMockCommand("Bu lead'i fiyat nedeniyle kaybedildi yap")).toMatchObject({ params: { status: "LOST", lostReason: "Fiyat" } });
    expect(matchMockCommand("Evet")).toEqual({ tool: "confirm_pending_action", params: {}, pending: true });
    expect(matchMockCommand("hayır")).toEqual({ tool: "cancel_pending_action", params: {}, pending: true });
    expect(matchMockCommand("iptal")?.tool).toBe("cancel_pending_action");
    // "evet" cümle içinde onay sayılmaz.
    expect(matchMockCommand("evet ama önce kampanyaları göster")?.tool).toBe("list_campaigns");
    expect(matchMockCommand("kapat")?.tool).toBe("stop_assistant");
  });

  async function started(role: Role) {
    const s = setup(role, { "PATCH /api/leads/lead_fake_1": { ok: true } });
    const adapter = new MockAdapter({ delayMs: 0 });
    const messages: AdapterMessage[] = [];
    adapter.on("message", (m) => {
      messages.push(m);
      if (m.role === "user") s.runtime.noteUserTurn(m.text);
    });
    await adapter.start({ credentials, clientTools: s.runtime.clientTools });
    return { ...s, adapter, messages };
  }

  it("'bu lead'i kazanıldı yap' (R2) → özet + ekranda onay; 'evet' yazma yapmaz; ekran onayı → tek PATCH", async () => {
    const { adapter, messages, writes, runtime } = await started("PATIENT_COORDINATOR");
    await adapter.sendUserMessage("bu lead'i kazanıldı yap");
    expect(messages.at(-1)?.text).toBe(`l1 lead'inin durumu "Tedavi tamamlandı" olacak. ${MOCK_MESSAGES.screenConfirm}`);
    expect(writes()).toEqual([]);
    await adapter.sendUserMessage("evet");
    expect(messages.at(-1)?.text).toBe(new PendingActionError("not_confirmable").message);
    expect(writes()).toEqual([]);
    const pending = runtime.pending.current()!;
    expect(pending.risk).toBe("R2");
    expect(parse(await runtime.pending.confirmOnScreen(pending.pendingId)).ok).toBe(true);
    expect(writes()).toEqual([{ url: "/api/leads/lead_fake_1", method: "PATCH", data: { status: "TREATED" } }]);
  });

  it("'hayır' iptal eder; yazma yok", async () => {
    const { adapter, messages, writes } = await started("OWNER");
    await adapter.sendUserMessage("uyarıyı kapat");
    expect(messages.at(-1)?.text).toBe("a1 uyarısı \"Çözüldü\" olarak işaretlenecek. Onaylıyor musunuz?");
    await adapter.sendUserMessage("hayır");
    expect(messages.at(-1)?.text).toBe("İşlem iptal edildi; hiçbir değişiklik yapılmadı.");
    expect(writes()).toEqual([]);
  });

  it("izleyicide R1 komutu 'yetkiniz yok'", async () => {
    const { adapter, messages, writes } = await started("VIEWER");
    await adapter.sendUserMessage("uyarıyı kapat");
    expect(messages.at(-1)?.text).toBe(TOOL_MESSAGES.forbidden);
    expect(writes()).toEqual([]);
  });
});
