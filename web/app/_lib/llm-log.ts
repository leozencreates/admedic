import { prisma, LlmCallLogStatus } from "@admedic/database";
import { callWithLog, type CallWithLogOptions, type LlmCallLogEntry, type LlmUsage } from "@admedic/llm";

/**
 * LlmCallLog yazımı (spec §4): tenant, ajan, prompt sürümü, model, token, süre, durum.
 * İçerik (brief, metin, yanıt) ASLA yazılmaz. `status` sütunu String'dir; değerler
 * `LlmCallLogStatus` enum'undan (PENDING/COMPLETED/FAILED) gelir.
 */
export async function writeLlmCallLog(entry: LlmCallLogEntry): Promise<void> {
  await prisma.llmCallLog.create({
    data: {
      workspaceId: entry.workspaceId,
      agent: entry.agent,
      model: entry.model,
      promptVersion: entry.promptVersion,
      status: entry.status === "COMPLETED" ? LlmCallLogStatus.COMPLETED : LlmCallLogStatus.FAILED,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      durationMs: entry.durationMs,
    },
  });
}

/** `callWithLog` + Prisma günlüğü: web tarafındaki her LLM çağrısı bu sarmalayıcıdan geçer. */
export function withLlmLog<T extends { usage: LlmUsage }>(
  options: Omit<CallWithLogOptions<T>, "sink">,
): Promise<T & { durationMs: number }> {
  return callWithLog({ ...options, sink: writeLlmCallLog });
}
