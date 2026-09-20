import { z } from "zod";
import { SYSTEM, LOCALIZATION, PROMPT_VERSION } from "../prompts/creative-v1";
export { PROMPT_VERSION };

export const BriefSchema = z.object({
  clinic: z.string().trim().min(1).max(100),
  service: z.string().trim().min(1).max(100),
  market: z.string().trim().min(1).max(80),
  language: z.enum(["TR", "EN", "DE", "RU", "AR"]),
  budget: z.number().positive().max(1_000_000).finite(),
  duration: z.number().int().min(1).max(90),
});
export const VariantSchema = z
  .object({
    headline: z.string().trim().min(1).max(150),
    text: z.string().trim().min(1).max(2000),
    cta: z.string().trim().min(1).max(150),
  })
  .strict();
export const OutputSchema = z
  .object({ variants: z.tuple([VariantSchema, VariantSchema]) })
  .strict()
  .refine(
    ({ variants: [a, b] }) =>
      a.headline !== b.headline && a.text === b.text && a.cta === b.cta,
    "Başlıklar farklı, metin ve CTA aynı olmalı.",
  );
export const DraftSchema = BriefSchema.extend({
  variants: z.tuple([VariantSchema, VariantSchema]),
}).strict();
export type DraftContent = z.infer<typeof DraftSchema>;
export type Brief = z.infer<typeof BriefSchema>;
export interface CreativeProvider {
  generate(
    brief: Brief,
  ): Promise<{
    variants: DraftContent["variants"];
    inputTokens: number;
    outputTokens: number;
  }>;
}

export class AnthropicProvider implements CreativeProvider {
  constructor(
    private key: string,
    private model: string,
    private transport: typeof fetch = fetch,
  ) {}
  async generate(brief: Brief) {
    const response = await this.transport(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.key,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2500,
          system: `${SYSTEM}\n${LOCALIZATION[brief.language]}`,
          messages: [{ role: "user", content: JSON.stringify(brief) }],
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        "AI sağlayıcısı yanıt veremedi. Ayarları kontrol edip tekrar deneyin.",
      );
    const data = z
      .object({
        stop_reason: z.literal("end_turn"),
        content: z.array(
          z.object({ type: z.string(), text: z.string().optional() }),
        ),
        usage: z.object({
          input_tokens: z.number().int().nonnegative(),
          output_tokens: z.number().int().nonnegative(),
        }),
      })
      .parse(await response.json());
    const raw = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const result = OutputSchema.parse(JSON.parse(raw));
    return {
      variants: result.variants,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    };
  }
}
