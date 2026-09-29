import { prisma, RecommendationType } from "@admedic/database";

export interface RecommendationInput {
  experimentId: string;
  workspaceId: string;
}

/** `RecommendationType` enum'u + veritabanında (henüz) olmayan "CONTINUE" (belirsiz sonuç). */
export type RecommendationKind = "BUDGET_REALLOCATION" | "BUDGET_INCREASE" | "BUDGET_DECREASE" | "EXPERIMENT_END" | "WINNER_PROMOTION" | "CONTINUE";

export interface RecommendationOutput {
  id: string;
  type: RecommendationKind;
  title: string;
  description: string;
  reasoning: string;
  action: Record<string, unknown>;
  expectedImpact: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  status: "PENDING";
  version: number;
  priority: "HIGH" | "MEDIUM" | "LOW";
}

/** Kazanan seçimi eşikleri (spec 3.10): kazananda en az 10 lead ve CPL'de en az %20 fark. */
export const WINNER_THRESHOLDS = { minLeads: 10, minCplEdge: 0.2, highPriorityEdge: 0.3 } as const;

export interface VariantMetrics {
  /** Major birim (deney ekranında elle girilir). */
  spend: number;
  clicks: number;
  leads: number;
}

/**
 * Prisma `Json` sütunu string (eski kayıt) ya da nesne olarak gelebilir:
 * string ise JSON.parse, nesne ise aynen döner. Bozuk/yarım kalmış legacy string
 * tüm üretimi 500'e düşürmek yerine varsayılan değere döner.
 */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value ?? fallback) as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toMetrics(raw: unknown): VariantMetrics {
  const m = (raw ?? {}) as Partial<Record<keyof VariantMetrics, unknown>>;
  const num = (v: unknown) => {
    const n = (typeof v === "number" && Number.isFinite(v) ? v : Number(v)) || 0;
    return n > 0 ? n : 0;
  };
  return { spend: num(m.spend), clicks: num(m.clicks), leads: num(m.leads) };
}

function cplOf(m: VariantMetrics): number {
  return m.leads > 0 ? m.spend / m.leads : Infinity;
}

function money(major: number, currency: string): string {
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, maximumFractionDigits: 2 }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

function cplText(m: VariantMetrics, currency: string): string {
  return m.leads > 0 ? money(m.spend / m.leads, currency) : "—";
}

export interface WinnerDecision {
  winner: "A" | "B" | null;
  /** CPL avantajı oranı (0.55 = %55 daha düşük CPL); kaybedende lead yoksa 1. */
  edge: number;
  reason: "NO_LEADS" | "INSUFFICIENT_LEADS" | "EDGE_TOO_SMALL" | "DECISIVE";
}

/**
 * Kazanan yalnızca lead sayısıyla değil CPL (spend/leads) ile seçilir: aday, CPL'i düşük olan
 * varyanttır; kazananda en az 10 lead ve kaybedene göre en az %20 CPL avantajı gerekir.
 */
export function decideWinner(a: VariantMetrics, b: VariantMetrics): WinnerDecision {
  if (a.leads === 0 && b.leads === 0) return { winner: null, edge: 0, reason: "NO_LEADS" };
  const cplA = cplOf(a);
  const cplB = cplOf(b);
  const candidate: "A" | "B" = cplA < cplB ? "A" : cplB < cplA ? "B" : a.leads >= b.leads ? "A" : "B";
  const win = candidate === "A" ? a : b;
  const lose = candidate === "A" ? b : a;
  if (win.leads < WINNER_THRESHOLDS.minLeads) return { winner: null, edge: 0, reason: "INSUFFICIENT_LEADS" };
  const loseCpl = cplOf(lose);
  // loseCpl === Infinity: kaybeden hiç lead üretmedi -> ölçülebilir fark tam avantaj (1).
  // loseCpl === 0: kaybeden lead üretti ama harcaması sıfır; kazanan da (CPL'i düşük olan
  // seçildiği için) sıfır harcamalıdır, yani `(0 - 0) / 0` -> NaN. Böyle bir deneyde
  // karşılaştırılacak harcamalı CPL yoktur; ölçülebilir avantaj 0 kabul edilir.
  const edge = loseCpl === Infinity ? 1 : loseCpl > 0 ? (loseCpl - cplOf(win)) / loseCpl : 0;
  if (!Number.isFinite(edge) || edge < WINNER_THRESHOLDS.minCplEdge) {
    return { winner: null, edge: Number.isFinite(edge) ? edge : 0, reason: "EDGE_TOO_SMALL" };
  }
  return { winner: candidate, edge, reason: "DECISIVE" };
}

export async function generateRecommendations(input: RecommendationInput): Promise<RecommendationOutput[]> {
  const experiment = await prisma.studioExperiment.findUnique({
    where: { id: input.experimentId, draft: { workspaceId: input.workspaceId } },
    include: { draft: { include: { workspace: true } } },
  });
  if (!experiment || experiment.status !== "COMPLETED") return [];

  const snapshot = parseJsonColumn<{ variants?: Array<{ headline?: string }> }>(experiment.snapshot, { variants: [] });
  const rawMetrics = parseJsonColumn<unknown[]>(experiment.metrics, []);
  const a = toMetrics(rawMetrics[0]);
  const b = toMetrics(rawMetrics[1]);
  const currency = experiment.draft?.workspace?.currency ?? "EUR";
  const headline = (idx: number) => snapshot.variants?.[idx]?.headline?.trim() || (idx === 0 ? "A" : "B");
  const days = experiment.elapsedDays ?? 0;
  const basis = `Deney metriklerine göre (${days} gün, elle girilen ölçüm): A "${headline(0)}" ${a.leads} lead / ${a.clicks} tıklama / ${money(a.spend, currency)} harcama (CPL ${cplText(a, currency)}); B "${headline(1)}" ${b.leads} lead / ${b.clicks} tıklama / ${money(b.spend, currency)} harcama (CPL ${cplText(b, currency)}).`;
  const evidence = [
    { metric: "leads", variantA: a.leads, variantB: b.leads },
    { metric: "spend", variantA: a.spend, variantB: b.spend, currency },
    { metric: "cpl", variantA: a.leads > 0 ? Number((a.spend / a.leads).toFixed(2)) : null, variantB: b.leads > 0 ? Number((b.spend / b.leads).toFixed(2)) : null, currency },
  ];
  const decision = decideWinner(a, b);
  const recommendations: RecommendationOutput[] = [];

  if (decision.reason === "NO_LEADS") {
    const totalSpend = a.spend + b.spend;
    recommendations.push({
      id: `rec-${experiment.id}-end`,
      type: "EXPERIMENT_END",
      title: "Henüz dönüşüm yok — deney değerlendirilmeli",
      description: "Her iki varyant da lead üretmedi. Harcama varsa kreatif/hedefleme değişikliği düşünülmeli; yoksa deney veri toplamaya devam etmeli.",
      reasoning: `${basis} Harcama var ancak lead kaydı yok${totalSpend > 0 ? "" : " (harcama da yok)"}; yalnızca tıklama varsa kreatif odaklı değişiklik gerekebilir.`,
      action: { type: "EXPERIMENT_END" },
      expectedImpact: {},
      evidence,
      status: "PENDING",
      version: 1,
      priority: totalSpend > 0 ? "MEDIUM" : "LOW",
    });
    return recommendations;
  }

  if (decision.winner === null) {
    const why =
      decision.reason === "INSUFFICIENT_LEADS"
        ? `Aday varyantta ${WINNER_THRESHOLDS.minLeads} lead eşiği henüz aşılmadı.`
        : `CPL farkı %${Math.round(decision.edge * 100)}; karar için en az %${Math.round(WINNER_THRESHOLDS.minCplEdge * 100)} fark gerekir.`;
    recommendations.push({
      id: `rec-${experiment.id}-continue`,
      type: "CONTINUE",
      title: "Sonuç henüz belirsiz — deneye devam",
      description: `Kazanan ilan etmek için kazanan varyantta en az ${WINNER_THRESHOLDS.minLeads} lead ve CPL'de en az %${Math.round(WINNER_THRESHOLDS.minCplEdge * 100)} fark gerekir. Bütçe değişikliği önerilmez; veri toplamaya devam edin.`,
      reasoning: `${basis} ${why}`,
      action: { type: "CONTINUE" },
      expectedImpact: {},
      evidence,
      status: "PENDING",
      version: 1,
      priority: "LOW",
    });
    return recommendations;
  }

  const winner = decision.winner;
  const loser = winner === "A" ? "B" : "A";
  const winnerIdx = winner === "A" ? 0 : 1;
  const win = winner === "A" ? a : b;
  const lose = winner === "A" ? b : a;
  const winCpl = cplOf(win);
  const loseCpl = cplOf(lose);
  const edgePct = Math.round(decision.edge * 100);
  // Kaybeden bütçesi kazanan CPL'iyle harcansaydı: ek lead ve aynı lead için tasarruf (major).
  // Kazananın CPL'i 0 ise (harcamasız lead) bölme Infinity verir; ölçülebilir ek lead yoktur.
  const estimatedAdditionalLeads = winCpl > 0 ? Math.max(0, Math.round(lose.spend / winCpl - lose.leads)) : 0;
  const estimatedSavings = loseCpl === Infinity ? Math.round(lose.spend) : Math.max(0, Math.round(lose.spend - lose.leads * winCpl));
  const loserCplText = loseCpl === Infinity ? "lead yok" : `CPL ${money(loseCpl, currency)}`;

  recommendations.push({
    id: `rec-${experiment.id}-budget`,
    type: "BUDGET_REALLOCATION",
    title: `${headline(winnerIdx)} — bütçenin %70'i kazanan varyanta`,
    description: `${winner} varyantı CPL ${money(winCpl, currency)} ile ${lose.leads > 0 ? `${loser} varyantından (${loserCplText}) %${edgePct} daha verimli` : `tek lead üreten varyant (${loser}: ${loserCplText})`}. Bütçenin %70 ${winner} / %30 ${loser} olarak dağıtılması önerilir. Uygulandığında hedef kampanyanın günlük bütçesi %70'e ölçeklenir; varyant bazlı dağıtım Meta'da reklam seti düzeyinde elle tamamlanır.`,
    reasoning: `${basis} ${winner} varyantı daha düşük CPL üretti; kazananda en az ${WINNER_THRESHOLDS.minLeads} lead ve %${Math.round(WINNER_THRESHOLDS.minCplEdge * 100)} CPL farkı eşikleri sağlandı (fark %${edgePct}).`,
    action: { type: "BUDGET_REALLOCATION", variantWinner: winner, budgetSplit: [70, 30] },
    expectedImpact: { estimatedAdditionalLeads, estimatedSavings, currency },
    evidence: [...evidence, { metric: "winner", variant: winner, cplEdge: Number(decision.edge.toFixed(4)) }],
    status: "PENDING",
    version: 1,
    priority: decision.edge >= WINNER_THRESHOLDS.highPriorityEdge ? "HIGH" : "MEDIUM",
  });

  return recommendations;
}

/** Tür DB enum'unda yoksa (ileride eklenecek türler) EXPERIMENT_END altında saklanır; gerçek tür `action.type`'ta kalır. */
function toDbType(type: RecommendationKind): RecommendationType {
  const known = RecommendationType as Record<string, RecommendationType>;
  return known[type] ?? RecommendationType.EXPERIMENT_END;
}

export async function persistRecommendations(experimentId: string, recommendations: RecommendationOutput[], actor: { workspaceId: string; userId: string }) {
  return prisma.$transaction(async (tx) => {
    // Açık (henüz uygulanmamış/reddedilmemiş) eski öneriler süresi dolmuş sayılır.
    await tx.recommendation.updateMany({
      where: { experimentId, workspaceId: actor.workspaceId, status: { in: ["DRAFT", "PENDING", "APPROVED"] } },
      data: { status: "EXPIRED" },
    });
    const saved: RecommendationOutput[] = [];
    for (const rec of recommendations) {
      const created = await tx.recommendation.create({
        data: {
          workspaceId: actor.workspaceId,
          experimentId,
          type: toDbType(rec.type),
          title: rec.title,
          description: rec.description,
          reasoning: rec.reasoning,
          action: rec.action as any,
          expectedImpact: rec.expectedImpact as any,
          evidence: rec.evidence as any,
          status: "PENDING",
          version: rec.version,
          priority: rec.priority,
        },
      });
      saved.push({ ...rec, id: created.id });
    }
    return saved;
  });
}
