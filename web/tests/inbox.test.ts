import { describe, expect, it } from "vitest";
import { inboxState } from "../app/_lib/inbox";
import { inTab, sortForTab, tabCounts } from "../app/_lib/inbox-view";
import { replyWindow } from "../app/_lib/messaging-window";

const t0 = new Date("2026-09-28T08:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const opts = { actorId: "me", canReadContent: true, names: new Map([["me", "Ben"], ["ayse", "Ayşe"]]) };
type Conv = Parameters<typeof inboxState>[1][number];
const conv = (c: Partial<Conv> & { status: string }): Conv =>
  ({ escalatedTo: null, escalatedAt: null, createdAt: t0, messages: [], _count: { messages: 0 }, ...c }) as Conv;
const msg = (direction: "INCOMING" | "OUTGOING", min: number, sender: string | null = null, content = "Merhaba") => ({
  content, direction, sender, createdAt: at(min),
});

describe("gelen kutusu: yanıt bekliyor kuralı (ADR-0019)", () => {
  it("asistan devretti, kimse devralmadı → yanıt bekliyor (devir anından beri)", () => {
    const s = inboxState({ status: "NEW", createdAt: t0 }, [conv({ status: "ESCALATED", escalatedAt: at(5), messages: [msg("INCOMING", 4)] })], opts);
    expect(s).toMatchObject({ handedOff: true, needsReply: true, waitingSince: at(5).toISOString(), claimedBy: null });
  });
  it("devralınmış konuşmada son mesaj hastadansa yanıt bekliyor; ekiptense beklemiyor", () => {
    const waiting = inboxState({ status: "CONTACTED", createdAt: t0 }, [conv({ status: "ESCALATED", escalatedTo: "ayse", messages: [msg("INCOMING", 30)] })], opts);
    expect(waiting).toMatchObject({ needsReply: true, claimedBy: "Ayşe", claimedByMe: false, waitingSince: at(30).toISOString() });
    const answered = inboxState({ status: "CONTACTED", createdAt: t0 }, [conv({ status: "ESCALATED", escalatedTo: "me", messages: [msg("OUTGOING", 31, "me")] })], opts);
    expect(answered).toMatchObject({ needsReply: false, claimedBy: "Ben", claimedByMe: true });
  });
  it("asistanın yürüttüğü konuşma bir insan beklemez", () => {
    const s = inboxState({ status: "NEW", createdAt: t0 }, [conv({ status: "ACTIVE", messages: [msg("INCOMING", 2)] })], opts);
    expect(s.needsReply).toBe(false);
    expect(s.conversationStatus).toBe("ACTIVE");
  });
  it("konuşması olmayan yeni lead (Anında Form) yanıt bekler; tedavi edilen / kaybedilen beklemez", () => {
    expect(inboxState({ status: "NEW", createdAt: t0 }, [], opts)).toMatchObject({ needsReply: true, waitingSince: t0.toISOString(), lastMessage: null });
    expect(inboxState({ status: "LOST", createdAt: t0 }, [conv({ status: "ESCALATED" })], opts).needsReply).toBe(false);
    expect(inboxState({ status: "TREATED", createdAt: t0 }, [], opts).needsReply).toBe(false);
  });
  it("son mesaj önizlemesi kısaltılır; bakım rolü olmayana gösterilmez", () => {
    const long = "a".repeat(200);
    const convs = [conv({ status: "ESCALATED", escalatedTo: "me", messages: [msg("OUTGOING", 3, "ai", long)] })];
    const s = inboxState({ status: "CONTACTED", createdAt: t0 }, convs, opts);
    expect(s.lastMessage).toMatchObject({ party: "assistant", direction: "OUTGOING" });
    expect(s.lastMessage!.preview!.length).toBe(140);
    expect(inboxState({ status: "CONTACTED", createdAt: t0 }, convs, { ...opts, canReadContent: false }).lastMessage!.preview).toBeNull();
  });
});

describe("gelen kutusu sekmeleri", () => {
  const lead = (id: string, created: number, inbox: Partial<ReturnType<typeof inboxState>> | null) => ({
    id,
    created: at(created).toISOString(),
    inbox: inbox ? ({ conversationStatus: null, handedOff: false, claimedBy: null, claimedByMe: false, lastMessage: null, needsReply: false, waitingSince: null, ...inbox } as ReturnType<typeof inboxState>) : null,
  });
  const leads = [
    lead("a", 0, { needsReply: true, waitingSince: at(50).toISOString() }),
    lead("b", 1, { needsReply: true, waitingSince: at(10).toISOString(), claimedBy: "Ayşe" }),
    lead("c", 2, { claimedBy: "Ben", lastMessage: { at: at(90).toISOString(), direction: "OUTGOING", party: "team", preview: null } }),
    lead("d", 3, null),
  ];
  it("sayılar ve üyelik", () => {
    expect(tabCounts(leads)).toEqual({ waiting: 2, claimed: 2, all: 4 });
    expect(leads.filter((l) => inTab(l, "claimed")).map((l) => l.id)).toEqual(["b", "c"]);
  });
  it("yanıt bekleyen: en uzun bekleyen önce; diğerleri: en son hareket önce", () => {
    expect(sortForTab(leads.filter((l) => inTab(l, "waiting")), "waiting").map((l) => l.id)).toEqual(["b", "a"]);
    expect(sortForTab(leads, "all").map((l) => l.id)).toEqual(["c", "d", "b", "a"]);
  });
});

describe("24 saatlik yanıt penceresi", () => {
  it("hasta mesajı yoksa kapalı; 24 saat içinde açık; sonra kapalı", () => {
    expect(replyWindow(null)).toEqual({ lastInboundAt: null, endsAt: null, open: false });
    expect(replyWindow(t0, at(60 * 23)).open).toBe(true);
    expect(replyWindow(t0, at(60 * 24 + 1))).toMatchObject({ open: false, endsAt: at(60 * 24).toISOString() });
  });
});
