import { describe, it, expect } from "vitest";
import { handoffView, messageParty, parseTemplateParams, systemNoteText } from "../app/_components/lead-chat";
import { filterLeads, toLead } from "../app/_components/lead-table";

const now = new Date("2026-09-28T12:00:00Z");
const conv = (over: Record<string, unknown>) => ({ id: "c1", channel: "WHATSAPP", status: "ESCALATED", ...over });

describe("lead chat helpers", () => {
  it("maps senders to parties", () => {
    expect(messageParty({ direction: "INCOMING", sender: "external" })).toBe("lead");
    expect(messageParty({ direction: "OUTGOING", sender: "ai" })).toBe("assistant");
    expect(messageParty({ direction: "OUTGOING", sender: null })).toBe("assistant");
    expect(messageParty({ direction: "OUTGOING", sender: "system" })).toBe("system");
    expect(messageParty({ direction: "OUTGOING", sender: "cmuser123" })).toBe("team");
  });

  it("strips the legacy warning sign from system notes", () => {
    expect(systemNoteText("⚠ Konuşma Ayşe tarafından devralındı.")).toBe("Konuşma Ayşe tarafından devralındı.");
    expect(systemNoteText("⚠️  Not")).toBe("Not");
    expect(systemNoteText("Konuşma devralındı.")).toBe("Konuşma devralındı.");
  });

  it("parses comma separated template variables", () => {
    expect(parseTemplateParams(" Ayşe , 12:00,, ")).toEqual({ "1": "Ayşe", "2": "12:00" });
  });

  it("tells an unclaimed assistant handoff apart from a claimed one", () => {
    expect(handoffView(undefined, now)).toEqual({ kind: "none" });
    expect(handoffView(conv({ status: "ACTIVE" }), now)).toEqual({ kind: "active", text: "Karşılama asistanı yanıtlıyor." });
    expect(handoffView(conv({ status: "CLOSED" }), now).kind).toBe("closed");
    expect(handoffView(conv({ escalatedTo: null, escalatedAt: "2026-09-28T11:18:00Z" }), now)).toEqual({
      kind: "unclaimed",
      text: "Asistan konuşmayı 42 dk önce devretti; henüz kimse devralmadı.",
    });
    expect(handoffView(conv({ escalatedTo: null, escalatedAt: "2026-09-10T09:00:00Z" }), now)).toMatchObject({
      text: "Asistan konuşmayı 10 Eyl 2026 tarihinde devretti; henüz kimse devralmadı.",
    });
    expect(handoffView(conv({ escalatedTo: null, escalatedAt: null }), now)).toMatchObject({
      text: "Asistan konuşmayı devretti; henüz kimse devralmadı.",
    });
    expect(handoffView(conv({ escalatedTo: "u1", escalatedToIsMe: true }), now)).toEqual({
      kind: "claimed",
      text: "Konuşmayı siz devraldınız.",
    });
    expect(handoffView(conv({ escalatedTo: "u2", escalatedToName: "Ayşe Koordinatör" }), now)).toMatchObject({
      text: "Ayşe Koordinatör devraldı; asistan susturuldu.",
    });
    expect(handoffView(conv({ escalatedTo: "u3", escalatedToName: null }), now)).toMatchObject({
      text: "Bir ekip üyesi devraldı; asistan susturuldu.",
    });
  });
});

describe("lead table filter", () => {
  const leads = [
    toLead({ id: "1", firstName: "İlkay", lastName: "Demir", email: "ilkay@example.invalid", phone: "+905321112233", status: "NEW" }),
    toLead({ id: "2", firstName: "Anna", lastName: "Schmidt", email: "anna@example.invalid", status: "CONTACTED" }),
  ];
  it("matches name case-insensitively in Turkish, e-mail and phone, and filters by status", () => {
    expect(filterLeads(leads, "ilkay", "").map((l) => l.id)).toEqual(["1"]);
    expect(filterLeads(leads, "  ANNA@ ", "").map((l) => l.id)).toEqual(["2"]);
    expect(filterLeads(leads, "53211", "").map((l) => l.id)).toEqual(["1"]);
    expect(filterLeads(leads, "", "CONTACTED").map((l) => l.id)).toEqual(["2"]);
    expect(filterLeads(leads, "anna", "NEW")).toEqual([]);
  });
});
