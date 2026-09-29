import {
  computePosterior,
  evaluateScale,
  evaluateStop,
  posteriorStats,
  type FatigueLevel,
  type ScaleVerdict,
  type StopVerdict,
} from "@admedic/bayesian-engine";
import type { AgentDecisionAction, TrendDirection } from "@admedic/shared";

import {
  clampBudgetChange,
  inCooldown,
  used24hBudgetChangeCents,
} from "./policy";
import type {
  AdSetAgentInput,
  AgentDecisionOut,
  AgentAlertOut,
  DecisionMetrics,
  OptimizerReport,
} from "./types";

export type { FatigueLevel };

/**
 * Kovaları "en eskiden en yeniye" sıralar. `ageHours` şimdiden geriye sayıldığı için büyük
 * değer daha eskidir. Sıralama burada yapılır: çağıranın sıra garantisi vermemesi durumunda
 * trend tersine dönmesin ve olgunluk kapısı en yeni kovayı okumasın.
 */
function oldestFirst<T extends { ageHours: number }>(buckets: T[]): T[] {
  return [...buckets].sort((a, b) => b.ageHours - a.ageHours);
}

/**
 * Trend: eski yarı pencerenin ROAS'ı yeni yarıya oranla.
 * Yetersiz veri/spend → INSUFFICIENT_DATA.
 */
export function classifyTrend(
  buckets: { ageHours: number; spendMajor: number; revenueMajor: number }[],
  settings: {
    strongRising: number;
    rising: number;
    declining: number;
    strongDeclining: number;
  },
): TrendDirection {
  if (buckets.length < 3) return "INSUFFICIENT_DATA";
  const ordered = oldestFirst(buckets);
  const mid = Math.floor(ordered.length / 2);
  const older = ordered.slice(0, mid);
  const recent = ordered.slice(mid);
  const roas = (b: { spendMajor: number; revenueMajor: number }[]) => {
    const s = b.reduce((a, x) => a + x.spendMajor, 0);
    const r = b.reduce((a, x) => a + x.revenueMajor, 0);
    return s > 0 ? r / s : 0;
  };
  const oldR = roas(older);
  const newR = roas(recent);
  if (oldR <= 0) return "INSUFFICIENT_DATA";
  const ratio = newR / oldR;
  if (ratio >= settings.strongRising) return "RISING";
  if (ratio >= settings.rising) return "RISING";
  if (ratio <= settings.strongDeclining) return "DECLINING";
  if (ratio <= settings.declining) return "DECLINING";
  return "STABLE";
}

function decisionKeyFor(
  entityId: string,
  entityType: string,
  action: string,
  now: Date,
  ruleVersion: string,
): string {
  const day = now.toISOString().slice(0, 10);
  return `agent:v${ruleVersion}:${entityType.toLowerCase()}:${entityId}:${action.toLowerCase()}:${day}`;
}

/** Öneriyi üret; budget değerleri cents, bayesian-engine major kullanır. */
export function evaluateAdSet(input: AdSetAgentInput): AgentDecisionOut {
  const {
    entityId,
    targetType,
    currentBudgetCents,
    status,
    policy,
    settings,
    now,
    workspaceId,
    runId,
  } = input;

  const posteriorCfg = { ...input.posterior, timeNow: now };
  const posterior = computePosterior(input.buckets, posteriorCfg);
  const stats = posteriorStats(
    posterior,
    input.targetRoas,
    input.contributionMarginRatio,
  );

  const observedRoas =
    posterior.rawSpend > 0 ? posterior.rawRevenue / posterior.rawSpend : null;
  const fatigue: FatigueLevel = input.fatigue ?? "LOW";
  const trend = classifyTrend(input.buckets, settings);
  const zeroPurchases = posterior.rawPurchases === 0;

  // En eski kova: ageHours en büyük olan. Sıraya güvenilmez (bkz. oldestFirst).
  const oldestAgeHours =
    input.buckets.length > 0
      ? Math.max(...input.buckets.map((b) => b.ageHours))
      : 0;
  const minRuntimeReached = oldestAgeHours >= policy.minTestDurationHours;
  const minMatureReached = oldestAgeHours >= settings.minMatureHours;

  const cooldown = inCooldown(
    input.lastDecisionAt,
    now,
    policy.minHoursBetweenChanges,
  );
  const used24h = used24hBudgetChangeCents(input.budgetChangesLast24h ?? []);

  const base = {
    decisionKey: "",
    entityId,
    targetType,
    targetId: entityId,
    workspaceId,
    runId,
    currentBudgetCents,
    statusBefore: status,
    statusAfter: status,
    metrics: metricsOf({
      posterior,
      stats,
      observedRoas,
      targetRoas: input.targetRoas,
      trend,
      fatigue,
    }),
    now,
    ruleVersion: "policy_1",
    algorithm: "rules_v1",
    createdAt: now,
  };

  // Cooldown → dokunma.
  if (cooldown) {
    return {
      ...base,
      decisionKey: decisionKeyFor(
        entityId,
        targetType,
        "KEEP",
        now,
        base.ruleVersion,
      ),
      action: "KEEP",
      reason: `KEEP_RUNNING: cooldown (son karar < ${policy.minHoursBetweenChanges}sa)`,
      algorithm: "rules_v1",
      changePct: 0,
      proposedBudgetCents: currentBudgetCents,
      approval: "NOT_REQUIRED",
    };
  }

  const stopInput = {
    posterior,
    stats,
    settings,
    trackingAnomaly: input.trackingAnomaly ?? false,
    zeroPurchases,
    minRuntimeReached,
    minMatureReached,
    consecutiveLoserEvaluations: input.consecutiveLoserEvaluations ?? 0,
  };
  const stop: StopVerdict = evaluateStop(stopInput);

  const fromStop = applyStop(stop, input, base);
  if (fromStop) return fromStop;

  // Stop OBSERVE → scale değerlendirmesi.
  const minSpendReached =
    posterior.maturedSpend * 100 >= policy.minSpendBeforeDecisionCents;
  const minPurchasesReached =
    posterior.effectivePurchases >= policy.minPurchasesBeforeScaling;

  const scale: ScaleVerdict = evaluateScale({
    stats,
    settings,
    trackingAnomaly: input.trackingAnomaly ?? false,
    inCooldown: cooldown,
    fatigue,
    strongDeclining: trend === "DECLINING",
    minimumAcceptableRoas: input.minimumAcceptableRoas,
    consecutivePositiveEvaluations: 0,
  });

  // Cap teşhisi: artış uygulanamıyorsa KEEP gerekçesinde korunur.
  let capReason: string | null = null;

  if (
    scale.action === "SCALE" &&
    minSpendReached &&
    minPurchasesReached &&
    !input.trackingAnomaly
  ) {
    const proposed = currentBudgetCents * (1 + scale.proposedBudgetPct);
    const clamped = clampBudgetChange({
      currentBudgetCents,
      proposedBudgetCents: proposed,
      policy,
      used24hChangeCents: used24h,
    });
    capReason = clamped.reason;

    // Yalnızca gerçek bir artış önerilir. `clamped.capped`, bütçeyi yükseltmeyen bir
    // guardrail'den de gelir (ör. 24 saatlik pay tükendi → bütçe cari değerde kalır); bu
    // durumda `INCREASE_BUDGET` sıfır değişimli bir onay işi ve WINNER_DETECTED uyarısı
    // üretirdi. Cap teşhisi KEEP dalında `reason` içinde korunur.
    if (clamped.budgetCents > currentBudgetCents) {
      return {
        ...base,
        decisionKey: decisionKeyFor(
          entityId,
          targetType,
          "INCREASE_BUDGET",
          now,
          base.ruleVersion,
        ),
        action: "INCREASE_BUDGET",
        reason: `SCALE_CONFIDENCE_TIER: P_best üstünde, evidence içinde (${(stats.probabilityAboveTarget * 100).toFixed(1)}%)${clamped.reason ? ` · cap:${clamped.reason}` : ""}`,
        algorithm: "rules_v1",
        changePct:
          Math.round(
            ((clamped.budgetCents - currentBudgetCents) / currentBudgetCents) *
              100,
          ) / 100,
        proposedBudgetCents: clamped.budgetCents,
        approval: "PENDING",
      };
    }
  }

  return {
    ...base,
    decisionKey: decisionKeyFor(
      entityId,
      targetType,
      "KEEP",
      now,
      base.ruleVersion,
    ),
    action: "KEEP",
    reason: `KEEP_RUNNING: ${scale.reasonCode} / minSpend:${minSpendReached} / minPurchases:${minPurchasesReached}${capReason ? ` · cap:${capReason}` : ""}`,
    algorithm: "rules_v1",
    changePct: 0,
    proposedBudgetCents: currentBudgetCents,
    approval: "NOT_REQUIRED",
  };
}

function applyStop(
  stop: StopVerdict,
  input: AdSetAgentInput,
  base: Omit<
    AgentDecisionOut,
    | "action"
    | "reason"
    | "changePct"
    | "proposedBudgetCents"
    | "approval"
    | "decisionKey"
  >,
): AgentDecisionOut | null {
  const { policy, currentBudgetCents, now } = input;
  const ruleVersion = base.ruleVersion;
  const keyFor = (action: AgentDecisionAction) =>
    decisionKeyFor(input.entityId, input.targetType, action, now, ruleVersion);

  switch (stop.action) {
    case "FREEZE":
      return {
        ...base,
        decisionKey: keyFor("KEEP"),
        action: "KEEP",
        reason: `FREEZE_TRACKING_ANOMALY: veri anomalisi, karar donduruldu`,
        algorithm: "rules_v1",
        changePct: 0,
        proposedBudgetCents: currentBudgetCents,
        approval: "NOT_REQUIRED",
      };
    case "PAUSE":
      return {
        ...base,
        decisionKey: keyFor("PAUSE"),
        action: "PAUSE",
        reason: `PAUSE (${stop.reasonCode})`,
        algorithm: "rules_v1",
        changePct: -1,
        proposedBudgetCents: 0,
        statusAfter: "PAUSED",
        approval: "PENDING",
      };
    case "DOWNSCALE": {
      const proposed = currentBudgetCents * (1 + stop.proposedBudgetPct);
      const clamped = clampBudgetChange({
        currentBudgetCents,
        proposedBudgetCents: proposed,
        policy,
      });
      return {
        ...base,
        decisionKey: keyFor("DECREASE_BUDGET"),
        action: "DECREASE_BUDGET",
        reason: `DOWNSCALE (${stop.reasonCode})${clamped.reason ? ` · cap:${clamped.reason}` : ""}`,
        algorithm: "rules_v1",
        // Cari bütçe 0 ise oran tanımsızdır (0/0 -> NaN, Float sütununda null olarak saklanır).
        changePct:
          currentBudgetCents > 0
            ? (clamped.budgetCents - currentBudgetCents) / currentBudgetCents
            : 0,
        proposedBudgetCents: clamped.budgetCents,
        approval: "PENDING",
      };
    }
    case "OBSERVE":
      return null;
  }
}

function metricsOf(p: {
  posterior: import("@admedic/bayesian-engine").Posterior;
  stats: import("@admedic/bayesian-engine").PosteriorStats;
  observedRoas: number | null;
  targetRoas: number;
  trend: TrendDirection;
  fatigue: FatigueLevel;
}): DecisionMetrics {
  const { posterior, stats, targetRoas } = p;
  return {
    observedRoas: p.observedRoas,
    bayesianRoas: stats.expectedRoas,
    targetRoas,
    breakEvenRoas: stats.breakEvenRoas,
    bayesianRoasP10: stats.quantiles.p10,
    bayesianRoasP50: stats.quantiles.p50,
    bayesianRoasP90: stats.quantiles.p90,
    probabilityAboveTarget: stats.probabilityAboveTarget,
    probabilityBelowBreakEven: stats.probabilityBelowBreakEven,
    evidenceTarget: stats.evidenceTarget,
    evidenceBreakEven: stats.evidenceBreakEven,
    expectedAov: stats.expectedAov,
    trend: p.trend,
    fatigue: p.fatigue,
    purchases: posterior.rawPurchases,
    spendCents: Math.round(posterior.rawSpend * 100),
    ctrPercent: null,
    cpcCents: null,
    cpmCents: null,
  };
}

/** Hesap seviyesi döngü: tüm ad setleri değerlendir, bütçe cap'leri uygula. */
export function evaluateAccount(
  workspaceId: string,
  runId: string,
  inputs: AdSetAgentInput[],
  policy: AdSetAgentInput["policy"],
  opts: { now?: Date } = {},
): OptimizerReport {
  const now = opts.now ?? new Date();
  const decisions = inputs.map((i) => evaluateAdSet(i));

  let projectedDailySpendCents = 0;
  for (const d of decisions) {
    projectedDailySpendCents += d.proposedBudgetCents ?? d.currentBudgetCents;
  }

  let overBudgetCents = 0;
  const alerts: AgentAlertOut[] = [];
  const accountCap = policy.accountDailyMaxCents;
  if (
    accountCap !== undefined &&
    accountCap > 0 &&
    projectedDailySpendCents > accountCap
  ) {
    overBudgetCents = projectedDailySpendCents - accountCap;
  }

  for (const d of decisions) {
    if (d.action !== "KEEP") {
      alerts.push({
        type:
          d.action === "PAUSE"
            ? "ROAS_DROP"
            : d.action === "INCREASE_BUDGET"
              ? "WINNER_DETECTED"
              : "HIGH_CPA",
        severity: d.action === "PAUSE" ? "WARNING" : "INFO",
        title: `${d.targetType} ${d.action} önerisi`,
        message: d.reason,
        entityType: d.targetType,
        entityId: d.targetId,
        decisionKey: d.decisionKey,
      });
    }
    if (
      accountCap !== undefined &&
      accountCap > 0 &&
      (d.proposedBudgetCents ?? d.currentBudgetCents) >= accountCap * 0.9
    ) {
      alerts.push({
        type: "BUDGET_LIMIT_90",
        severity: "WARNING",
        title: "Hesap günlük bütçe limitinin %90'ına ulaşıldı",
        message: `${d.targetType} ${d.targetId} hesap günlük limitinin %90+'ına yakın.`,
        entityType: "ACCOUNT",
        entityId: d.targetId,
        decisionKey: d.decisionKey,
      });
    }
  }

  return {
    workspaceId,
    runId,
    decisions,
    alerts,
    projectedDailySpendCents,
    accountDailyMaxCents: accountCap ?? null,
    overBudgetCents,
    now,
  };
}
