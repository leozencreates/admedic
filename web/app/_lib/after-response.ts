import { after } from "next/server";
import { errorSummary, logger } from "./log";

/**
 * İşi yanıt gönderildikten sonra çalıştırır (Next `after`; Meta webhook'u ve OAuth dönüşü bekletilmez).
 * İstek kapsamı yoksa (test, betik) iş beklenerek hemen çalıştırılır. Hatalar yutulur ve PII içermeden loglanır:
 * yardımcı işler asıl yanıtı asla bozmaz.
 */
export async function runAfterResponse(label: string, task: () => Promise<unknown>): Promise<void> {
  const guarded = async () => {
    try {
      await task();
    } catch (error) {
      logger.warn({ job: label, err: errorSummary(error) }, "arka plan işi tamamlanamadı");
    }
  };
  try {
    after(guarded);
  } catch {
    await guarded();
  }
}
