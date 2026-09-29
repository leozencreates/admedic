import { errorSummary, logger } from "./log";
import { pruneDeliveries, retryDueDeliveries } from "./webhook-queue";

/**
 * Web sürecinde çalışan arka plan süpürücüsü (ADR-0023). Birden çok örnekte güvenlidir: teslimler
 * `FOR UPDATE SKIP LOCKED` ile sahiplenilir. Bir tur bitmeden yenisi başlamaz.
 */
const INTERVAL_MS = 60_000;
const PRUNE_EVERY = 60; // turda bir (≈ saatte bir)

let started = false;

export function startBackgroundJobs(): void {
  if (started) return;
  started = true;
  let running = false;
  let tick = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { processed, failed } = await retryDueDeliveries();
      if (processed || failed) logger.info({ processed, failed }, "webhook yeniden deneme turu");
      if (tick++ % PRUNE_EVERY === 0) {
        const pruned = await pruneDeliveries();
        if (pruned) logger.info({ pruned }, "eski webhook teslimleri silindi");
      }
    } catch (error) {
      logger.error({ err: errorSummary(error) }, "arka plan süpürücüsü turu tamamlanamadı");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref?.();
  logger.info({ intervalMs: INTERVAL_MS }, "arka plan süpürücüsü başladı");
}
