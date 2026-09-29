import { after } from "next/server";
import { logger } from "./log";

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
      logger.warn(`[${label}] arka plan işi tamamlanamadı: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
  };
  try {
    after(guarded);
  } catch {
    await guarded();
  }
}
