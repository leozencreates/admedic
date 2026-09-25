import { z } from "zod";
import { SYSTEM, LOCALIZATION, PROMPT_VERSION } from "../prompts/creative-v1";
export { PROMPT_VERSION };

export const BriefLanguageEnum = z.enum(["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"]);

/** Klinik profili (spec 3.2): üretim bağlamı — sunucu tarafında DB'den zenginleştirilir. */
export const BriefProfileSchema = z
  .object({
    brandTone: z.string().max(2000).optional(),
    languages: z.array(BriefLanguageEnum).optional(),
    targetMarket: z
      .enum(["TURKEY", "GERMANY", "UK", "NETHERLANDS", "USA", "GULF", "OTHER"])
      .optional(),
    services: z.array(z.string().min(1).max(100)).optional(),
    bannedPhrases: z.array(z.string().min(2).max(200)).optional(),
  })
  .strict();

export const BriefSchema = z.object({
  clinic: z.string().trim().min(1).max(100),
  service: z.string().trim().min(1).max(100),
  market: z.string().trim().min(1).max(80),
  language: BriefLanguageEnum,
  budget: z.number().positive().max(1_000_000).finite(),
  duration: z.number().int().min(1).max(90),
  profile: BriefProfileSchema.optional(),
});
export const VariantSchema = z
  .object({
    headline: z.string().trim().min(1).max(150),
    text: z.string().trim().min(1).max(2000),
    description: z.string().trim().max(500).optional(), // Meta description (link description)
    cta: z.string().trim().min(1).max(150),
  })
  .strict();
export const InstantFormSchema = z
  .object({
    questions: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  })
  .strict();
export const WhatsAppSchema = z
  .object({ welcome: z.string().trim().min(1).max(2000) })
  .strict();
export const OutputSchema = z
  .object({
    variants: z.tuple([VariantSchema, VariantSchema]),
    instantForm: InstantFormSchema.optional(),
    whatsapp: WhatsAppSchema.optional(),
  })
  .strict()
  .refine(
    ({ variants: [a, b] }) =>
      a.headline !== b.headline &&
      a.text === b.text &&
      a.description === b.description &&
      a.cta === b.cta,
    "Başlıklar farklı, metin/description/CTA aynı olmalı.",
  );
export const DraftSchema = BriefSchema.extend({
  variants: z.tuple([VariantSchema, VariantSchema]),
  instantForm: InstantFormSchema.optional(),
  whatsapp: WhatsAppSchema.optional(),
}).strict();
export type DraftContent = z.infer<typeof DraftSchema>;
export type Brief = z.infer<typeof BriefSchema>;

/**
 * LLM politika katmanı (spec 3.5 katman 2): Meta Advertising Standards'a göre
 * risk skoru + gerekçe + düzeltilmiş metin önerisi. Kural motoruyla birleştirilir.
 */
export const PolicyRiskSchema = z
  .object({
    risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
    reason: z.string().trim().min(1).max(1000),
    correctedCopy: z.string().trim().max(2000).optional(),
  })
  .strict();
export type PolicyRiskAssessment = z.infer<typeof PolicyRiskSchema>;
export const POLICY_RISK_PROMPT_VERSION = "policy-risk-v1";
const POLICY_RISK_SYSTEM = `You are a Meta Advertising Standards compliance reviewer for health/wellness advertisers.
Assess the ad copy (headline, text, description). Flag risks per Meta policies:
- HIGH: guaranteed/absolute results ("guaranteed", "%100 başarı", "kesin çözüm"), before/after claims, personal or health-condition assumptions about the reader, explicit medical promise or diagnosis.
- MEDIUM: strong wording, superlatives that suggest certainty but are not explicit promises, borderline appearance/outcome language.
- LOW: neutral, factual, service-clarifying copy.
Return ONLY JSON: {"risk":"LOW|MEDIUM|HIGH","reason":"<gerekçe (çıktının dili)","correctedCopy":"<aynı dilde düzeltilmiş kısa reklam metni>"}.`;

export async function classifyRisk(
  adCopy: string,
  key: string,
  model: string,
  transport: typeof fetch = fetch,
): Promise<PolicyRiskAssessment> {
  const response = await transport("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system: POLICY_RISK_SYSTEM,
      messages: [{ role: "user", content: adCopy }],
    }),
  });
  if (!response.ok)
    throw new Error("AI politika risk değerlendirmesi yanıt veremedi.");
  const data = z
    .object({
      content: z.array(
        z.object({ type: z.string(), text: z.string().optional() }),
      ),
    })
    .parse(await response.json());
  const raw = data.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  return PolicyRiskSchema.parse(JSON.parse(raw));
}
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
