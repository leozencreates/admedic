import { describe, it, expect, vi, beforeEach } from "vitest";
import { decideWinner, generateRecommendations, parseJsonColumn, persistRecommendations } from "./index";
import { prisma } from "@admedic/database";

const { tx } = vi.hoisted(() => ({
  tx: {
    recommendation: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@admedic/database", () => ({
  prisma: {
    studioExperiment: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  },
  RecommendationType: {
    BUDGET_REALLOCATION: "BUDGET_REALLOCATION",
    BUDGET_INCREASE: "BUDGET_INCREASE",
    BUDGET_DECREASE: "BUDGET_DECREASE",
    EXPERIMENT_END: "EXPERIMENT_END",
    WINNER_PROMOTION: "WINNER_PROMOTION",
  },
}));

const findUnique = prisma.studioExperiment.findUnique as ReturnType<typeof vi.fn>;

function experiment(overrides: Record<string, unknown>) {
  return {
    id: "exp-1",
    status: "COMPLETED",
    elapsedDays: 7,
    snapshot: { variants: [{ headline: "V1" }, { headline: "V2" }], duration: 7 },
    metrics: [{ spend: 350, clicks: 1000, leads: 50 }, { spend: 350, clicks: 1000, leads: 110 }],
    draft: { workspace: { currency: "EUR" } },
    ...overrides,
  };
}

describe("parseJsonColumn", () => {
  it("string ise parse eder, nesne ise aynen döner", () => {
    expect(parseJsonColumn<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    const obj = { a: 1 };
    expect(parseJsonColumn(obj)).toBe(obj);
    expect(parseJsonColumn([1, 2])).toEqual([1, 2]);
  });
});

describe("decideWinner", () => {
  it("CPL'e göre karar verir; lead sayısı tek başına yetmez", () => {
    // B daha çok lead üretir ama CPL'i A'dan yüksek → A kazanır
    const d = decideWinner({ spend: 100, clicks: 500, leads: 20 }, { spend: 300, clicks: 900, leads: 30 });
    expect(d.winner).toBe("A");
    expect(d.reason).toBe("DECISIVE");
    expect(d.edge).toBeCloseTo(0.5, 5);
  });
  it("kazananda 10 lead yoksa veya fark %20 altındaysa belirsiz", () => {
    expect(decideWinner({ spend: 50, clicks: 100, leads: 5 }, { spend: 90, clicks: 100, leads: 6 }).reason).toBe("INSUFFICIENT_LEADS");
    expect(decideWinner({ spend: 100, clicks: 100, leads: 20 }, { spend: 110, clicks: 100, leads: 20 }).reason).toBe("EDGE_TOO_SMALL");
    expect(decideWinner({ spend: 0, clicks: 0, leads: 0 }, { spend: 0, clicks: 0, leads: 0 }).reason).toBe("NO_LEADS");
  });
  it("kaybedende lead yoksa ve kazananda ≥10 lead varsa kesin kazanan", () => {
    const d = decideWinner({ spend: 100, clicks: 100, leads: 0 }, { spend: 100, clicks: 100, leads: 12 });
    expect(d.winner).toBe("B");
    expect(d.edge).toBe(1);
  });
});

describe("recommendation engine", () => {
  beforeEach(() => {
    findUnique.mockReset();
    tx.recommendation.updateMany.mockReset().mockResolvedValue({ count: 0 });
    tx.recommendation.create.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "db-1", ...data }));
  });

  it("kesin kazanan için PENDING bütçe yeniden dağıtımı üretir (Json sütunu nesne)", async () => {
    findUnique.mockResolvedValue(experiment({}));
    const recs = await generateRecommendations({ experimentId: "exp-1", workspaceId: "ws-1" });
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe("BUDGET_REALLOCATION");
    expect(recs[0].status).toBe("PENDING");
    expect(recs[0].priority).toBe("HIGH");
    expect(recs[0].action).toMatchObject({ type: "BUDGET_REALLOCATION", variantWinner: "B", budgetSplit: [70, 30] });
    expect(recs[0].reasoning).toContain("elle girilen ölçüm");
    expect(recs[0].reasoning).toContain("%55");
    expect(recs[0].reasoning).not.toContain("Gerçek Meta");
    expect(recs[0].expectedImpact).toMatchObject({ currency: "EUR" });
    expect((recs[0].expectedImpact as { estimatedAdditionalLeads: number }).estimatedAdditionalLeads).toBe(60); // 350 / 3.18 − 50
  });

  it("string olarak saklanmış Json sütunlarını da okur", async () => {
    findUnique.mockResolvedValue(experiment({
      snapshot: JSON.stringify({ variants: [{ headline: "V1" }, { headline: "V2" }], duration: 7 }),
      metrics: JSON.stringify([{ spend: 350, clicks: 1000, leads: 50 }, { spend: 350, clicks: 1000, leads: 110 }]),
    }));
    const recs = await generateRecommendations({ experimentId: "exp-1", workspaceId: "ws-1" });
    expect(recs[0].type).toBe("BUDGET_REALLOCATION");
    expect(recs[0].title).toContain("V2");
  });

  it("belirsiz sonuçta CONTINUE önerisi üretir (bütçe değişikliği yok)", async () => {
    findUnique.mockResolvedValue(experiment({
      metrics: [{ spend: 100, clicks: 400, leads: 20 }, { spend: 110, clicks: 400, leads: 20 }],
    }));
    const recs = await generateRecommendations({ experimentId: "exp-1", workspaceId: "ws-1" });
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe("CONTINUE");
    expect(recs[0].priority).toBe("LOW");
    expect(recs[0].action).toEqual({ type: "CONTINUE" });
    expect(recs[0].reasoning).toContain("%9");
  });

  it("yetersiz lead'de de CONTINUE üretir", async () => {
    findUnique.mockResolvedValue(experiment({
      metrics: [{ spend: 20, clicks: 100, leads: 2 }, { spend: 80, clicks: 100, leads: 5 }],
    }));
    const recs = await generateRecommendations({ experimentId: "exp-1", workspaceId: "ws-1" });
    expect(recs[0].type).toBe("CONTINUE");
    expect(recs[0].reasoning).toContain("10 lead eşiği");
  });

  it("lead yoksa deney-sonu önerisi üretir", async () => {
    findUnique.mockResolvedValue(experiment({
      metrics: [{ spend: 350, clicks: 1000, leads: 0 }, { spend: 350, clicks: 1000, leads: 0 }],
    }));
    const recs = await generateRecommendations({ experimentId: "exp-2", workspaceId: "ws-1" });
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe("EXPERIMENT_END");
    expect(recs[0].status).toBe("PENDING");
    expect(recs[0].priority).toBe("MEDIUM");
  });

  it("tamamlanmamış deney için boş döner", async () => {
    findUnique.mockResolvedValue(experiment({ status: "DRAFT", snapshot: {}, metrics: [] }));
    expect(await generateRecommendations({ experimentId: "exp-3", workspaceId: "ws-1" })).toHaveLength(0);
  });

  it("persistRecommendations açık eskileri EXPIRED yapar, yenileri PENDING kaydeder, CONTINUE'yu DB türüne eşler", async () => {
    findUnique.mockResolvedValue(experiment({
      metrics: [{ spend: 100, clicks: 400, leads: 20 }, { spend: 110, clicks: 400, leads: 20 }],
    }));
    const recs = await generateRecommendations({ experimentId: "exp-1", workspaceId: "ws-1" });
    const saved = await persistRecommendations("exp-1", recs, { workspaceId: "ws-1", userId: "u1" });
    expect(tx.recommendation.updateMany).toHaveBeenCalledWith({
      where: { experimentId: "exp-1", workspaceId: "ws-1", status: { in: ["DRAFT", "PENDING", "APPROVED"] } },
      data: { status: "EXPIRED" },
    });
    const data = tx.recommendation.create.mock.calls[0]![0].data;
    expect(data.status).toBe("PENDING");
    expect(data.type).toBe("EXPERIMENT_END"); // enum'da CONTINUE yok → fallback; gerçek tür action.type
    expect(data.action).toEqual({ type: "CONTINUE" });
    expect(saved[0].id).toBe("db-1");
    expect(saved[0].type).toBe("CONTINUE");
  });
});
