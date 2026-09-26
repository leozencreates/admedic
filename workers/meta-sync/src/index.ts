/**
 * Kütüphane girişi: import edilmesi zamanlayıcıyı BAŞLATMAZ (yan etkisizdir).
 * Süreç olarak çalıştırmak için `cli.ts` (`pnpm --filter @admedic/meta-sync start`) kullanılır.
 */
import { prisma } from "@admedic/database";
import { createMetaClient, type MetaClientLike } from "@admedic/meta-api";
import { syncExperiment } from "./scheduler.js";
export {
  runOnce, start, stop, createMetaSyncScheduler, deliverWeeklyReport, runAnomalyAlerts, syncInsights, isMetaThrottleError,
} from "./scheduler.js";
export { detectAnomalies, ANOMALY_THRESHOLDS, type AnomalyAlert, type DailyCampaignRow } from "./anomalies.js";
export { minorUnitFactor, toMinorUnits } from "./money.js";
export { runAssistant, type AssistantRunOptions, type AssistantRunResult } from "./assistant.js";

export interface SyncResult {
  experimentId: string;
  variantMetrics: Array<{ variantId: string; pointsCreated: number; totalSpend: number; totalClicks: number; totalLeads: number }>;
  elapsedDays: number;
  status: "RUNNING" | "COMPLETED";
  completed: boolean;
}
export interface SyncJob { run: () => Promise<SyncResult[]> }

export function createMetaSyncWorker(client?: MetaClientLike): SyncJob {
  const meta = client ?? createMetaClient();
  return { async run() {
    const experiments = await prisma.studioExperiment.findMany({ where: { status: "RUNNING" } });
    const results: SyncResult[] = [];
    for (const experiment of experiments) {
      const result = await syncExperiment(meta, experiment);
      results.push({ experimentId: experiment.id, variantMetrics: [], elapsedDays: experiment.elapsedDays, status: "RUNNING", completed: result.completed });
    }
    return results;
  } };
}
