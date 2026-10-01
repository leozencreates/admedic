import { z } from "zod";

/**
 * Ajan çıktılarının şemaları. Model çıktısı güvenilmez veridir: alanlar kısaltılır, bilinmeyen pazar/dil null olur,
 * fazla öğeler atılır; şemaya hiç uymayan çıktı reddedilir.
 */

const MARKETS = ["TURKEY", "GERMANY", "UK", "NETHERLANDS", "USA", "GULF", "OTHER"] as const;
const LANGUAGES = ["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"] as const;
const PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;

/** Günlük bütçe önerisi üst sınırı (major birim); aşan değer yok sayılır. */
export const MAX_DAILY_BUDGET = 100_000;

const text = (max: number) => z.string().transform((value) => value.replace(/\s+/g, " ").trim().slice(0, max));
const requiredText = (max: number) => text(max).refine((value) => value.length > 0);
const oneOf = <T extends string>(values: readonly T[]) =>
  z.unknown().transform((value): T | null => {
    const upper = typeof value === "string" ? value.trim().toUpperCase() : "";
    return (values as readonly string[]).includes(upper) ? (upper as T) : null;
  });
const list = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items
        .map((entry) => item.safeParse(entry))
        .filter((result): result is z.SafeParseSuccess<z.output<T>> => result.success)
        .map((result) => result.data)
        .slice(0, max),
    );

export const ProposalSchema = z.object({
  title: requiredText(100),
  market: oneOf(MARKETS).default(null),
  language: oneOf(LANGUAGES).default(null),
  service: z
    .unknown()
    .transform((value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null))
    .default(null),
  angle: requiredText(300),
  dailyBudget: z
    .unknown()
    .transform((value) => (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_DAILY_BUDGET ? value : null))
    .default(null),
  rationale: requiredText(500),
});
export type Proposal = z.output<typeof ProposalSchema>;

export const SpecialistOutputSchema = z.object({
  findings: list(requiredText(300), 3),
  proposals: list(ProposalSchema, 2),
  confidence: z
    .unknown()
    .transform((value) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null))
    .default(null),
});
export type SpecialistOutput = z.output<typeof SpecialistOutputSchema>;

export const LeadOutputSchema = z.object({
  summary: requiredText(600),
  proposals: list(ProposalSchema, 3),
  risks: list(requiredText(300), 3),
});
export type LeadOutput = z.output<typeof LeadOutputSchema>;

export const FinalProposalSchema = ProposalSchema.extend({
  priority: oneOf(PRIORITIES)
    .default(null)
    .transform((value) => value ?? "MEDIUM"),
  sourceTeams: list(requiredText(40), 7),
});
export type FinalProposal = z.output<typeof FinalProposalSchema>;

export const DirectorOutputSchema = z.object({
  decision: requiredText(800),
  proposals: list(FinalProposalSchema, 5),
  rejected: list(z.object({ title: requiredText(100), reason: requiredText(300) }), 5),
});
export type DirectorOutput = z.output<typeof DirectorOutputSchema>;
