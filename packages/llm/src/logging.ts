import type { LlmUsage } from "./anthropic";

/** `LlmCallLog.status` değerleri — Prisma `LlmCallLogStatus` enum'uyla birebir. */
export type LlmCallStatus = "COMPLETED" | "FAILED";

/** LlmCallLog satırı (spec §4: tenant, ajan, prompt sürümü, token, süre; içerik ASLA yok). */
export interface LlmCallLogEntry {
  workspaceId: string;
  agent: string;
  promptVersion: string;
  model: string;
  status: LlmCallStatus;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** Günlük yazıcı: web'de Prisma (web/app/_lib/llm-log.ts), worker'da kendi Prisma istemcisi. */
export type LlmLogSink = (entry: LlmCallLogEntry) => Promise<void>;

export interface CallWithLogOptions<T extends { usage: LlmUsage }> {
  workspaceId: string;
  agent: string;
  promptVersion: string;
  model: string;
  sink: LlmLogSink;
  run: () => Promise<T>;
}

/**
 * Tek LLM çağrı sarmalayıcısı: `run` sonucunun `usage` alanı ve geçen süre ile
 * COMPLETED satırı, hata durumunda FAILED satırı yazılır ve hata yeniden fırlatılır.
 * Günlük yazımı çağrının kendisini engellemez (yazım hatası uyarı olarak geçilir).
 */
export async function callWithLog<T extends { usage: LlmUsage }>(
  options: CallWithLogOptions<T>,
): Promise<T & { durationMs: number }> {
  const started = Date.now();
  const write = async (status: LlmCallStatus, usage: LlmUsage) => {
    try {
      await options.sink({
        workspaceId: options.workspaceId,
        agent: options.agent,
        promptVersion: options.promptVersion,
        model: options.model,
        status,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      console.warn(
        `[llm] çağrı günlüğü yazılamadı (${options.agent}/${options.promptVersion}): ${
          error instanceof Error ? error.name : "hata"
        }`,
      );
    }
  };
  let result: T;
  try {
    result = await options.run();
  } catch (error) {
    await write("FAILED", { inputTokens: 0, outputTokens: 0 });
    throw error;
  }
  await write("COMPLETED", result.usage);
  return { ...result, durationMs: Date.now() - started };
}
