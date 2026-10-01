import { describe, expect, it, vi } from "vitest";
import {
  PENDING_ID_PATTERN,
  PENDING_TTL_BY_RISK,
  PENDING_TTL_MS,
  PendingActionError,
  PendingActionStore,
  canonicalJson,
  fingerprint,
  isAffirmativeReply,
  type ConfirmationView,
  type PendingChange,
} from "../app/_lib/assistant/pending";

const screenView = (risk: "R2" | "R3"): ConfirmationView => ({
  title: "Kampanyayı duraklat",
  campaignName: "Sahte kampanya",
  fields: [{ label: "Durum", before: "Yayında", after: "Etkinleştirme bekliyor" }],
  risk,
  riskLabel: risk,
});

function setup() {
  let clock = 1_000;
  const store = new PendingActionStore<string>({ now: () => clock, timers: false });
  const changes: PendingChange[] = [];
  store.onChange((c) => changes.push(c));
  const run = vi.fn(async (params: Readonly<Record<string, unknown>>) => `ran:${JSON.stringify(params)}`);
  const create = (params: Record<string, unknown> = { leadId: "lead_fake_1", status: "QUALIFIED" }, risk: "R1" | "R2" | "R3" = "R1") =>
    store.create({
      tool: "update_lead_status",
      risk,
      params,
      summary: "l1 lead'inin durumu \"Nitelikli\" olacak.",
      entityId: "lead_fake_1",
      ...(risk === "R1" ? {} : { confirmation: screenView(risk) }),
      run,
    });
  return { store, changes, run, create, tick: (ms: number) => (clock += ms) };
}

async function rejectCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PendingActionError);
    return (error as PendingActionError).code;
  }
  throw new Error("reddedilmedi");
}

describe("bekleyen eylem deposu (ADR-0028 §2, Faz 3)", () => {
  it("kimlik kriptografik rastgele, tahmin edilemez biçimde ve her seferinde farklı", () => {
    const { create } = setup();
    const ids = new Set(Array.from({ length: 50 }, () => create().pendingId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(PENDING_ID_PATTERN);
  });

  it("onay tam bir kez, dondurulmuş parametrelerle çalışır; tekrar oynatma reddedilir", async () => {
    const { store, run, create, changes } = setup();
    const { pendingId, expiresAt } = create();
    expect(expiresAt).toBe(1_000 + PENDING_TTL_MS);
    expect(run).not.toHaveBeenCalled();
    const confirmed = await store.confirm(pendingId);
    expect(confirmed.result).toBe('ran:{"leadId":"lead_fake_1","status":"QUALIFIED"}');
    expect(confirmed.entityId).toBe("lead_fake_1");
    expect(run).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(run.mock.calls[0][0])).toBe(true);
    expect(await rejectCode(store.confirm(pendingId))).toBe("consumed");
    expect(() => store.cancel(pendingId)).toThrow(PendingActionError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(changes.map((c) => (c.type === "ended" ? `ended:${c.reason}` : c.type))).toEqual(["created", "ended:confirmed"]);
  });

  it("eşzamanlı iki onaydan yalnızca biri çalışır", async () => {
    const { store, run, create } = setup();
    const { pendingId } = create();
    const results = await Promise.allSettled([store.confirm(pendingId), store.confirm(pendingId)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("bilinmeyen, biçimsiz ya da uydurma kimlik reddedilir", async () => {
    const { store, run, create } = setup();
    create();
    expect(await rejectCode(store.confirm("p_" + "0".repeat(32)))).toBe("unknown");
    expect(await rejectCode(store.confirm("lead_fake_1"))).toBe("unknown");
    expect(await rejectCode(store.confirm(undefined))).toBe("unknown");
    expect(run).not.toHaveBeenCalled();
  });

  it("süre (60 sn) dolunca onay reddedilir, eylem 'expired' ile biter", async () => {
    const { store, run, create, changes, tick } = setup();
    const { pendingId } = create();
    tick(PENDING_TTL_MS - 1);
    expect(store.get()?.pendingId).toBe(pendingId);
    tick(1);
    expect(store.get()).toBeNull();
    expect(await rejectCode(store.confirm(pendingId))).toBe("expired");
    expect(run).not.toHaveBeenCalled();
    expect(changes.at(-1)).toMatchObject({ type: "ended", reason: "expired", entityId: "lead_fake_1" });
  });

  it("zamanlayıcı süre dolumunu kendiliğinden bildirir", () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const store = new PendingActionStore({ now: () => clock });
      const changes: PendingChange[] = [];
      store.onChange((c) => changes.push(c));
      store.create({ tool: "update_alert", risk: "R1", params: {}, summary: "x", run: async () => "ok" });
      clock = PENDING_TTL_MS + 100;
      vi.advanceTimersByTime(PENDING_TTL_MS + 100);
      expect(changes.at(-1)).toMatchObject({ type: "ended", reason: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("parametreler kopyalanır ve derin dondurulur; sonradan değiştirilemez", async () => {
    const { store, run, create } = setup();
    const params = { leadId: "lead_fake_1", nested: { status: "QUALIFIED" }, list: [1, 2] };
    const { pendingId } = create(params);
    // Çağıranın nesnesini değiştirmek bekleyen eylemi etkilemez.
    params.leadId = "lead_other";
    params.nested.status = "LOST";
    params.list.push(3);
    await store.confirm(pendingId);
    const frozen = run.mock.calls[0][0] as { leadId: string; nested: { status: string }; list: number[] };
    expect(frozen).toEqual({ leadId: "lead_fake_1", nested: { status: "QUALIFIED" }, list: [1, 2] });
    expect(() => {
      (frozen as { leadId: string }).leadId = "x";
    }).toThrow(TypeError);
    expect(() => {
      frozen.nested.status = "x";
    }).toThrow(TypeError);
    expect(() => frozen.list.push(9)).toThrow(TypeError);
  });

  it("JSON dışı parametre (fonksiyon, sonsuz sayı, sınıf örneği) reddedilir", () => {
    const { create } = setup();
    expect(() => create({ fn: () => 1 })).toThrow(TypeError);
    expect(() => create({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => create({ d: new Date() })).toThrow(TypeError);
  });

  it("parmak izi içerikle değişir, anahtar sırasıyla değişmez", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(fingerprint(canonicalJson({ a: 1 }))).toBe(fingerprint(canonicalJson({ a: 1 })));
    expect(fingerprint(canonicalJson({ a: 1 }))).not.toBe(fingerprint(canonicalJson({ a: 2 })));
  });

  it("aynı anda tek bekleyen eylem: yenisi eskisinin yerini alır, eski 'replaced' ile biter ve onaylanamaz", async () => {
    const { store, run, create, changes } = setup();
    const first = create({ leadId: "lead_fake_1", status: "QUALIFIED" });
    const second = create({ leadId: "lead_fake_1", status: "CONTACTED" });
    expect(store.get()?.pendingId).toBe(second.pendingId);
    expect(changes.map((c) => (c.type === "ended" ? `ended:${c.reason}` : c.type))).toEqual(["created", "ended:replaced", "created"]);
    expect(await rejectCode(store.confirm(first.pendingId))).toBe("consumed");
    await store.confirm(second.pendingId);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ status: "CONTACTED" });
  });

  it("iptal çalıştırmaz; iptal edilen kimlik sonra onaylanamaz", async () => {
    const { store, run, create } = setup();
    const { pendingId } = create();
    expect(store.cancel(pendingId).view.tool).toBe("update_lead_status");
    expect(await rejectCode(store.confirm(pendingId))).toBe("consumed");
    expect(run).not.toHaveBeenCalled();
  });

  it("ajan yolu yalnızca R1 onaylar: R2/R3 sesle onaylanamaz, beklemeye devam eder", async () => {
    const { store, run, create } = setup();
    for (const risk of ["R2", "R3"] as const) {
      const { pendingId } = create({ campaignId: "cmp_fake_1" }, risk);
      expect(await rejectCode(store.confirm(pendingId))).toBe("not_confirmable");
      expect(await rejectCode(store.confirm(pendingId, { source: "agent" }))).toBe("not_confirmable");
      expect(store.get()?.pendingId).toBe(pendingId);
    }
    expect(run).not.toHaveBeenCalled();
    expect(() => store.create({ tool: "list_campaigns", risk: "R0" as never, params: {}, summary: "", run })).toThrow(TypeError);
  });

  it("Faz 4: R2/R3 ne ajan ne R1 kartıyla onaylanır; yalnızca ekran penceresi (ui) bir kez çalıştırır", async () => {
    const { store, run, create } = setup();
    for (const risk of ["R2", "R3"] as const) {
      const { pendingId } = create({ campaignId: "cmp_fake_1" }, risk);
      for (const source of ["agent", "card"] as const)
        expect(await rejectCode(store.confirm(pendingId, { source })), `${risk}/${source}`).toBe("not_confirmable");
      expect(run).not.toHaveBeenCalled();
      const confirmed = await store.confirm(pendingId, { source: "ui" });
      expect(confirmed.view.risk).toBe(risk);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toEqual({ campaignId: "cmp_fake_1" });
      expect(await rejectCode(store.confirm(pendingId, { source: "ui" }))).toBe("consumed");
      run.mockClear();
    }
    // R1 kartı ve ajan R1'i onaylar.
    const r1 = create();
    await store.confirm(r1.pendingId, { source: "card" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("Faz 4: R2/R3 ekran görünümü zorunlu, dondurulur ve kart görünümünde taşınır; süre riske göre", () => {
    const { store, run, create, changes } = setup();
    expect(() => store.create({ tool: "pause_campaign", risk: "R2", params: {}, summary: "x", run })).toThrow(TypeError);
    expect(() =>
      store.create({ tool: "pause_campaign", risk: "R3", params: {}, summary: "x", confirmation: screenView("R2"), run }),
    ).toThrow(TypeError);
    const r1 = create();
    expect(r1.expiresAt - 1_000).toBe(PENDING_TTL_BY_RISK.R1);
    const r2 = create({ campaignId: "cmp_fake_1" }, "R2");
    expect(r2.expiresAt - 1_000).toBe(PENDING_TTL_BY_RISK.R2);
    expect(PENDING_TTL_BY_RISK.R2).toBe(120_000);
    expect(PENDING_TTL_BY_RISK.R3).toBe(120_000);
    const view = store.get()!;
    expect(view.confirmation).toEqual(screenView("R2"));
    expect(Object.isFrozen(view.confirmation)).toBe(true);
    expect(Object.isFrozen(view.confirmation!.fields[0])).toBe(true);
    expect(changes.at(-1)).toMatchObject({ type: "created", pending: { risk: "R2", confirmation: { title: "Kampanyayı duraklat" } } });
    // Risk başına süre ayarlanabilir.
    const custom = new PendingActionStore<string>({ now: () => 0, timers: false, ttlByRisk: { R3: 90_000 } });
    expect(custom.ttlFor("R3")).toBe(90_000);
    expect(custom.ttlFor("R1")).toBe(PENDING_TTL_MS);
  });

  it("dispose bekleyen eylemi iptal eder", () => {
    const { store, create, changes } = setup();
    create();
    store.dispose();
    expect(store.get()).toBeNull();
    expect(changes.at(-1)).toMatchObject({ type: "ended", reason: "cancelled" });
  });
});

describe("isAffirmativeReply", () => {
  it("açık onaylar (sesli döküm varyasyonları dahil)", () => {
    for (const text of ["evet", "Evet.", "Evet, onaylıyorum.", "onayla", "tamam", "olur", "Yes", "okay, confirm"])
      expect(isAffirmativeReply(text), text).toBe(true);
  });

  it("ret, belirsiz ya da ilgisiz yanıt onay değildir", () => {
    for (const text of ["", "hayır", "evet ama iptal", "onaylamıyorum", "kampanyaları göster", "teşekkürler", "bekle", "no", "evet ".repeat(13)])
      expect(isAffirmativeReply(text), text).toBe(false);
  });
});
