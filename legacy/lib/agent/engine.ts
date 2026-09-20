import {
  computeVariantStat,
  probabilityLatestWins,
  type VariantStatInput,
} from "./statistics";

export interface EngineVariantInput {
  variantId: string;
  metaAdSetId: string | null;
  name: string;
  currentBudgetKurus: number;
  initialBudgetKurus: number;
  active: boolean;
  points: VariantStatInput[];
}

export interface EngineConfig {
  minSpendKurusPerVariant: number; // bütçe kaydırmaya başlamak için gereken minimum harcama
  minConversionsPerVariant: number;
  significanceLevel: number; // kazanan seçmek için gereken olasılık (örn 0.95)
  explorationThreshold: number; // bunun altında küçük kaydırma
  shiftStepRatio: number; // her döngüde taşınan toplam bütçe oranı (örn 0.15)
  uncertaintyShiftRatio: number; // belirsizlik aralığında taşınan oran (örn 0.30)
  minRoasGap: number; // kazanan için gereken minimum ROAS farkı (örn 0.05)
  floorBudgetRatio: number; // aktif ad setin alt bütçe sınırı (orijinalin oranı)
  minFloorBudgetKurus: number;
  winnerShareRatio: number; // kazanan seçilince verilecek pay (örn 0.9)
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  minSpendKurusPerVariant: 100_000, // 1000 TL
  minConversionsPerVariant: 3,
  significanceLevel: 0.95,
  explorationThreshold: 0.8,
  shiftStepRatio: 0.15,
  uncertaintyShiftRatio: 0.3,
  minRoasGap: 0.05,
  floorBudgetRatio: 0.1,
  minFloorBudgetKurus: 50_000, // 500 TL
  winnerShareRatio: 0.9,
};

export type AgentDecision =
  | {
      action: "NEEDS_MORE_DATA";
      detail: string;
      severity: "INFO" | "WARNING";
      stats: DecisionStat[];
    }
  | {
      action: "BUDGET_SHIFT";
      detail: string;
      severity: "INFO";
      stats: DecisionStat[];
      budgetUpdates: { variantId: string; newBudgetKurus: number }[];
      probability: number;
      winnerVariantId: string;
    }
  | {
      action: "WINNER_SELECTED";
      detail: string;
      severity: "INFO";
      stats: DecisionStat[];
      winningVariantId: string;
      budgetUpdates: { variantId: string; newBudgetKurus: number }[];
      probability: number;
    };

export interface DecisionStat {
  variantId: string;
  name: string;
  roas: number;
  spendKurus: number;
  revenueKurus: number;
  conversions: number;
  dailyPoints: number;
  currentBudgetKurus: number;
}

export function runAgentCycle(
  variants: EngineVariantInput[],
  config: EngineConfig = DEFAULT_ENGINE_CONFIG
): AgentDecision {
  const active = variants.filter((v) => v.active);
  const stats = new Map<string, DecisionStat>();

  for (const v of active) {
    const s = computeVariantStat(v.points);
    stats.set(v.variantId, {
      variantId: v.variantId,
      name: v.name,
      roas: s.roas,
      spendKurus: s.spendKurus,
      revenueKurus: s.revenueKurus,
      conversions: s.conversions,
      dailyPoints: s.dailyRoas.length,
      currentBudgetKurus: v.currentBudgetKurus,
    });
  }

  if (active.length < 2) {
    return {
      action: "NEEDS_MORE_DATA",
      detail: "En az iki aktif varyant gerekli.",
      severity: "WARNING",
      stats: [...stats.values()],
    };
  }

  const statList = [...stats.values()];

  // Veri kalitesi kontrolü: sıfır harcama / gün verisi olan varyantları işaretle
  const noData = statList.filter(
    (s) => s.spendKurus === 0 || s.dailyPoints === 0
  );
  if (noData.length > 0) {
    return {
      action: "NEEDS_MORE_DATA",
      detail: `Bazı varyantlar için henüz veri yok: ${noData
        .map((s) => s.name)
        .join(", ")}. Meta'dan insight bekleniyor.`,
      severity: "WARNING",
      stats: statList,
    };
  }

  const totalDailyBudget = statList.reduce((a, s) => a + s.currentBudgetKurus, 0);
  const belowMinSpend = statList.filter(
    (s) => s.spendKurus < config.minSpendKurusPerVariant
  );
  const belowMinConv = statList.filter(
    (s) => s.conversions < config.minConversionsPerVariant
  );

  // Faz 1 — Veri toplama: varyantlar eşit bütçeye çekilir, kaydırma yok
  if (belowMinSpend.length > 0 || belowMinConv.length > 0) {
    const equalBudget = Math.floor(totalDailyBudget / active.length);
    const budgetUpdates = active.map((v) => {
      const newBudget =
        v.currentBudgetKurus === equalBudget
          ? v.currentBudgetKurus
          : Math.max(equalBudget, v.initialBudgetKurus);
      return { variantId: v.variantId, newBudgetKurus: newBudget };
    });
    const needsShift = budgetUpdates.some(
      (u) =>
        u.newBudgetKurus !==
        variants.find((v) => v.variantId === u.variantId)?.currentBudgetKurus
    );
    if (!needsShift) {
      return {
        action: "NEEDS_MORE_DATA",
        detail: `Veri toplanıyor: varyantlar minimum harcama (${(
          config.minSpendKurusPerVariant / 100
        ).toFixed(0)} TL) ve minimum dönüşüm (${config.minConversionsPerVariant}) eşiğine ulaşana kadar eşit bütçeyle ilerleniyor.`,
        severity: "INFO",
        stats: statList,
      };
    }
    return {
      action: "BUDGET_SHIFT",
      detail: `Veri toplama aşaması: bütçeler eşit dağılıma çekiliyor.`,
      severity: "INFO",
      stats: statList,
      budgetUpdates,
      probability: 0.5,
      winnerVariantId: active[0].variantId,
    };
  }

  // Faz 2 — Karşılaştırma: ROAS'a göre sıralama ve olasılık hesabı
  const sorted = [...statList].sort((x, y) => y.roas - x.roas);
  const best = sorted[0];
  const second = sorted[1];

  const bestInput = variants.find((v) => v.variantId === best.variantId)!;
  const secondInput = variants.find((v) => v.variantId === second.variantId)!;

  const seed = hashTestRun(bestInput.points, secondInput.points);
  const p = probabilityLatestWins(bestInput.points, secondInput.points, seed);
  const roasGap = second.roas > 0 ? best.roas / second.roas - 1 : Infinity;

  const totalBudget = statList.reduce((a, s) => a + s.currentBudgetKurus, 0);

  // Kazanan seçimi
  if (p >= config.significanceLevel && roasGap >= config.minRoasGap) {
    const budgetUpdates = applyWinnerSplit(statList, best.variantId, config);
    return {
      action: "WINNER_SELECTED",
      detail: `Kazanan belirlendi: "${best.name}". ROAS ${best.roas.toFixed(
        2
      )} vs ${second.roas.toFixed(
        2
      )} (olasılık: ${(p * 100).toFixed(1)}%). Bütçe kazanana aktarılıyor.`,
      severity: "INFO",
      stats: statList,
      winningVariantId: best.variantId,
      budgetUpdates,
      probability: p,
    };
  }

  // Faz 3 — Keşif/sömürü dengesi: kademeli kaydırma
  const shiftRatio =
    p < config.explorationThreshold
      ? config.shiftStepRatio
      : config.uncertaintyShiftRatio;

  const shiftAmount = Math.floor(totalBudget * shiftRatio);
  if (shiftAmount <= 0) {
    return {
      action: "NEEDS_MORE_DATA",
      detail: "Kaydırma miktarı çok küçük, daha fazla bütçe gerekli.",
      severity: "INFO",
      stats: statList,
    };
  }

  // İkinci en iyiden kazanana kademeli aktarım; taban sınırlarına saygılı
  const budgetUpdates = shiftedBudgets(
    statList,
    totalBudget,
    best.variantId,
    config,
    shiftRatio
  );

  return {
    action: "BUDGET_SHIFT",
    detail: `Keşif aşaması: "${best.name}" öne geçti (ROAS ${best.roas.toFixed(
      2
    )}, olasılık %${(p * 100).toFixed(1)}). Bütçenin %${Math.round(
      shiftRatio * 100
    )}'i kazanana doğru kaydırılıyor.`,
    severity: "INFO",
    stats: statList,
    budgetUpdates,
    probability: p,
    winnerVariantId: best.variantId,
  };
}

function hashTestRun(a: VariantStatInput[], b: VariantStatInput[]): number {
  let h = 2166136261;
  const s =
    a.map((p) => `${p.date}:${p.revenueKurus}:${p.spendKurus}`).join("|") +
    "|" +
    b.map((p) => `${p.date}:${p.revenueKurus}:${p.spendKurus}`).join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function applyWinnerSplit(
  stats: DecisionStat[],
  winnerId: string,
  config: EngineConfig
): { variantId: string; newBudgetKurus: number }[] {
  const total = stats.reduce((a, s) => a + s.currentBudgetKurus, 0);
  const winnerShare = Math.floor(total * config.winnerShareRatio);
  const loserShare = Math.floor((total - winnerShare) / Math.max(stats.length - 1, 1));
  return stats.map((s) => ({
    variantId: s.variantId,
    newBudgetKurus:
      s.variantId === winnerId ? winnerShare : Math.max(loserShare, config.minFloorBudgetKurus),
  }));
}

function shiftedBudgets(
  stats: DecisionStat[],
  total: number,
  winnerId: string,
  config: EngineConfig,
  shiftRatio: number
): { variantId: string; newBudgetKurus: number }[] {
  const budget = new Map(stats.map((s) => [s.variantId, s.currentBudgetKurus]));
  const others = stats.filter((s) => s.variantId !== winnerId);
  const shiftAmount = Math.floor(total * shiftRatio);
  let remaining = shiftAmount;

  for (const s of others) {
    if (remaining <= 0) break;
    const floor = Math.max(
      Math.floor(s.currentBudgetKurus * config.floorBudgetRatio),
      config.minFloorBudgetKurus
    );
    const take = Math.min(remaining, Math.max(s.currentBudgetKurus - floor, 0));
    if (take > 0) {
      budget.set(s.variantId, s.currentBudgetKurus - take);
      remaining -= take;
    }
  }
  budget.set(
    winnerId,
    (budget.get(winnerId) ?? 0) + (shiftAmount - remaining)
  );
  return [...budget.entries()].map(([variantId, newBudgetKurus]) => ({
    variantId,
    newBudgetKurus,
  }));
}