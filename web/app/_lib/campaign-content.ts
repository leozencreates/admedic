import type { Prisma } from "@admedic/database";
import { BriefLanguageEnum, DraftSchema, type BriefLanguage } from "@admedic/llm";
import { MetaPublishSpecError, resolveDelivery, type DeliverySpec } from "@admedic/meta-api";
import { z } from "zod";
import type { Actor } from "./auth";
import { HttpError } from "./http";
import { PLANNER_MARKETS } from "./campaign-plan";

/** Bir kampanyaya bağlanabilecek en fazla onaylı stüdyo taslağı. */
export const MAX_CONTENT_DRAFTS = 8;
/** Dil başına en fazla taslak (her taslak ad set başına 2 reklam üretir). */
export const MAX_DRAFTS_PER_LANGUAGE = 3;

/** Yalnızca https bağlantılar (açılış sayfası, gizlilik politikası). */
export const HttpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((v) => v.toLowerCase().startsWith("https://"), "Bağlantı https:// ile başlamalıdır.");

const ContentVariantSchema = z
  .object({
    headline: z.string(),
    text: z.string(),
    description: z.string().optional(),
    cta: z.string(),
  })
  .strict();

const ContentDraftSchema = z
  .object({
    draftId: z.string(),
    draftVersion: z.number().int(),
    name: z.string(),
    language: BriefLanguageEnum,
    service: z.string(),
    variants: z.array(ContentVariantSchema).min(1).max(4),
    instantForm: z.object({ questions: z.array(z.string()) }).strict().optional(),
    whatsapp: z.object({ welcome: z.string() }).strict().optional(),
  })
  .strict();

/**
 * Kampanyaya bağlanan içeriğin değişmez kopyası (spec 3.4/3.6): onaya giden ve Meta'ya gönderilen
 * metin budur. Stüdyo taslağı sonradan düzenlense bile kampanya içeriği değişmez; yeniden bağlamak
 * yalnızca DRAFT/REJECTED kampanyada ve yeniden onayla mümkündür.
 */
export const CampaignContentSchema = z
  .object({
    version: z.literal(1),
    attachedAt: z.string(),
    attachedBy: z.string(),
    landingUrl: z.string().optional(),
    drafts: z.array(ContentDraftSchema).min(1).max(MAX_CONTENT_DRAFTS),
  })
  .strict();
export type CampaignContent = z.infer<typeof CampaignContentSchema>;
export type ContentDraft = CampaignContent["drafts"][number];

export const ContentAttachSchema = z
  .object({
    draftIds: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_CONTENT_DRAFTS),
    landingUrl: HttpsUrlSchema.nullable().optional(),
  })
  .strict();

export function parseCampaignContent(value: unknown): CampaignContent | null {
  if (value == null) return null;
  const parsed = CampaignContentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Taslakları çalışma alanında bulur ve yalnızca APPROVED olanları kabul eder (istenen sırayla).
 * Taslak içeriği şemaya uymuyorsa 422; dil başına sınır aşılırsa 422.
 */
export async function loadApprovedDrafts(
  db: Prisma.TransactionClient,
  workspaceId: string,
  draftIds: readonly string[],
): Promise<ContentDraft[]> {
  const unique = Array.from(new Set(draftIds.map((id) => id.trim())));
  const rows = await db.studioDraft.findMany({ where: { id: { in: unique }, workspaceId } });
  if (rows.length !== unique.length) throw new HttpError(404, "Stüdyo taslağı bulunamadı.");
  const byId = new Map(rows.map((r) => [r.id, r]));
  const drafts: ContentDraft[] = [];
  for (const id of unique) {
    const row = byId.get(id)!;
    if (row.status !== "APPROVED")
      throw new HttpError(409, `Yalnızca onaylı stüdyo taslakları bağlanabilir ("${row.name}" onaylı değil).`);
    const parsed = DraftSchema.safeParse(row.content);
    if (!parsed.success) throw new HttpError(422, `"${row.name}" taslağının içeriği geçersiz; stüdyoda yeniden kaydedin.`);
    const content = parsed.data;
    drafts.push({
      draftId: row.id,
      draftVersion: row.version,
      name: row.name,
      language: content.language,
      service: content.service,
      variants: content.variants.map((v) => ({
        headline: v.headline,
        text: v.text,
        ...(v.description ? { description: v.description } : {}),
        cta: v.cta,
      })),
      ...(content.instantForm ? { instantForm: { questions: [...content.instantForm.questions] } } : {}),
      ...(content.whatsapp ? { whatsapp: { welcome: content.whatsapp.welcome } } : {}),
    });
  }
  const perLanguage = new Map<string, number>();
  for (const d of drafts) perLanguage.set(d.language, (perLanguage.get(d.language) ?? 0) + 1);
  for (const [language, count] of perLanguage)
    if (count > MAX_DRAFTS_PER_LANGUAGE)
      throw new HttpError(422, `Dil başına en fazla ${MAX_DRAFTS_PER_LANGUAGE} taslak bağlanabilir (${language}: ${count}).`);
  return drafts;
}

export function buildContentSnapshot(
  drafts: ContentDraft[],
  actor: Pick<Actor, "userId">,
  landingUrl?: string | null,
): CampaignContent {
  return {
    version: 1,
    attachedAt: new Date().toISOString(),
    attachedBy: actor.userId,
    ...(landingUrl ? { landingUrl } : {}),
    drafts,
  };
}

export function contentLanguages(content: CampaignContent | null): BriefLanguage[] {
  if (!content) return [];
  return Array.from(new Set(content.drafts.map((d) => d.language)));
}

/** Politika kontrolüne beslenen içerik metni: başlıklar, metinler, açıklamalar, form soruları, karşılama. */
export function contentPolicyText(value: unknown): string {
  const content = parseCampaignContent(value);
  if (!content) return "";
  const parts: string[] = [];
  for (const d of content.drafts) {
    for (const v of d.variants) parts.push(v.headline, v.text, v.description ?? "");
    parts.push(...(d.instantForm?.questions ?? []), d.whatsapp?.welcome ?? "");
  }
  return parts.filter((p) => p.trim().length > 0).join("\n");
}

// ---------------------------------------------------------------------------
// Plan yapısı (planlayıcı çıktısı; kampanya kaydındaki `plan` JSON'u)
// ---------------------------------------------------------------------------

export interface PlanMarketShape {
  market: string;
  languages: string[];
}

export interface CampaignPlanShape {
  strategy: "CBO" | "ABO";
  conversionMethod: string;
  markets: PlanMarketShape[];
}

/** Kampanya kaydındaki plan JSON'unu yayın için gereken asgari biçime indirger (geçersizse null). */
export function parsePlanShape(value: unknown): CampaignPlanShape | null {
  if (!value || typeof value !== "object") return null;
  const plan = value as { strategy?: unknown; conversionMethod?: unknown; adSets?: unknown };
  if (!Array.isArray(plan.adSets) || plan.adSets.length === 0) return null;
  const markets: PlanMarketShape[] = [];
  for (const raw of plan.adSets) {
    const a = raw as { market?: unknown; languages?: unknown };
    if (typeof a.market !== "string") return null;
    const languages = Array.isArray(a.languages) ? a.languages.filter((l): l is string => typeof l === "string") : [];
    markets.push({ market: a.market, languages });
  }
  return {
    strategy: plan.strategy === "ABO" ? "ABO" : "CBO",
    conversionMethod: typeof plan.conversionMethod === "string" ? plan.conversionMethod : "landing_form",
    markets,
  };
}

/**
 * Hedef × dönüşüm yöntemi Meta'da yayınlanabilir mi? Planlayıcı çıktısı istemciyle paylaşıldığı için
 * (Meta paketine bağımlı olamaz) bu kontrol sunucuda plana eklenir: yayınlanamayacak plan kaydedilmez.
 */
export function deliveryBlockingReason(objective: string, conversionMethod: string): string | null {
  try {
    resolveDelivery(objective, conversionMethod);
    return null;
  } catch (error) {
    return error instanceof MetaPublishSpecError ? error.message : "Kampanya hedefi ile dönüşüm yöntemi birlikte yayınlanamıyor.";
  }
}

/** Plan yayınlanamayacak bir hedef × yöntem birleşimi içeriyorsa gerekçeyi plana engel olarak ekler. */
export function withDeliveryCheck<T extends { objective: string; conversionMethod: string; blocked: boolean; blockingReasons: string[] }>(plan: T): T {
  const reason = deliveryBlockingReason(plan.objective, plan.conversionMethod);
  if (!reason || plan.blockingReasons.includes(reason)) return plan;
  return { ...plan, blocked: true, blockingReasons: [...plan.blockingReasons, reason] };
}

export function marketLabel(market: string): string {
  return PLANNER_MARKETS[market] ?? market;
}

export interface MarketCoverage {
  market: string;
  languages: string[];
  /** İçeriği olan diller (ad set bu dillerde yayınlanır). */
  covered: string[];
  /** İçeriği olmayan diller (hedeflenmez; uyarı). */
  missing: string[];
}

export function marketCoverage(plan: CampaignPlanShape, content: CampaignContent | null): MarketCoverage[] {
  const langs = new Set<string>(contentLanguages(content));
  return plan.markets.map((m) => ({
    market: m.market,
    languages: m.languages,
    covered: m.languages.filter((l) => langs.has(l)),
    missing: m.languages.filter((l) => !langs.has(l)),
  }));
}

export interface PublishReadiness {
  ready: boolean;
  /** Engelleyici eksikler (onaya gönderme ve yayın bunlar giderilmeden yapılamaz). */
  reasons: string[];
  /** Engellemeyen uyarılar (ör. içeriği olmayan dil hedeflenmez). */
  warnings: string[];
  delivery: DeliverySpec | null;
  coverage: MarketCoverage[];
}

/**
 * Meta'ya eksiksiz yayın için kampanyanın hazır olup olmadığı (Meta çağrısı yapmaz):
 * hedef × dönüşüm yöntemi birleşimi, onaylı içerik, her pazarda en az bir içerikli dil, görsel,
 * açılış sayfası URL'si (web) ve gizlilik politikası (Instant Form).
 */
export function publishReadiness(input: {
  objective: string | null;
  plan: unknown;
  content: unknown;
  imageHash: string | null;
  privacyPolicyUrl: string | null;
}): PublishReadiness {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const plan = parsePlanShape(input.plan);
  if (!plan)
    return {
      ready: false,
      reasons: ["Meta'ya yayın için planlayıcıdan oluşturulmuş pazar/ad set yapısı gerekli."],
      warnings,
      delivery: null,
      coverage: [],
    };
  let delivery: DeliverySpec | null = null;
  try {
    delivery = resolveDelivery(input.objective ?? "", plan.conversionMethod);
  } catch (error) {
    reasons.push(error instanceof MetaPublishSpecError ? error.message : "Kampanya hedefi ile dönüşüm yöntemi birlikte yayınlanamıyor.");
  }
  const content = parseCampaignContent(input.content);
  const coverage = marketCoverage(plan, content);
  if (!content) {
    reasons.push("Onaylı reklam içeriği bağlanmadı (Kreatif Stüdyo'dan onaylı taslak seçin).");
  } else {
    for (const c of coverage) {
      if (c.covered.length === 0)
        reasons.push(`${marketLabel(c.market)} pazarı için onaylı içerik yok (diller: ${c.languages.join(", ") || "—"}).`);
      else if (c.missing.length > 0)
        warnings.push(`${marketLabel(c.market)}: ${c.missing.join(", ")} dilinde içerik yok; bu dil hedeflenmeyecek.`);
    }
  }
  if (!input.imageHash) reasons.push("Reklam görseli yüklenmedi.");
  if (delivery?.link === "WEBSITE" && !content?.landingUrl)
    reasons.push("Açılış sayfası yöntemi için https açılış sayfası bağlantısı gerekli.");
  if (delivery?.link === "LEAD_FORM" && !input.privacyPolicyUrl)
    reasons.push("Instant Form için kuruluş ayarlarında https gizlilik politikası bağlantısı gerekli.");
  return { ready: reasons.length === 0, reasons, warnings, delivery, coverage };
}
