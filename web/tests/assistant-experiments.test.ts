import { describe, expect, it, vi } from "vitest";
import type { Role } from "@admedic/database";
import { ApiError } from "../app/_lib/client-api";
import type { AssistantEvent } from "../app/_lib/assistant/events";
import { RefMap } from "../app/_lib/assistant/ref-map";
import { findTool, toolsFor } from "../app/_lib/assistant/registry";
import { createToolRuntime, TOOL_MESSAGES } from "../app/_lib/assistant/runtime";
import { sanitizeExperimentList } from "../app/_lib/assistant/sanitize";
import { MockAdapter, matchMockCommand, type AdapterMessage } from "../app/_lib/assistant/adapter";

// Faz 5 (ADR-0028): A/B testleri. `list_experiments` (R0) yalnızca durum, gün ve varyant metriklerini döner;
// `update_experiment_metrics` (R1) yalnızca onaydan sonra, tek bir PATCH ile yazar. Veriler sahtedir.

type Call = { url: string; method: string; data: unknown };

const EXPERIMENT = {
  id: "exp_fake_1",
  version: 4,
  status: "RUNNING",
  elapsedDays: 3,
  metrics: [
    { spend: 10.5, clicks: 20, leads: 2 },
    { spend: 8, clicks: 15, leads: 1 },
  ],
  snapshot: {
    duration: 14,
    clinic: "Sahte Klinik",
    headlines: ["Sahte başlık A", "Sahte başlık B"],
    contact: "iletisim@example.invalid",
  },
  draft: { name: "Sahte taslak · ayse@example.invalid" },
  updatedAt: "2026-09-30T10:00:00.000Z",
};

function setup(role: Role = "MEDIA_BUYER", experiment: Record<string, unknown> = EXPERIMENT, location = { pathname: "/tests/exp_fake_1", search: "" }) {
  const events: AssistantEvent[] = [];
  const calls: Call[] = [];
  const api = vi.fn(async (url: string, method = "GET", data?: unknown) => {
    calls.push({ url, method, data });
    if (method === "GET" && url === "/api/experiments") return { experiments: [experiment, { ...experiment, id: "exp_fake_2", status: "COMPLETED" }] } as never;
    if (method === "GET" && url === "/api/experiments/exp_fake_1") return { experiment } as never;
    if (method === "PATCH" && url === "/api/experiments/exp_fake_1") return { id: "exp_fake_1" } as never;
    return {} as never;
  });
  const refs = new RefMap();
  const runtime = createToolRuntime({
    role,
    canApproveSpend: false,
    router: { push: vi.fn() },
    api,
    refs,
    reportEvent: (e) => {
      events.push(e);
    },
    location: () => location,
    now: () => 0,
    pending: { timers: false },
  });
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { runtime, api, calls, writes, events, refs };
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("list_experiments (R0)", () => {
  it("yalnızca ref, maskelenmiş ad, durum, gün ve varyant metrikleri döner; reklam içeriği ve kimlik dönmez", async () => {
    const { runtime } = setup();
    const raw = await runtime.clientTools.list_experiments({});
    const out = parse(raw);
    expect(out).toMatchObject({ total: 2, shown: 2, byStatus: { RUNNING: 1, COMPLETED: 1 } });
    expect((out.experiments as unknown[])[0]).toEqual({
      ref: "e1",
      name: "Sahte taslak · [e-posta]",
      status: "RUNNING",
      elapsedDays: 3,
      plannedDays: 14,
      variants: [
        { variant: "A", spend: 10.5, clicks: 20, leads: 2 },
        { variant: "B", spend: 8, clicks: 15, leads: 1 },
      ],
      updatedAt: "2026-09-30",
    });
    for (const secret of ["exp_fake_1", "Sahte Klinik", "Sahte başlık", "iletisim@", "ayse@"]) expect(raw).not.toContain(secret);
  });

  it("durum süzgeci ve liste sınırı", () => {
    const refs = new RefMap();
    const many = Array.from({ length: 15 }, (_, i) => ({ ...EXPERIMENT, id: `exp_${i}` }));
    const out = sanitizeExperimentList({ experiments: many }, refs, { status: "RUNNING" });
    expect(out.total).toBe(15);
    expect(out.experiments).toHaveLength(10);
    expect(sanitizeExperimentList({ experiments: many }, refs, { status: "DRAFT" }).total).toBe(0);
    // Bozuk metrik: alan null döner, sızmaz.
    expect(sanitizeExperimentList({ experiments: [{ id: "x", metrics: "bozuk" }] }, new RefMap()).experiments[0].variants).toEqual([
      { variant: "A", spend: null, clicks: null, leads: null },
      { variant: "B", spend: null, clicks: null, leads: null },
    ]);
  });

  it("rol süzgeci menüyle aynı (READ_ADS): koordinatöre bağlanmaz", () => {
    expect(toolsFor("PATIENT_COORDINATOR", false).map((t) => t.name)).not.toContain("list_experiments");
    expect(toolsFor("VIEWER", false).map((t) => t.name)).toContain("list_experiments");
    expect(findTool("list_experiments")?.endpoints).toEqual(["GET /api/experiments"]);
  });
});

describe("update_experiment_metrics (R1)", () => {
  it("hazırlık yalnızca okur; özet + pendingId döner; onaydan önce yazma yok", async () => {
    const { runtime, writes, events } = setup();
    await runtime.clientTools.list_experiments({});
    const out = parse(await runtime.clientTools.update_experiment_metrics({ ref: "e1", variant: "B", spend: 120.5, clicks: 300, leads: 12 }));
    expect(out).toMatchObject({
      status: "awaiting_confirmation",
      summary: "e1 A/B testinin B varyantına harcama 120,5, tıklama 300, lead 12 yazılacak; geçen gün 3. Diğer varyant ve test durumu değişmez.",
    });
    expect(writes()).toEqual([]);
    // Kullanıcı konuşmadan ajan onaylayamaz.
    expect(parse(await runtime.clientTools.confirm_pending_action({ pendingId: out.pendingId })).ok).toBe(false);
    expect(writes()).toEqual([]);
    expect(events.map((e) => e.outcome)).toEqual(["ok", "denied"]);
  });

  it("onay tek bir PATCH yapar: sürüm, diğer varyant, gün ve durum hazırlıktaki gibi dondurulur", async () => {
    const { runtime, writes, events } = setup();
    await runtime.clientTools.list_experiments({});
    const { pendingId } = parse(await runtime.clientTools.update_experiment_metrics({ ref: "e1", variant: "B", spend: 120.5, clicks: 300, leads: 12, elapsedDays: 5 }));
    runtime.noteUserTurn("evet");
    const result = parse(await runtime.clientTools.confirm_pending_action({ pendingId }));
    expect(result).toEqual({ ok: true, ref: "e1", variant: "B", elapsedDays: 5 });
    expect(writes()).toEqual([
      {
        url: "/api/experiments/exp_fake_1",
        method: "PATCH",
        data: {
          version: 4,
          metrics: [
            { spend: 10.5, clicks: 20, leads: 2 },
            { spend: 120.5, clicks: 300, leads: 12 },
          ],
          elapsedDays: 5,
          status: "RUNNING",
        },
      },
    ]);
    expect(events.at(-1)).toMatchObject({ tool: "update_experiment_metrics", risk: "R1", outcome: "ok", entityRef: "exp_fake_1" });
    // Tekrar oynatma reddedilir.
    runtime.noteUserTurn("evet");
    expect(parse(await runtime.clientTools.confirm_pending_action({ pendingId })).ok).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it("geçersiz girdiler hazırlıkta reddedilir; bekleyen eylem oluşmaz", async () => {
    const { runtime, writes } = setup();
    await runtime.clientTools.list_experiments({});
    const err = async (params: Record<string, unknown>) => parse(await runtime.clientTools.update_experiment_metrics(params)).error;
    expect(await err({ ref: "e1", variant: "A", spend: 1, clicks: 5, leads: 6 })).toBe("Lead sayısı tıklama sayısından büyük olamaz.");
    expect(await err({ ref: "e1", variant: "A", spend: 1, clicks: 5, leads: 1, elapsedDays: 2 })).toBe("Geçen gün sayısı azaltılamaz (şu an 3).");
    expect(String(await err({ ref: "e1", variant: "C", spend: 1, clicks: 5, leads: 1 }))).toMatch(/^Geçersiz parametre/);
    expect(String(await err({ ref: "e1", variant: "A", spend: -1, clicks: 5, leads: 1 }))).toMatch(/^Geçersiz parametre/);
    expect(String(await err({ ref: "e1", variant: "A", spend: 1, clicks: 5.5, leads: 1 }))).toMatch(/^Geçersiz parametre/);
    // Kimlik ya da kapsam parametresi alınmaz; ref başka türün ref'i olamaz.
    expect(String(await err({ ref: "e1", variant: "A", spend: 1, clicks: 5, leads: 1, workspaceId: "ws" }))).toMatch(/^Geçersiz parametre/);
    expect(String(await err({ ref: "c1", variant: "A", spend: 1, clicks: 5, leads: 1 }))).toMatch(/referans/);
    expect(runtime.pending.current()).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("tamamlanan test ve okunamayan diğer varyant yazılmaz", async () => {
    const completed = setup("OWNER", { ...EXPERIMENT, status: "COMPLETED" });
    await completed.runtime.clientTools.list_experiments({});
    expect(parse(await completed.runtime.clientTools.update_experiment_metrics({ ref: "e1", variant: "A", spend: 1, clicks: 1, leads: 1 })).error).toBe(
      "Tamamlanan A/B testinin metrikleri değiştirilemez.",
    );
    const broken = setup("OWNER", { ...EXPERIMENT, metrics: [{ spend: 1, clicks: 1, leads: 0 }] });
    await broken.runtime.clientTools.list_experiments({});
    expect(parse(await broken.runtime.clientTools.update_experiment_metrics({ ref: "e1", variant: "A", spend: 1, clicks: 1, leads: 1 })).error).toMatch(
      /Diğer varyantın metrikleri okunamadı/,
    );
    expect([...completed.writes(), ...broken.writes()]).toEqual([]);
  });

  it("sunucu sürüm çakışması (409) ajana sabit kodla gider; sunucu metni aktarılmaz", async () => {
    const { runtime, api } = setup();
    await runtime.clientTools.list_experiments({});
    const { pendingId } = parse(await runtime.clientTools.update_experiment_metrics({ ref: "e1", variant: "A", spend: 1, clicks: 2, leads: 1 }));
    api.mockImplementationOnce(async () => {
      throw new ApiError("Deney değişmiş. Sayfayı yenileyin.", 409);
    });
    runtime.noteUserTurn("evet");
    expect(parse(await runtime.clientTools.confirm_pending_action({ pendingId }))).toEqual({
      ok: false,
      error: `${TOOL_MESSAGES.notApplicable}: changed_meanwhile`,
      retryable: false,
    });
  });

  it("rol süzgeci sunucuyu izler (EDIT_ROLES): koordinatör, analist ve izleyiciye bağlanmaz", () => {
    for (const role of ["OWNER", "ADMIN", "MEDIA_BUYER"] as Role[])
      expect(toolsFor(role, false).map((t) => t.name), role).toContain("update_experiment_metrics");
    for (const role of ["PATIENT_COORDINATOR", "ANALYST", "VIEWER"] as Role[])
      expect(toolsFor(role, false).map((t) => t.name), role).not.toContain("update_experiment_metrics");
    const { runtime } = setup("ANALYST");
    expect(runtime.clientTools.update_experiment_metrics).toBeUndefined();
    expect(runtime.deniedTools.update_experiment_metrics).toBeTypeOf("function");
  });

  it("get_current_context A/B testi sayfasında testin ref'ini verir (kimlik değil)", async () => {
    const { runtime } = setup();
    const raw = await runtime.clientTools.get_current_context({});
    expect(parse(raw)).toEqual({ page: "tests", experimentRef: "e1" });
    expect(raw).not.toContain("exp_fake_1");
  });
});

describe("senaryolu ajan: A/B ölçümü", () => {
  it("komutlar araç çağrısına çevrilir (sıra sözcüğü ref'tir, rakamlar metriktir)", () => {
    expect(matchMockCommand("A/B testlerini göster")?.tool).toBe("list_experiments");
    expect(matchMockCommand("İkinci testin B varyantı harcama 120 tıklama 300 lead 12, 14 gün")).toEqual({
      tool: "update_experiment_metrics",
      params: { ref: "e2", variant: "B", spend: 120, clicks: 300, leads: 12, elapsedDays: 14 },
    });
    expect(matchMockCommand("bu testin a varyantı harcama 50 tıklama 80 lead 4")).toMatchObject({
      tool: "update_experiment_metrics",
      context: "experimentRef",
      params: { variant: "A", spend: 50, clicks: 80, leads: 4 },
    });
  });

  it("\"bu testin …\" açık sayfadaki testi kullanır; \"evet\" ile tek yazma", async () => {
    const { runtime, writes } = setup();
    const adapter = new MockAdapter({ delayMs: 0 });
    const said: AdapterMessage[] = [];
    adapter.on("message", (m) => said.push(m));
    adapter.on("message", (m) => {
      if (m.role === "user") runtime.noteUserTurn(m.text);
    });
    await adapter.start({ credentials: { connection: "webrtc", serverLocation: "us", mock: true }, clientTools: runtime.clientTools });
    await adapter.sendUserMessage("Bu testin B varyantı harcama 20 tıklama 40 lead 3");
    expect(said.at(-1)?.text).toContain("B varyantına harcama 20, tıklama 40, lead 3");
    expect(writes()).toEqual([]);
    await adapter.sendUserMessage("evet");
    expect(writes()).toHaveLength(1);
    expect(writes()[0].data).toMatchObject({ metrics: [EXPERIMENT.metrics[0], { spend: 20, clicks: 40, leads: 3 }] });
  });
});
