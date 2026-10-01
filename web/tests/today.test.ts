import { describe, expect, it } from "vitest";
import { scopePendingApprovals, type PendingApprovalItem, type PendingApprovals } from "../app/_lib/pending-approvals";
import { formatDuration } from "../app/_lib/format";

const item = (kind: PendingApprovalItem["kind"], id: string, submittedById: string | null): PendingApprovalItem => ({
  kind, id, title: id, detail: null, submittedBy: null, submittedByLabel: "Gönderen",
  waitingSince: new Date(0), createdAt: new Date(0), updatedAt: new Date(0), actors: "", href: "/", submittedById,
});
const data: PendingApprovals = {
  counts: { total: 7, byKind: { CONTENT: 2, CAMPAIGN: 1, ACTIVATION: 2, RECOMMENDATION: 1, LEAD_PROPOSAL: 1 } },
  items: {
    CONTENT: [item("CONTENT", "c-me", "me"), item("CONTENT", "c-other", "other")],
    CAMPAIGN: [item("CAMPAIGN", "k-other", "other")],
    ACTIVATION: [item("ACTIVATION", "a-me", "me"), item("ACTIVATION", "a-other", "other")],
    RECOMMENDATION: [item("RECOMMENDATION", "r", null)],
    LEAD_PROPOSAL: [item("LEAD_PROPOSAL", "l-me", "me")],
  },
};

describe("Onaylar kapsamı (ADR-0018)", () => {
  it("hesap sahibi ve yönetici tüm işleri görür", () => {
    expect(scopePendingApprovals(data, { userId: "x", role: "OWNER" }, { canApproveSpend: true })).toBe(data);
    expect(scopePendingApprovals(data, { userId: "x", role: "ADMIN" }, { canApproveSpend: false })).toBe(data);
  });
  it("reklam uzmanı yalnızca kendi gönderdiklerini görür; öneri görmez", () => {
    const scoped = scopePendingApprovals(data, { userId: "me", role: "MEDIA_BUYER" }, { canApproveSpend: false });
    expect(scoped.items.CONTENT.map((i) => i.id)).toEqual(["c-me"]);
    expect(scoped.items.CAMPAIGN).toEqual([]);
    expect(scoped.items.ACTIVATION.map((i) => i.id)).toEqual(["a-me"]);
    expect(scoped.items.RECOMMENDATION).toEqual([]);
    // Lead takımı önerisini yalnızca hesap sahibi ve yönetici onaylar; takımı kendisi çalıştırmış olsa da kutusuna düşmez.
    expect(scoped.items.LEAD_PROPOSAL).toEqual([]);
    expect(scoped.counts.total).toBe(2);
  });
  it("harcama yetkisi olan reklam uzmanı tüm etkinleştirmeleri görür", () => {
    const scoped = scopePendingApprovals(data, { userId: "me", role: "MEDIA_BUYER" }, { canApproveSpend: true });
    expect(scoped.items.ACTIVATION).toHaveLength(2);
    expect(scoped.counts.byKind.ACTIVATION).toBe(2);
  });
});

describe("süre biçimi (tek biçimleyici: bekleme, kalan süre, ilk yanıt)", () => {
  it("dakika, saat ve gün; aşağı yuvarlar", () => {
    expect(formatDuration(20_000)).toBe("1 dk'dan az");
    expect(formatDuration(12 * 60_000 + 59_000)).toBe("12 dk");
    expect(formatDuration(90 * 60_000)).toBe("1 sa 30 dk");
    expect(formatDuration(3 * 3600_000)).toBe("3 sa");
    expect(formatDuration(23 * 3600_000 + 59 * 60_000)).toBe("23 sa 59 dk");
    expect(formatDuration(72 * 3600_000)).toBe("3 gün");
  });
  it("geçersiz ya da negatif süre", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});
