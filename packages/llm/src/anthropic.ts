import { z } from "zod";

/** Girdi/çıktı token sayıları (LlmCallLog için); sağlayıcı bildirmezse 0. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}
export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

export interface LlmConfigLike {
  apiKey: string;
  model: string;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicCallInput extends LlmConfigLike {
  system: string;
  messages: AnthropicMessage[];
  maxTokens: number;
  timeoutMs?: number;
  transport?: typeof fetch;
  /** `!response.ok` durumunda fırlatılacak kullanıcı mesajı (üst akım gövdesi asla sızdırılmaz). */
  errorMessage?: string;
}

export interface AnthropicCallResult {
  /** Metin blokları birleştirilmiş çıktı. */
  text: string;
  usage: LlmUsage;
  stopReason: string | null;
}

const ResponseSchema = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/**
 * Tek Anthropic Messages çağrısı: model/anahtar çağıranın verdiği `LlmConfig`'ten gelir
 * (varsayılan model YOK); yanıt Zod ile doğrulanır, token kullanımı `usage` olarak döner.
 */
export async function anthropicMessages(input: AnthropicCallInput): Promise<AnthropicCallResult> {
  const transport = input.transport ?? fetch;
  const response = await transport("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(input.timeoutMs ?? 45_000),
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: input.messages,
    }),
  });
  if (!response.ok)
    throw new Error(
      input.errorMessage ?? "AI sağlayıcısı yanıt veremedi. Ayarları kontrol edip tekrar deneyin.",
    );
  const data = ResponseSchema.parse(await response.json());
  return {
    text: data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join(""),
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
    stopReason: data.stop_reason ?? null,
  };
}

/** Model çıktısından JSON nesnesini ayıklar (``` çitleri ve öncesindeki/sonrasındaki metin atılır). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("AI çıktısı JSON değil.");
  }
}
