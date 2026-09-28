import { beforeEach, describe, expect, it, vi } from "vitest";

// Saf eşleme mantığının testi: veritabanı yerine sahte Prisma istemcisi (yalnızca kullanılan modeller).
// `agentDecision` bilerek yok: onay işi ajan kararlarını okursa test hata verir.
const db = vi.hoisted(() => ({
  studioDraft: { count: vi.fn(), findMany: vi.fn() },
  campaign: { count: vi.fn(), findMany: vi.fn() },
  recommendation: { count: vi.fn(), findMany: vi.fn() },
  auditLog: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  adSet: { findMany: vi.fn() },
  ad: { findMany: vi.fn() },
  studioExperiment: { findMany: vi.fn() },
  conversation: { findMany: vi.fn() },
}));
vi.mock("@admedic/database", () => ({ prisma: db, Prisma: {} }));

import {
  APPROVER_LABEL,
  SPEND_AUTHORITY_LABEL,
  countPendingApprovals,
  listPendingApprovals,
} from "../app/_lib/pending-approvals";
import { alertRecordLinks, targetKey, targetNames } from "../app/_lib/record-refs";

const WS = "ws-1";
const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h));
type Where = { id?: { in?: string[] }; workspaceId?: string; workflowStatus?: string; draft?: { workspaceId?: string } };
/** Sahte findMany: çalışma alanı ve `id: { in }` filtresi uygulanır. */
const rowsOf = <T extends { id: string; ws?: string }>(rows: T[]) =>
  (args: { where: Where }) =>
    Promise.resolve(
      rows.filter(
        (r) =>
          (!args.where.id?.in || args.where.id.in.includes(r.id)) &&
          (r.ws ?? WS) === (args.where.workspaceId ?? args.where.draft?.workspaceId),
      ),
    );

beforeEach(() => {
  for (const model of Object.values(db)) for (const fn of Object.values(model)) fn.mockReset();
});

describe("onay etiketleri", () => {
  it("yetki metinleri API kurallarıyla aynı", () => {
    expect(APPROVER_LABEL).toBe("Hesap sahibi veya Yönetici");
    expect(SPEND_AUTHORITY_LABEL).toBe("Harcama yetkisi olanlar");
  });
});

describe("countPendingApprovals", () => {
  it("içerik, kampanya onayı, etkinleştirme ve bütçe önerisini sayar (ajan kararları hariç)", async () => {
    db.studioDraft.count.mockResolvedValue(1);
    db.campaign.count.mockImplementation(({ where }: { where: Where }) =>
      Promise.resolve(where.workflowStatus === "IN_REVIEW" ? 2 : where.workflowStatus === "PUBLISHED_PAUSED" ? 3 : 99),
    );
    db.recommendation.count.mockResolvedValue(4);
    const counts = await countPendingApprovals(WS);
    expect(counts).toEqual({ total: 10, byKind: { CONTENT: 1, CAMPAIGN: 2, ACTIVATION: 3, RECOMMENDATION: 4 } });
    expect(db.studioDraft.count).toHaveBeenCalledWith({ where: { workspaceId: WS, status: "IN_REVIEW" } });
    expect(db.recommendation.count).toHaveBeenCalledWith({ where: { workspaceId: WS, status: "PENDING" } });
  });
});

describe("listPendingApprovals", () => {
  it("gönderen, bekleme başlangıcı, yetki ve bağlantıyı denetim kaydından üretir; en uzun bekleyen önce", async () => {
    db.studioDraft.count.mockResolvedValue(2);
    db.campaign.count.mockImplementation(({ where }: { where: Where }) =>
      Promise.resolve(where.workflowStatus === "IN_REVIEW" ? 1 : 2),
    );
    db.recommendation.count.mockResolvedValue(2);
    db.studioDraft.findMany.mockResolvedValue([
      { id: "d1", name: "İngiltere — Rinoplasti (EN)", policy: { risk: "MEDIUM" }, createdAt: at(0), updatedAt: at(7) },
      { id: "d2", name: "Almanya — Saç ekimi (DE)", policy: {}, createdAt: at(0), updatedAt: at(1) },
    ]);
    db.campaign.findMany.mockImplementation(({ where }: { where: Where }) =>
      Promise.resolve(
        where.workflowStatus === "IN_REVIEW"
          ? [{ id: "c1", name: "Kampanya A", dailyBudget: 5000, policyRisk: "LOW", createdAt: at(0), updatedAt: at(9), adAccount: { currency: "EUR" } }]
          : [
              { id: "c2", name: "Kampanya B", dailyBudget: 12000, policyRisk: null, createdAt: at(0), updatedAt: at(9), adAccount: { currency: "EUR" } },
              { id: "c3", name: "Kampanya C", dailyBudget: null, policyRisk: null, createdAt: at(0), updatedAt: at(2), adAccount: null },
            ],
      ),
    );
    db.recommendation.findMany.mockResolvedValue([
      { id: "r1", type: "BUDGET_REALLOCATION", action: {}, title: "Öneri 1", priority: "HIGH", experimentId: "e1", createdAt: at(2), updatedAt: at(2) },
      { id: "r2", type: "EXPERIMENT_END", action: { type: "CONTINUE" }, title: "Öneri 2", priority: "LOW", experimentId: "e1", createdAt: at(1), updatedAt: at(5) },
    ]);
    // Sorgu yeniden eskiye sıralı döner; her kayıt için en yeni denetim satırı geçerlidir.
    db.auditLog.findMany.mockResolvedValue([
      { action: "DRAFT_SUBMIT", entityType: "STUDIO_DRAFT", entityId: "d1", userId: "u1", after: {}, createdAt: at(6) },
      { action: "RECOMMENDATION_UPDATED", entityType: "RECOMMENDATION", entityId: "r2", userId: "u2", after: { status: "PENDING" }, createdAt: at(5) },
      { action: "CAMPAIGN_PAUSED", entityType: "CAMPAIGN", entityId: "c2", userId: "u2", after: {}, createdAt: at(4) },
      { action: "CAMPAIGN_SUBMITTED", entityType: "CAMPAIGN", entityId: "c1", userId: "u1", after: {}, createdAt: at(3) },
      { action: "RECOMMENDATIONS_GENERATED", entityType: "STUDIO_EXPERIMENT", entityId: "e1", userId: "u1", after: { recommendations: [{ id: "r1" }, { id: "r2" }] }, createdAt: at(1) },
      { action: "CAMPAIGN_PUBLISHED", entityType: "CAMPAIGN", entityId: "c2", userId: "u1", after: {}, createdAt: at(1) },
      { action: "DRAFT_SUBMIT", entityType: "STUDIO_DRAFT", entityId: "d1", userId: "u2", after: {}, createdAt: at(0) },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u1", name: "Ayşe Yılmaz", email: "ayse@example.invalid" },
      { id: "u2", name: null, email: "mehmet@example.invalid" },
    ]);

    const { counts, items } = await listPendingApprovals(WS);
    expect(counts.total).toBe(7);

    // Denetim sorgusu çalışma alanıyla sınırlı ve yalnızca listelenen kayıtları kapsar.
    const auditArgs = db.auditLog.findMany.mock.calls[0][0] as { where: { workspaceId: string; OR: unknown[] } };
    expect(auditArgs.where.workspaceId).toBe(WS);
    expect(auditArgs.where.OR).toHaveLength(5);

    expect(items.CONTENT.map((i) => i.id)).toEqual(["d2", "d1"]);
    expect(items.CONTENT[1]).toMatchObject({
      title: "İngiltere — Rinoplasti (EN)",
      detail: "İçerik kontrolü: orta risk",
      submittedBy: "Ayşe Yılmaz",
      submittedByLabel: "Gönderen",
      waitingSince: at(6),
      actors: "Hesap sahibi veya Yönetici",
      href: "/studio?id=d1",
    });
    // Denetim kaydı yoksa gönderen bilinmez; bekleme son güncellemeden başlar.
    expect(items.CONTENT[0]).toMatchObject({ submittedBy: null, waitingSince: at(1), detail: null });

    expect(items.CAMPAIGN[0]).toMatchObject({
      detail: "Günlük bütçe: €50 · İçerik kontrolü: düşük risk",
      submittedBy: "Ayşe Yılmaz",
      waitingSince: at(3),
      actors: "Hesap sahibi veya Yönetici",
      href: "/campaigns/c1",
    });

    expect(items.ACTIVATION.map((i) => i.id)).toEqual(["c3", "c2"]);
    expect(items.ACTIVATION[1]).toMatchObject({
      submittedBy: "mehmet@example.invalid",
      submittedByLabel: "Duraklatan",
      waitingSince: at(4),
      detail: "Etkinleştirilince günlük €120 harcama başlar.",
      actors: "Harcama yetkisi olanlar",
      href: "/campaigns/c2",
    });
    expect(items.ACTIVATION[0]).toMatchObject({
      submittedBy: null,
      submittedByLabel: "Meta'ya yükleyen",
      waitingSince: at(2),
      detail: "Etkinleştirilince harcama başlar.",
    });

    expect(items.RECOMMENDATION.map((i) => i.id)).toEqual(["r1", "r2"]);
    expect(items.RECOMMENDATION[0]).toMatchObject({
      submittedBy: "Ayşe Yılmaz",
      submittedByLabel: "Oluşturan",
      waitingSince: at(2),
      detail: "Bütçe yeniden dağıtımı · Yüksek öncelik",
      href: "/recommendations",
    });
    expect(items.RECOMMENDATION[1]).toMatchObject({
      submittedBy: "mehmet@example.invalid",
      submittedByLabel: "Onaya gönderen",
      waitingSince: at(5),
      detail: "Deneye devam (sonuç belirsiz) · Düşük öncelik",
    });
  });

  it("bekleyen iş yoksa denetim ve kullanıcı sorgusu yapılmaz", async () => {
    db.studioDraft.count.mockResolvedValue(0);
    db.campaign.count.mockResolvedValue(0);
    db.recommendation.count.mockResolvedValue(0);
    db.studioDraft.findMany.mockResolvedValue([]);
    db.campaign.findMany.mockResolvedValue([]);
    db.recommendation.findMany.mockResolvedValue([]);
    const { counts, items } = await listPendingApprovals(WS);
    expect(counts.total).toBe(0);
    expect(Object.values(items).every((list) => list.length === 0)).toBe(true);
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

describe("alertRecordLinks", () => {
  it("uyarıyı çalışma alanındaki ilgili kayda bağlar; bulunamayan kayda bağlantı vermez", async () => {
    db.campaign.findMany.mockImplementation(rowsOf([{ id: "c1" }, { id: "cForeign", ws: "ws-2" }]));
    db.adSet.findMany.mockImplementation(rowsOf([{ id: "s1", campaignId: "c8" }]));
    db.ad.findMany.mockImplementation(rowsOf([{ id: "ad1", adSet: { campaignId: "c9" } }]));
    db.studioExperiment.findMany.mockImplementation(rowsOf([{ id: "e1" }]));
    db.conversation.findMany.mockImplementation(rowsOf([{ id: "v1", leadId: "L1" }]));

    const links = await alertRecordLinks(WS, [
      { id: "a1", entityType: "CAMPAIGN", entityId: "c1" },
      { id: "a2", entityType: "CAMPAIGN", entityId: "missing" },
      { id: "a3", entityType: "AD", entityId: "ad1" },
      { id: "a4", entityType: "ADSET", entityId: "s1" },
      { id: "a5", entityType: "experiment", entityId: "e1" },
      { id: "a6", entityType: "CONVERSATION", entityId: "v1" },
      { id: "a7", entityType: "META_CONNECTION", entityId: "m1" },
      { id: "a8", entityType: "ACCOUNT", entityId: "c1" },
      { id: "a9", entityType: null, entityId: null },
      { id: "a10", entityType: "CAMPAIGN", entityId: "cForeign" },
    ]);
    expect(Object.fromEntries(links)).toEqual({
      a1: "/campaigns/c1",
      a3: "/campaigns/c9",
      a4: "/campaigns/c8",
      a5: "/tests/e1",
      a6: "/leads/L1",
      a7: "/meta-connections",
    });
  });

  it("referans yoksa veritabanına gitmez", async () => {
    const links = await alertRecordLinks(WS, [{ id: "a1", entityType: null, entityId: null }]);
    expect(links.size).toBe(0);
    expect(db.campaign.findMany).not.toHaveBeenCalled();
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });
});

describe("targetNames", () => {
  it("kampanya, reklam seti ve reklam adlarını türüyle eşler; bulunamayanı atlar", async () => {
    db.campaign.findMany.mockImplementation(rowsOf([{ id: "c1", name: "Kampanya A" }]));
    db.ad.findMany.mockImplementation(rowsOf([{ id: "x1", name: "Reklam 1" }]));
    const names = await targetNames(WS, [
      { targetType: "CAMPAIGN", targetId: "c1" },
      { targetType: "AD", targetId: "x1" },
      { targetType: "AD", targetId: "gone" },
      { targetType: "CAMPAIGN", targetId: "c1" },
    ]);
    expect(names.get(targetKey("CAMPAIGN", "c1"))).toBe("Kampanya A");
    expect(names.get(targetKey("AD", "x1"))).toBe("Reklam 1");
    expect(names.has(targetKey("AD", "gone"))).toBe(false);
    // Aynı kimlik farklı türde eşleşmez (kampanya c1 ≠ reklam c1).
    expect(names.has(targetKey("AD", "c1"))).toBe(false);
    expect(db.adSet.findMany).not.toHaveBeenCalled();
    expect(db.campaign.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, id: { in: ["c1"] } },
      select: { id: true, name: true },
    });
  });
});
