import { prisma, type Prisma } from "@admedic/database";
import {
  AD_LOCALE_QUERIES,
  buildAdBody,
  buildAdCreativeBody,
  buildAdSetBody,
  buildLeadFormBody,
  createMetaClient,
  isPublishLanguage,
  MetaGraphError,
  MOCK_AD_ACCOUNT_ID,
  pickLocaleKeys,
  type MetaClientLike,
  type PublishLanguage,
} from "@admedic/meta-api";
import { isAdmedicError } from "@admedic/shared";
import type { Actor } from "./auth";
import { logAudit } from "./audit";
import { HttpError } from "./http";
import { checkPolicyWithRules } from "./policy-loader";
import { campaignPolicyText, clinicPolicyContext, lockCampaignRow, ownedCampaign } from "./campaign-workflow";
import {
  contentLanguages,
  marketLabel,
  parseCampaignContent,
  parsePlanShape,
  publishReadiness,
  type CampaignContent,
  type ContentDraft,
} from "./campaign-content";
import { splitEvenly } from "./campaign-budget";
import { leadFormTexts } from "./lead-form-texts";
import { requireLiveMetaConnection, resolvePublishPage } from "./meta-connection";
import { requireSpendAuthority } from "./spend-authority";
import { assertWithinMonthlyCap } from "./spend-cap";

/** Eşzamanlı yayın isteklerini engelleyen kilidin ömrü (süresi dolan kilit geçersizdir). */
const PUBLISH_LOCK_MS = 90_000;
/**
 * Tek istekte Meta çağrılarına ayrılan süre. Dolduğunda ilerleme kaydedilir ve `IN_PROGRESS` döner;
 * istemci "Yayınla"yı yeniden çağırarak kaldığı yerden sürdürür (uç `maxDuration=60`).
 */
export const PUBLISH_STEP_BUDGET_MS = 40_000;

export type PublishStep = "structure" | "campaign" | "locales" | "leadForms" | "adSets" | "creatives" | "ads" | "complete";

const STEP_LABEL: Record<PublishStep, string> = {
  structure: "ad set yapısı",
  campaign: "kampanya",
  locales: "dil hedeflemesi",
  leadForms: "lead formu",
  adSets: "ad set",
  creatives: "kreatif",
  ads: "reklam",
  complete: "tamamlama",
};

/**
 * Meta yayın ilerlemesi (`Campaign.publishState`). Oluşturulan her Meta nesnesinin kimliği, çağrıdan
 * hemen sonra yazılır; yarım kalan yayın bir sonraki "Yayınla" çağrısında kaldığı yerden sürer ve
 * aynı nesne ikinci kez oluşturulmaz. Kampanya ve ad set kimlikleri kendi satırlarında, reklamlar
 * `Ad` satırlarında tutulur.
 */
export interface PublishState {
  version: 1;
  startedAt: string;
  startedBy: string;
  attempts: number;
  pageId?: string;
  /** Ad set'ler pazar × içerik dili olarak bölündü mü (bir kez, ilk yayın denemesinde). */
  structured?: boolean;
  /** Dil → Meta locale anahtarları (`search?type=adlocale`). */
  locales: Record<string, number[]>;
  /** Stüdyo taslağı → Meta lead formu kimliği (Instant Form). */
  leadForms: Record<string, string>;
  /** `${draftId}:${varyantSırası}` → Meta kreatif kimliği. */
  creatives: Record<string, string>;
  completedAt?: string;
  lastError?: { step: PublishStep; message: string; at: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringRecord(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export function parsePublishState(value: unknown): PublishState | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const locales: Record<string, number[]> = {};
  if (isRecord(value.locales))
    for (const [lang, keys] of Object.entries(value.locales))
      if (Array.isArray(keys)) locales[lang] = keys.filter((k): k is number => Number.isInteger(k));
  const lastError = isRecord(value.lastError) ? value.lastError : null;
  return {
    version: 1,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date(0).toISOString(),
    startedBy: typeof value.startedBy === "string" ? value.startedBy : "",
    attempts: typeof value.attempts === "number" ? value.attempts : 0,
    ...(typeof value.pageId === "string" ? { pageId: value.pageId } : {}),
    ...(value.structured === true ? { structured: true } : {}),
    locales,
    leadForms: stringRecord(value.leadForms),
    creatives: stringRecord(value.creatives),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    ...(lastError && typeof lastError.message === "string"
      ? {
          lastError: {
            step: (typeof lastError.step === "string" ? lastError.step : "campaign") as PublishStep,
            message: lastError.message,
            at: typeof lastError.at === "string" ? lastError.at : "",
          },
        }
      : {}),
  };
}

export interface PublishProgress {
  /**
   * NOT_STARTED/IN_PROGRESS/COMPLETE: Admedic'in tam yayın akışı. EXTERNAL: Meta'da var ama bu akışla
   * kurulmadı (Meta'dan senkronlanan veya eski akışla yalnızca kampanya olarak yayınlanan kayıt).
   */
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "EXTERNAL";
  campaignCreated: boolean;
  adSets: { total: number; published: number };
  ads: { expected: number; published: number };
  leadForms: number;
  creatives: number;
  lastError: { step: string; message: string; at: string } | null;
}

interface AdSetRowLike {
  metaAdSetId: string | null;
  targeting: Prisma.JsonValue | null;
}

function rowLanguages(targeting: Prisma.JsonValue | null): string[] {
  const t = isRecord(targeting) ? targeting : {};
  if (typeof t.language === "string") return [t.language];
  const list = Array.isArray(t.languages) ? t.languages : Array.isArray(t.locales) ? t.locales : [];
  return list.filter((l): l is string => typeof l === "string");
}

/** Beklenen reklam sayısı: her ad set × o ad set dilindeki taslaklar × varyantlar. */
export function expectedAdCount(rows: ReadonlyArray<AdSetRowLike>, content: CampaignContent | null): number {
  if (!content) return 0;
  let total = 0;
  for (const row of rows) {
    const langs = new Set(rowLanguages(row.targeting));
    for (const draft of content.drafts) if (langs.has(draft.language)) total += draft.variants.length;
  }
  return total;
}

export function summarizePublishProgress(input: {
  metaCampaignId: string | null;
  workflowStatus: string;
  publishState: unknown;
  content: unknown;
  adSets: ReadonlyArray<AdSetRowLike>;
  publishedAds: number;
}): PublishProgress {
  const state = parsePublishState(input.publishState);
  const content = parseCampaignContent(input.content);
  const status: PublishProgress["status"] = state?.completedAt
    ? "COMPLETE"
    : state || (input.metaCampaignId && input.workflowStatus === "APPROVED")
      ? "IN_PROGRESS"
      : input.metaCampaignId
        ? "EXTERNAL"
        : "NOT_STARTED";
  return {
    status,
    campaignCreated: Boolean(input.metaCampaignId),
    adSets: { total: input.adSets.length, published: input.adSets.filter((a) => a.metaAdSetId).length },
    ads: { expected: expectedAdCount(input.adSets, content), published: input.publishedAds },
    leadForms: Object.keys(state?.leadForms ?? {}).length,
    creatives: Object.keys(state?.creatives ?? {}).length,
    lastError: state?.lastError ?? null,
  };
}

async function loadProgress(campaignId: string, metaCampaignId: string | null, state: PublishState | null, content: unknown) {
  const [adSets, publishedAds] = await Promise.all([
    prisma.adSet.findMany({ where: { campaignId }, select: { metaAdSetId: true, targeting: true } }),
    prisma.ad.count({ where: { adSet: { campaignId }, metaAdId: { not: null } } }),
  ]);
  return summarizePublishProgress({ metaCampaignId, workflowStatus: "APPROVED", publishState: state, content, adSets, publishedAds });
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

class PublishYield extends Error {}

function describePublishError(error: unknown): string {
  if (error instanceof MetaGraphError) {
    const { code, subcode } = error.detail;
    const tag = code !== undefined ? ` (#${code}${subcode !== undefined ? `/${subcode}` : ""})` : "";
    return `Meta hatası${tag}: ${error.message}`;
  }
  if (error instanceof HttpError) return error.message;
  if (isAdmedicError(error)) return error.message;
  return "Beklenmeyen hata (veritabanı veya ağ).";
}

function publishErrorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (isAdmedicError(error)) return error.status;
  return 503;
}

type PublishRow = {
  id: string;
  name: string;
  metaAdSetId: string | null;
  dailyBudget: number | null;
  language: PublishLanguage;
  countries: string[];
  ageMin: number;
  ageMax: number;
};

function toPublishRow(row: {
  id: string;
  name: string;
  metaAdSetId: string | null;
  dailyBudget: number | null;
  targeting: Prisma.JsonValue | null;
}): PublishRow {
  const t = isRecord(row.targeting) ? row.targeting : {};
  const language = typeof t.language === "string" ? t.language : "";
  if (!isPublishLanguage(language))
    throw new HttpError(422, `"${row.name}" ad set'inin dili belirlenemedi; kampanyayı arşivleyip yeniden oluşturun.`);
  const geo = isRecord(t.geo_locations) ? t.geo_locations : {};
  const countries = Array.isArray(geo.countries) ? geo.countries.filter((c): c is string => typeof c === "string") : [];
  return {
    id: row.id,
    name: row.name,
    metaAdSetId: row.metaAdSetId,
    dailyBudget: row.dailyBudget,
    language,
    countries,
    ageMin: typeof t.age_min === "number" ? t.age_min : 18,
    ageMax: typeof t.age_max === "number" ? t.age_max : 65,
  };
}

/**
 * Planlayıcının pazar başına ad set'lerini pazar × içerik dili olarak böler (bir kez, Meta'ya ilk
 * yazımdan önce): Meta reklam dilini kullanıcının diline göre seçmediği için her ad set yalnızca
 * içeriği olan tek bir dili hedefler. ABO'da pazar payı diller arasında eşit bölünür (toplam korunur).
 */
async function structureAdSets(campaignId: string, campaignName: string, content: CampaignContent): Promise<void> {
  const languages = new Set<string>(contentLanguages(content));
  await prisma.$transaction(async (tx) => {
    const rows = await tx.adSet.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
    if (rows.length === 0) throw new HttpError(422, "Kampanyanın ad set kaydı yok; planlayıcıdan yeniden oluşturun.");
    if (rows.some((r) => r.metaAdSetId)) return; // Meta'ya yazılmış yapı değiştirilmez.
    for (const row of rows) {
      const t = isRecord(row.targeting) ? row.targeting : {};
      if (typeof t.language === "string") continue; // zaten bölünmüş
      const market = typeof t.market === "string" ? t.market : "";
      const covered = rowLanguages(row.targeting).filter((l) => languages.has(l));
      if (!market || covered.length === 0)
        throw new HttpError(422, `${marketLabel(market || row.name)} pazarı için onaylı içerik yok.`);
      const shares = row.dailyBudget != null ? splitEvenly(row.dailyBudget, covered.length) : covered.map(() => null);
      for (const [i, language] of covered.entries()) {
        const data = {
          name: `${campaignName} — ${marketLabel(market)} · ${language}`,
          dailyBudget: shares[i] ?? null,
          targeting: json({ ...t, locales: [language], languages: [language], language }),
        };
        if (i === 0) await tx.adSet.update({ where: { id: row.id }, data });
        else
          await tx.adSet.create({
            data: {
              ...data,
              campaignId,
              workspaceId: row.workspaceId,
              status: "PAUSED",
              bidStrategy: row.bidStrategy,
            },
          });
      }
    }
  });
}

export interface PublishResult {
  status: "COMPLETE" | "IN_PROGRESS";
  metaCampaignId: string | null;
  policyWarning: string | null;
  metaReviewStatus?: string;
  warnings: string[];
  progress: PublishProgress;
}

/**
 * Onaylı kampanyayı Meta'da eksiksiz ve PAUSED olarak kurar (spec 3.3/3.6):
 * kampanya → dil hedeflemesi → (Instant Form: taslak başına lead formu) → ad set'ler (pazar × dil)
 * → kreatifler (taslak varyantı başına) → reklamlar (ad set × taslak × varyant). Hiçbir nesne ACTIVE
 * oluşturulmaz; harcama yalnızca yetkili ACTIVATE ile başlar. Her adım kaydedilir; hata veya süre
 * dolması halinde yeniden çağrı kaldığı yerden sürer.
 */
export async function publishCampaign(
  actor: Actor,
  id: string,
  opts: { budgetMs?: number; meta?: MetaClientLike } = {},
): Promise<PublishResult> {
  const campaign = await prisma.campaign.findFirst({
    where: { id, workspaceId: actor.workspaceId, adAccount: { orgId: actor.orgId } },
    include: { adAccount: { select: { id: true, metaAccountId: true, connectionId: true, currency: true } } },
  });
  if (!campaign) throw new HttpError(404, "Kampanya bulunamadı.");
  if (campaign.workflowStatus === "PUBLISHED_PAUSED" || campaign.workflowStatus === "ACTIVE")
    throw new HttpError(409, "Kampanya zaten Meta'da yayınlandı.");
  if (campaign.workflowStatus !== "APPROVED") throw new HttpError(409, "Kampanya henüz onaylanmadı.");

  // Harcamaya giden yol: taze kural seti + klinik yasaklı ifadeleri, Meta'ya gidecek içerik dahil.
  const clinic = await clinicPolicyContext(actor.workspaceId);
  const policy = await checkPolicyWithRules(campaignPolicyText(campaign), clinic.bannedPhrases);
  if (policy.risk === "HIGH") throw new HttpError(422, "İçerik kontrolündeki yüksek riskli ifadeleri düzeltin.");
  const policyWarning = policy.risk === "MEDIUM" ? policy.findings.map((f) => f.reason).join("; ") : null;

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: actor.orgId },
    select: { privacyPolicyUrl: true, consentText: true },
  });
  const readiness = publishReadiness({
    objective: campaign.objective,
    plan: campaign.plan,
    content: campaign.content,
    imageHash: campaign.imageHash,
    privacyPolicyUrl: org.privacyPolicyUrl,
  });
  const content = parseCampaignContent(campaign.content);
  const plan = parsePlanShape(campaign.plan);
  if (!readiness.ready || !readiness.delivery || !content || !plan || !campaign.imageHash)
    throw new HttpError(422, readiness.reasons.join(" "));
  const delivery = readiness.delivery;
  const imageHash = campaign.imageHash;

  if (!campaign.adAccount.connectionId) throw new HttpError(400, "Meta bağlantısı yapılandırılmadı.");
  const live = await requireLiveMetaConnection(campaign.adAccount.connectionId, actor.orgId);
  // Canlı modda mock hesaba düşülmez: gerçek hesap kimliği zorunlu.
  const rawAccountId = campaign.adAccount.metaAccountId ?? (live.mockMode ? MOCK_AD_ACCOUNT_ID : null);
  if (!rawAccountId) throw new HttpError(400, "Reklam hesabının Meta kimliği (metaAccountId) tanımlı değil.");
  const accountId = rawAccountId.replace(/^act_/, "");
  const page = await resolvePublishPage({
    orgId: actor.orgId,
    connectionId: campaign.adAccount.connectionId,
    mockMode: live.mockMode,
    needPageToken: delivery.link === "LEAD_FORM",
  });
  const prior = parsePublishState(campaign.publishState);
  if (prior?.pageId && prior.pageId !== page.pageId)
    throw new HttpError(
      409,
      "Yarım kalan yayın başka bir Facebook Sayfasıyla başlatıldı; sayfa seçimini geri alın veya kampanyayı arşivleyip yeniden oluşturun.",
    );

  const lockedAt = new Date();
  const locked = await prisma.campaign.updateMany({
    where: {
      id,
      workspaceId: actor.workspaceId,
      workflowStatus: "APPROVED",
      OR: [{ publishLockedUntil: null }, { publishLockedUntil: { lt: lockedAt } }],
    },
    data: { publishLockedUntil: new Date(lockedAt.getTime() + PUBLISH_LOCK_MS) },
  });
  if (locked.count !== 1)
    throw new HttpError(409, "Bu kampanyanın Meta yayını şu anda sürüyor; birkaç saniye sonra tekrar deneyin.");

  const state: PublishState = prior ?? {
    version: 1,
    startedAt: lockedAt.toISOString(),
    startedBy: actor.userId,
    attempts: 0,
    locales: {},
    leadForms: {},
    creatives: {},
  };
  state.attempts += 1;
  delete state.lastError;
  state.pageId = page.pageId;

  const meta: MetaClientLike = opts.meta ?? createMetaClient();
  const token = live.token;
  const deadline = Date.now() + (opts.budgetMs ?? PUBLISH_STEP_BUDGET_MS);
  let calls = 0;
  let step: PublishStep = "structure";
  let metaCampaignId = campaign.metaCampaignId;
  let metaReviewStatus: string | undefined;

  const saveState = () => prisma.campaign.update({ where: { id }, data: { publishState: json(state) } });
  /** Her Meta çağrısından önce: süre dolduysa (ve bu istekte en az bir ilerleme varsa) dur. */
  const beforeMetaCall = () => {
    if (calls > 0 && Date.now() >= deadline) throw new PublishYield();
    calls++;
  };
  /** Meta'da oluşan nesne yerelde yazılamazsa yetim kaydı denetime işlenir (elle eşleştirme/silme). */
  const recordCreated = async (kind: string, metaId: string, write: () => Promise<unknown>) => {
    try {
      await write();
    } catch {
      console.error(`[campaign-publish] yetim Meta ${kind}: ${metaId} (yerel ${id})`);
      try {
        await logAudit({
          actor,
          action: "CAMPAIGN_PUBLISH_ORPHANED",
          entityType: "CAMPAIGN",
          entityId: id,
          after: {
            kind,
            metaId,
            ...(kind === "kampanya" ? { metaCampaignId: metaId } : {}),
            warning: `Meta'da PAUSED ${kind} oluşturuldu ancak yerel kayıt yazılamadı; elle eşleştirin veya Meta'da silin.`,
          },
        });
      } catch {
        // Denetim kaydı da yazılamadı; konsol satırı tek iz.
      }
      throw new HttpError(503, `Meta'da ${kind} oluşturuldu (${metaId}) ancak yerel kayıt güncellenemedi; destek ile eşleştirin.`);
    }
  };

  try {
    // 1) Ad set yapısı: pazar × içerik dili (yalnızca yerel, bir kez).
    step = "structure";
    if (!state.structured) {
      await structureAdSets(id, campaign.name, content);
      state.structured = true;
      await saveState();
    }
    const rows = (
      await prisma.adSet.findMany({ where: { campaignId: id }, orderBy: { createdAt: "asc" } })
    ).map(toPublishRow);
    const draftsFor = (language: string): ContentDraft[] => content.drafts.filter((d) => d.language === language);
    for (const row of rows)
      if (draftsFor(row.language).length === 0)
        throw new HttpError(422, `"${row.name}" ad set'i için ${row.language} dilinde onaylı içerik yok.`);
    const usedLanguages = Array.from(new Set(rows.map((r) => r.language)));
    const usedDrafts = content.drafts.filter((d) => usedLanguages.includes(d.language));

    // 2) Kampanya (PAUSED; CBO'da bütçe kampanyada, ABO'da ad set'lerde).
    step = "campaign";
    if (!metaCampaignId) {
      beforeMetaCall();
      const created = await meta.createCampaign(
        {
          accountId,
          name: campaign.name,
          objective: campaign.objective ?? "OUTCOME_LEADS",
          // DB minor unit tutar; Meta'ya dönüşümsüz gider (ADR-0011).
          dailyBudgetCents: campaign.dailyBudget ?? undefined,
          budgetStrategy: plan.strategy,
          status: "PAUSED",
        },
        token,
      );
      if (!created.success || !created.campaignId) throw new HttpError(502, "Meta kampanya oluşturma işlemi başarısız.");
      const newCampaignId = created.campaignId;
      let metaRejectionReason: Prisma.InputJsonValue | undefined;
      if (created.reviewFeedbackGlobal && Object.keys(created.reviewFeedbackGlobal).length > 0) {
        metaReviewStatus = "DISAPPROVED";
        metaRejectionReason = json({
          global: created.reviewFeedbackGlobal,
          placement_specific: created.reviewFeedbackPlacements ?? {},
        });
      }
      await recordCreated("kampanya", newCampaignId, async () => {
        const moved = await prisma.campaign.updateMany({
          where: { id, workflowStatus: "APPROVED", metaCampaignId: null },
          data: {
            metaCampaignId: newCampaignId,
            syncedAt: new Date(),
            ...(metaReviewStatus ? { metaReviewStatus } : {}),
            ...(metaRejectionReason ? { metaRejectionReason } : {}),
          },
        });
        if (moved.count !== 1) throw new Error("kampanya durumu değişti");
      });
      metaCampaignId = newCampaignId;
    }

    // 3) Dil hedeflemesi: uygulama dili → Meta locale anahtarları (bulunamazsa yalnızca ülke hedeflenir).
    step = "locales";
    for (const language of usedLanguages) {
      if (state.locales[language]) continue;
      beforeMetaCall();
      const found = await meta.searchAdLocales(AD_LOCALE_QUERIES[language], token);
      state.locales[language] = pickLocaleKeys(language, found);
      await saveState();
    }

    // 4) Instant Form: taslak başına lead formu (taslağın dili, soruları, rıza kutusu, gizlilik politikası).
    step = "leadForms";
    if (delivery.link === "LEAD_FORM") {
      if (!page.pageToken || !org.privacyPolicyUrl)
        throw new HttpError(422, "Instant Form için sayfa token'ı ve gizlilik politikası bağlantısı gerekli.");
      for (const draft of usedDrafts) {
        if (state.leadForms[draft.draftId]) continue;
        const texts = leadFormTexts(draft.language, org.consentText);
        const body = buildLeadFormBody({
          name: `${campaign.name} — ${draft.name} (${draft.language}) #${id.slice(-6)}`,
          language: draft.language,
          customQuestions: draft.instantForm?.questions ?? [],
          privacyPolicyUrl: org.privacyPolicyUrl,
          privacyLinkText: texts.privacyLink,
          consent: { title: texts.title, body: texts.body, checkboxText: texts.checkbox },
        });
        beforeMetaCall();
        const form = await meta.createLeadForm(page.pageId, body, page.pageToken);
        state.leadForms[draft.draftId] = form.id;
        await recordCreated("lead formu", form.id, saveState);
      }
    }

    // 5) Ad set'ler (PAUSED; ABO'da günlük bütçe payı ad set'te).
    step = "adSets";
    for (const row of rows) {
      if (row.metaAdSetId) continue;
      const body = buildAdSetBody({
        campaignId: metaCampaignId,
        name: row.name,
        delivery,
        targeting: {
          countries: row.countries,
          localeKeys: state.locales[row.language] ?? [],
          ageMin: row.ageMin,
          ageMax: row.ageMax,
        },
        dailyBudgetCents: plan.strategy === "ABO" ? row.dailyBudget : null,
        pageId: page.pageId,
      });
      beforeMetaCall();
      const created = await meta.createAdSet(accountId, body, token);
      await recordCreated("ad set", created.id, async () => {
        const moved = await prisma.adSet.updateMany({
          where: { id: row.id, metaAdSetId: null },
          data: { metaAdSetId: created.id, status: "PAUSED", syncedAt: new Date() },
        });
        if (moved.count !== 1) throw new Error("ad set durumu değişti");
      });
      row.metaAdSetId = created.id;
    }

    // 6) Kreatifler: taslak varyantı başına bir kreatif (aynı dildeki ad set'lerde ortak kullanılır).
    step = "creatives";
    for (const draft of usedDrafts) {
      for (const [index, variant] of draft.variants.entries()) {
        const key = `${draft.draftId}:${index}`;
        if (state.creatives[key]) continue;
        const body = buildAdCreativeBody({
          name: `${campaign.name} — ${draft.name} V${index + 1}`,
          pageId: page.pageId,
          delivery,
          imageHash,
          headline: variant.headline,
          text: variant.text,
          description: variant.description,
          cta: variant.cta,
          leadFormId: state.leadForms[draft.draftId],
          landingUrl: content.landingUrl,
        });
        beforeMetaCall();
        const created = await meta.createAdCreative(accountId, body, token);
        state.creatives[key] = created.id;
        await recordCreated("kreatif", created.id, saveState);
      }
    }

    // 7) Reklamlar: ad set × (ad set dilindeki taslak) × varyant; hepsi PAUSED.
    step = "ads";
    for (const row of rows) {
      const existing = await prisma.ad.findMany({ where: { adSetId: row.id }, select: { creative: true } });
      const done = new Set(
        existing.map((a) => (isRecord(a.creative) && typeof a.creative.key === "string" ? a.creative.key : "")),
      );
      for (const draft of draftsFor(row.language)) {
        for (const [index, variant] of draft.variants.entries()) {
          const key = `${draft.draftId}:${index}`;
          if (done.has(key)) continue;
          const creativeId = state.creatives[key];
          if (!creativeId || !row.metaAdSetId) throw new HttpError(409, "Yayın ilerlemesi tutarsız; tekrar deneyin.");
          const name = `${row.name} — ${draft.name} V${index + 1}`;
          beforeMetaCall();
          const created = await meta.createAd(accountId, buildAdBody({ name, adSetId: row.metaAdSetId, creativeId }), token);
          await recordCreated("reklam", created.id, () =>
            prisma.ad.create({
              data: {
                adSetId: row.id,
                workspaceId: actor.workspaceId,
                metaAdId: created.id,
                name: name.slice(0, 400),
                status: "PAUSED",
                metaCreativeId: creativeId,
                creative: json({
                  key,
                  draftId: draft.draftId,
                  draftVersion: draft.draftVersion,
                  variantIndex: index,
                  language: draft.language,
                  headline: variant.headline,
                  cta: variant.cta,
                  imageHash,
                }),
                syncedAt: new Date(),
              },
            }),
          );
          done.add(key);
        }
      }
    }

    // 8) Tamamlandı: PUBLISHED_PAUSED (harcama yok; etkinleştirme yetkili ACTIVATE ile).
    step = "complete";
    const completed: PublishState = { ...state, completedAt: new Date().toISOString() };
    const progress = await loadProgress(id, metaCampaignId, completed, campaign.content);
    await prisma.$transaction(
      async (tx) => {
        await lockCampaignRow(tx, actor, id);
        const moved = await tx.campaign.updateMany({
          where: { id, workspaceId: actor.workspaceId, workflowStatus: "APPROVED", metaCampaignId },
          data: {
            workflowStatus: "PUBLISHED_PAUSED",
            status: "PAUSED",
            publishState: json(completed),
            publishLockedUntil: null,
            syncedAt: new Date(),
          },
        });
        if (moved.count !== 1)
          throw new HttpError(409, "Kampanya durumu eşzamanlı olarak değişti; yenileyip tekrar deneyin.");
        await logAudit(
          {
            actor,
            action: "CAMPAIGN_PUBLISHED",
            entityType: "CAMPAIGN",
            entityId: id,
            before: { status: campaign.status, workflowStatus: campaign.workflowStatus, metaCampaignId: campaign.metaCampaignId },
            after: {
              status: "PAUSED",
              workflowStatus: "PUBLISHED_PAUSED",
              metaCampaignId,
              action: "PUBLISH",
              note: "Meta'da kampanya, ad set'ler, kreatifler ve reklamlar PAUSED olarak oluşturuldu.",
              // Orta risk uyarısı yalnızca audit + yanıtta; metaRejectionReason gerçek Meta geri bildirimine ayrılmıştır.
              policyWarning,
              pageId: page.pageId,
              adSets: progress.adSets.published,
              ads: progress.ads.published,
              creatives: progress.creatives,
              leadForms: progress.leadForms,
              attempts: completed.attempts,
              ...(metaReviewStatus ? { metaReviewStatus } : {}),
            },
          },
          tx,
        );
      },
      { timeout: 10_000 },
    );
    return {
      status: "COMPLETE",
      metaCampaignId,
      policyWarning,
      ...(metaReviewStatus ? { metaReviewStatus } : {}),
      warnings: readiness.warnings,
      progress,
    };
  } catch (error) {
    if (error instanceof PublishYield) {
      await prisma.campaign.update({ where: { id }, data: { publishState: json(state), publishLockedUntil: null } });
      return {
        status: "IN_PROGRESS",
        metaCampaignId,
        policyWarning,
        ...(metaReviewStatus ? { metaReviewStatus } : {}),
        warnings: readiness.warnings,
        progress: await loadProgress(id, metaCampaignId, state, campaign.content),
      };
    }
    const message = describePublishError(error);
    state.lastError = { step, message, at: new Date().toISOString() };
    try {
      await prisma.campaign.update({ where: { id }, data: { publishState: json(state), publishLockedUntil: null } });
    } catch {
      // Kilit süresi dolunca kendiliğinden geçersizleşir.
    }
    try {
      await logAudit({
        actor,
        action: "CAMPAIGN_PUBLISH_FAILED",
        entityType: "CAMPAIGN",
        entityId: id,
        after: { step, message, metaCampaignId, attempts: state.attempts },
      });
    } catch {
      // Denetim kaydı yazılamadı; yanıt yine de hatayı bildirir.
    }
    throw new HttpError(
      publishErrorStatus(error),
      `Meta yayını "${STEP_LABEL[step]}" adımında durdu: ${message} Sorunu giderip "Yayınla" ile kaldığı yerden devam edebilirsiniz.`,
    );
  }
}

export interface ActivateResult {
  policyWarning: string | null;
  adsActivated: number;
  adSetsActivated: number;
}

/**
 * Harcamayı başlatan tek yol (spec 3.6): yalnızca Owner veya Owner'ın harcama yetkisi verdiği üye,
 * yayını tamamlanmış (PUBLISHED_PAUSED) ve en az bir reklamı olan kampanyayı, toplam aylık üst sınır
 * içinde etkinleştirebilir. Sınır kontrolü kuruluş satırı kilitliyken yapılır ve kampanya yerelde ACTIVE
 * sayılarak eşzamanlı etkinleştirmelere karşı rezerve edilir; Meta başarısız olursa rezervasyon geri alınır.
 * Meta'da sıra: reklamlar → ad set'ler → kampanya (kampanya en son; teslimat hazır yapıyla başlar).
 */
export async function activateCampaign(actor: Actor, id: string): Promise<ActivateResult> {
  await requireSpendAuthority(actor);
  const campaign = await ownedCampaign(actor, id);
  if (campaign.workflowStatus !== "PUBLISHED_PAUSED" || !campaign.metaCampaignId)
    throw new HttpError(409, "Önce kampanyayı yayınlayın.");
  const metaCampaignId = campaign.metaCampaignId;
  // Tam yayın akışıyla kurulan kampanyada reklam → ad set → kampanya zinciri etkinleştirilir. Meta'dan
  // senkronlanan (Ads Manager'da kurulmuş) veya eski akışla yayınlanmış kampanyada ad set/reklam durumları
  // Meta'da yönetilir; yalnızca kampanya etkinleştirilir (yetki + üst sınır kuralları aynen geçerlidir).
  const managed = Boolean(parsePublishState(campaign.publishState)?.completedAt);
  const [ads, adSets] = managed
    ? await Promise.all([
        prisma.ad.findMany({ where: { adSet: { campaignId: id }, metaAdId: { not: null } }, select: { metaAdId: true } }),
        prisma.adSet.findMany({ where: { campaignId: id, metaAdSetId: { not: null } }, select: { metaAdSetId: true } }),
      ])
    : [[], []];
  if (managed && (ads.length === 0 || adSets.length === 0))
    throw new HttpError(409, "Kampanyanın Meta'da reklamı yok; kampanyayı arşivleyip içerikle yeniden oluşturun.");

  const clinic = await clinicPolicyContext(actor.workspaceId);
  const policy = await checkPolicyWithRules(campaignPolicyText(campaign), clinic.bannedPhrases);
  if (policy.risk === "HIGH") throw new HttpError(422, "İçerik kontrolündeki yüksek riskli ifadeleri düzeltin.");
  const policyWarning = policy.risk === "MEDIUM" ? policy.findings.map((f) => f.reason).join("; ") : null;

  if (!campaign.adAccount.connectionId) throw new HttpError(400, "Meta bağlantısı yapılandırılmadı.");
  const live = await requireLiveMetaConnection(campaign.adAccount.connectionId, actor.orgId);
  const meta = createMetaClient();

  // Rezervasyon: yetki + toplam aylık üst sınır, kuruluş satırı kilitliyken.
  const cap = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${actor.orgId} FOR UPDATE`;
      await lockCampaignRow(tx, actor, id);
      const fresh = await ownedCampaign(actor, id, tx);
      if (fresh.workflowStatus !== "PUBLISHED_PAUSED" || fresh.metaCampaignId !== metaCampaignId)
        throw new HttpError(409, "Kampanya durumu eşzamanlı olarak değişti; yenileyip tekrar deneyin.");
      await requireSpendAuthority(actor, tx);
      const check = await assertWithinMonthlyCap(tx, {
        orgId: actor.orgId,
        currency: fresh.adAccount.currency,
        dailyBudgetCents: fresh.dailyBudget ?? 0,
        excludeCampaignId: id,
      });
      await tx.campaign.update({ where: { id }, data: { status: "ACTIVE" } });
      return check;
    },
    { timeout: 10_000 },
  );

  const activate = async (entityType: "ad" | "adset" | "campaign", entityId: string) => {
    const result = await meta.setStatus({ entityType, entityId, status: "ACTIVE" }, live.token);
    if (!result.success) throw new Error("Meta etkinleştirme başarısız");
  };
  let campaignActivated = false;
  try {
    for (const ad of ads) await activate("ad", ad.metaAdId!);
    for (const adSet of adSets) await activate("adset", adSet.metaAdSetId!);
    await activate("campaign", metaCampaignId);
    campaignActivated = true;
    await prisma.$transaction(
      async (tx) => {
        await lockCampaignRow(tx, actor, id);
        const now = new Date();
        const moved = await tx.campaign.updateMany({
          where: { id, workspaceId: actor.workspaceId, workflowStatus: "PUBLISHED_PAUSED", metaCampaignId },
          data: { workflowStatus: "ACTIVE", status: "ACTIVE", syncedAt: now },
        });
        if (moved.count !== 1)
          throw new HttpError(409, "Kampanya durumu eşzamanlı olarak değişti; yenileyip tekrar deneyin.");
        await tx.adSet.updateMany({ where: { campaignId: id, metaAdSetId: { not: null } }, data: { status: "ACTIVE", syncedAt: now } });
        await tx.ad.updateMany({ where: { adSet: { campaignId: id }, metaAdId: { not: null } }, data: { status: "ACTIVE", syncedAt: now } });
        await logAudit(
          {
            actor,
            action: "CAMPAIGN_ACTIVATED",
            entityType: "CAMPAIGN",
            entityId: id,
            before: { status: campaign.status, workflowStatus: campaign.workflowStatus, metaCampaignId },
            after: {
              status: "ACTIVE",
              workflowStatus: "ACTIVE",
              metaCampaignId,
              action: "ACTIVATE",
              note: managed
                ? "Meta'da reklamlar, ad set'ler ve kampanya ACTIVE yapıldı."
                : "Meta'da kampanya ACTIVE yapıldı (ad set/reklam durumları Meta'da yönetiliyor).",
              scope: managed ? "cascade" : "campaign",
              policyWarning,
              adsActivated: ads.length,
              adSetsActivated: adSets.length,
              monthlyCapCents: cap.capCents,
              monthlyCommittedCents: cap.committedCents,
              monthlyProjectedCents: cap.projectedCents,
            },
          },
          tx,
        );
      },
      { timeout: 10_000 },
    );
  } catch (error) {
    // Kampanya Meta'da ACTIVE olduysa ama yerel kayıt yazılamadıysa harcamayı durdurmayı dene.
    if (campaignActivated) {
      try {
        await meta.setStatus({ entityType: "campaign", entityId: metaCampaignId, status: "PAUSED" }, live.token);
      } catch {
        console.error(`[campaign-activate] Meta kampanyası duraklatılamadı: ${metaCampaignId} (yerel ${id})`);
      }
    }
    try {
      await prisma.campaign.updateMany({ where: { id, workflowStatus: "PUBLISHED_PAUSED" }, data: { status: "PAUSED" } });
    } catch {
      // Rezervasyon kalırsa üst sınır hesabında temkinli tarafta kalır.
    }
    try {
      await logAudit({
        actor,
        action: "CAMPAIGN_ACTIVATION_FAILED",
        entityType: "CAMPAIGN",
        entityId: id,
        after: { metaCampaignId, message: describePublishError(error), campaignActivated },
      });
    } catch {
      // Yanıt yine de hatayı bildirir.
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Meta etkinleştirme işlemi başarısız; kampanya PAUSED bırakıldı. Tekrar deneyebilirsiniz.");
  }
  return { policyWarning, adsActivated: ads.length, adSetsActivated: adSets.length };
}
