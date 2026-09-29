import type { Instrumentation } from "next";

/**
 * Sunucu başlangıcı (ADR-0023): Node çalışma zamanında arka plan süpürücüsünü başlatır. Süpürücü, işlenemeyen
 * Meta webhook teslimlerini yeniden dener ve saklama süresi dolanları siler. Üretimde varsayılan açık;
 * `BACKGROUND_JOBS=off` kapatır, geliştirmede `BACKGROUND_JOBS=on` açar.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const setting = process.env.BACKGROUND_JOBS?.trim().toLowerCase();
  const enabled = setting ? setting === "on" : process.env.NODE_ENV === "production";
  if (!enabled) return;
  const { startBackgroundJobs } = await import("./app/_lib/background-jobs");
  startBackgroundJobs();
}

/** Sunucu hataları tek satırlık JSON günlüğe yazılır (kişisel veri içermez: yalnızca yol ve hata özeti). */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { errorSummary, logger } = await import("./app/_lib/log");
  const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined;
  logger.error(
    {
      err: errorSummary(error),
      digest,
      method: request.method,
      // Sorgu dizesi kişisel veri taşıyabilir (ör. arama): yalnızca yol yazılır.
      path: request.path.split("?")[0],
      route: context.routePath,
      routeType: context.routeType,
    },
    "sunucu isteği hatayla sonuçlandı",
  );
};
