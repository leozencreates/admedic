import { graphGet, graphPost, getGraphVersion, MetaGraphError } from "./http";
import { appSecretProof } from "./secret-proof";
import { normalizeInsightRow } from "./parse";
import { AD_REVIEW_BATCH_SIZE, AD_REVIEW_FIELDS, parseAdReview, parseAdReviewBatch } from "./review";
import type {
  CreateCampaignInput,
  MetaAccount,
  MetaAd,
  MetaAdReview,
  MetaAdReviewResult,
  MetaAdSet,
  MetaCampaign,
  MetaClientOptions,
  MetaCreateCampaignResult,
  MetaInsightLevel,
  MetaInsightOptions,
  MetaInsightRow,
  MetaOutcomeObjective,
  MetaUpdateResult,
  PlannerObjective,
  SetStatusInput,
  UpdateBudgetInput,
} from "./types";
import { INSIGHT_DEFAULT_FIELDS } from "./types";
import type { AdImageUpload, MetaAdImage, MetaAdLocale, MetaCreatedObject } from "./types";
import type { GraphBody } from "./publish";

export interface MetaClientLike {
  getVersion(): string;
  getAdAccounts(token: string): Promise<MetaAccount[]>;
  listCampaigns(accountId: string, token: string): Promise<MetaCampaign[]>;
  listAdSets(accountId: string, token: string): Promise<MetaAdSet[]>;
  listAds(accountId: string, token: string): Promise<MetaAd[]>;
  getInsights(
    ref: { type: MetaInsightLevel; id: string },
    token: string,
    query?: MetaInsightOptions,
  ): Promise<MetaInsightRow[]>;
  updateBudget(
    input: UpdateBudgetInput,
    token: string,
  ): Promise<MetaUpdateResult>;
  setStatus(input: SetStatusInput, token: string): Promise<MetaUpdateResult>;
  createCampaign(
    input: CreateCampaignInput,
    token: string,
  ): Promise<MetaCreateCampaignResult>;
  getAdReview(adId: string, token: string): Promise<MetaAdReviewResult>;
  /** Reklamların inceleme durumu (çoklu kimlik okuması, istek başına en fazla 50 kimlik). */
  getAdReviews(adIds: string[], token: string): Promise<MetaAdReview[]>;
  /** `POST act_{id}/adsets` — gövde `buildAdSetBody` ile üretilir (status PAUSED). */
  createAdSet(accountId: string, body: GraphBody, token: string): Promise<MetaCreatedObject>;
  /** `POST act_{id}/adcreatives` — gövde `buildAdCreativeBody` ile üretilir. */
  createAdCreative(accountId: string, body: GraphBody, token: string): Promise<MetaCreatedObject>;
  /** `POST act_{id}/ads` — gövde `buildAdBody` ile üretilir (status PAUSED). */
  createAd(accountId: string, body: GraphBody, token: string): Promise<MetaCreatedObject>;
  /** `POST {page_id}/leadgen_forms` — sayfa erişim token'ı ile. */
  createLeadForm(pageId: string, body: GraphBody, pageToken: string): Promise<MetaCreatedObject>;
  /** `POST act_{id}/adimages` (bytes, base64) → görsel hash'i. */
  uploadAdImage(accountId: string, image: AdImageUpload, token: string): Promise<MetaAdImage>;
  /** `GET search?type=adlocale&q=…` → locale anahtarları. */
  searchAdLocales(query: string, token: string): Promise<MetaAdLocale[]>;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

const PLANNER_OBJECTIVE_MAP: Record<PlannerObjective, MetaOutcomeObjective> = {
  MAX_ROAS: "OUTCOME_SALES",
  MAX_CONVERSIONS: "OUTCOME_LEADS",
  MAX_IMPRESSIONS: "OUTCOME_AWARENESS",
};

const META_OUTCOME_OBJECTIVES: ReadonlySet<string> = new Set<MetaOutcomeObjective>([
  "OUTCOME_SALES",
  "OUTCOME_LEADS",
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_APP_PROMOTION",
]);

/**
 * Ürün içi objective'i Meta ODAX objective'ine çevirir:
 * MAX_ROAS → OUTCOME_SALES, MAX_CONVERSIONS → OUTCOME_LEADS, MAX_IMPRESSIONS → OUTCOME_AWARENESS.
 * Zaten `OUTCOME_*` ise aynen döner; bilinmeyen değerde hata fırlatır (Meta'ya geçersiz istek gitmez).
 */
export function toMetaObjective(objective: string): MetaOutcomeObjective {
  const mapped = PLANNER_OBJECTIVE_MAP[objective as PlannerObjective];
  if (mapped) return mapped;
  if (META_OUTCOME_OBJECTIVES.has(objective)) return objective as MetaOutcomeObjective;
  throw new Error(`Desteklenmeyen kampanya objective'i: ${objective}`);
}

/**
 * `POST act_{id}/campaigns` gövdesi. `special_ad_categories` Meta'da zorunludur;
 * sağlık turizmi özel reklam kategorisi (kredi/istihdam/konut/politika) değildir → `[]`.
 * `status` her zaman PAUSED. CBO'da `daily_budget` + teklif stratejisi kampanyadadır ("campaign budget
 * optimization kullanılıyorsa bid_strategy üst kampanyada ayarlanmalı"). ABO'da bütçe ad set'tedir ve
 * v24.0'dan beri `is_adset_budget_sharing_enabled` zorunludur (belirtilmezse 100/4834011); pazar
 * paylarının sabit kalması için `false` gönderilir (docs/meta-constraints.md, 2026-09-27).
 */
export function buildCreateCampaignBody(
  input: CreateCampaignInput,
): Record<string, string | number> {
  const sendBudget =
    input.dailyBudgetCents !== undefined &&
    input.dailyBudgetCents > 0 &&
    input.budgetStrategy !== "ABO";
  return {
    name: input.name,
    objective: toMetaObjective(input.objective),
    status: "PAUSED",
    special_ad_categories: JSON.stringify([]),
    ...(sendBudget
      ? { daily_budget: Math.round(input.dailyBudgetCents!), bid_strategy: "LOWEST_COST_WITHOUT_CAP" }
      : { is_adset_budget_sharing_enabled: "false" }),
  };
}

/** Graph `POST` yanıtından nesne kimliği; yoksa açık hata (Meta'ya giden isteğin sonucu belirsiz kalmaz). */
function createdId(body: unknown, what: string): string {
  const id = (body as { id?: unknown } | null)?.id;
  if (id === undefined || id === null || id === "") throw new Error(`Meta ${what} oluşturmadı: id dönmedi.`);
  return String(id);
}

export class MetaMarketingClient implements MetaClientLike {
  private readonly version: string;
  private readonly fetchFn: typeof fetch;
  private readonly appSecret: string | undefined;

  constructor(options: MetaClientOptions = {}) {
    this.version = getGraphVersion(options.version);
    this.fetchFn = options.fetchFn ?? fetch;
    this.appSecret = options.appSecret || undefined;
  }

  /** GET sorgusu için token + (secret varsa) `appsecret_proof`. */
  private auth(token: string): Record<string, string> {
    const proof = this.appSecret ? appSecretProof(token, this.appSecret) : undefined;
    return proof ? { access_token: token, appsecret_proof: proof } : { access_token: token };
  }

  getVersion(): string {
    return this.version;
  }

  async getAdAccounts(token: string): Promise<MetaAccount[]> {
    const rows = await graphGet<Record<string, unknown>>(
      this.version,
      "me/adaccounts",
      {
        fields: "id,name,currency,timezone_name,account_status,is_business",
        ...this.auth(token),
        limit: "50",
      },
      this.fetchFn,
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      currency: r.currency !== undefined ? String(r.currency) : undefined,
      timezone:
        r.timezone_name !== undefined ? String(r.timezone_name) : undefined,
      status:
        r.account_status !== undefined ? String(r.account_status) : undefined,
      isBusiness: r.is_business === true,
    }));
  }

  async listCampaigns(
    accountId: string,
    token: string,
  ): Promise<MetaCampaign[]> {
    const rows = await graphGet<Record<string, unknown>>(
      this.version,
      `act_${accountId}/campaigns`,
      {
        fields:
          "id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time",
        ...this.auth(token),
        limit: "100",
      },
      this.fetchFn,
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      objective: r.objective !== undefined ? String(r.objective) : undefined,
      status: r.status !== undefined ? String(r.status) : undefined,
      effectiveStatus:
        r.effective_status !== undefined
          ? String(r.effective_status)
          : undefined,
      dailyBudgetCents: num(r.daily_budget),
      lifetimeBudgetCents: num(r.lifetime_budget),
      startDate: r.start_time !== undefined ? String(r.start_time) : undefined,
      stopDate: r.stop_time !== undefined ? String(r.stop_time) : undefined,
    }));
  }

  async listAdSets(accountId: string, token: string): Promise<MetaAdSet[]> {
    const rows = await graphGet<Record<string, unknown>>(
      this.version,
      `act_${accountId}/adsets`,
      {
        fields:
          "id,campaign_id,name,status,effective_status,bid_strategy,optimization_goal,billing_event,daily_budget,lifetime_budget,targeting",
        ...this.auth(token),
        limit: "100",
      },
      this.fetchFn,
    );
    return rows.map((r) => ({
      id: String(r.id),
      campaignId: String(r.campaign_id ?? ""),
      name: String(r.name ?? ""),
      status: r.status !== undefined ? String(r.status) : undefined,
      effectiveStatus:
        r.effective_status !== undefined
          ? String(r.effective_status)
          : undefined,
      bidStrategy:
        r.bid_strategy !== undefined ? String(r.bid_strategy) : undefined,
      optimizationGoal:
        r.optimization_goal !== undefined
          ? String(r.optimization_goal)
          : undefined,
      billingEvent:
        r.billing_event !== undefined ? String(r.billing_event) : undefined,
      dailyBudgetCents: num(r.daily_budget),
      lifetimeBudgetCents: num(r.lifetime_budget),
      targeting: r.targeting,
    }));
  }

  async listAds(accountId: string, token: string): Promise<MetaAd[]> {
    const rows = await graphGet<Record<string, unknown>>(
      this.version,
      `act_${accountId}/ads`,
      {
        fields: "id,adset_id,name,status,effective_status,creative_id",
        ...this.auth(token),
        limit: "100",
      },
      this.fetchFn,
    );
    return rows.map((r) => ({
      id: String(r.id),
      adSetId: String(r.adset_id ?? ""),
      name: String(r.name ?? ""),
      status: r.status !== undefined ? String(r.status) : undefined,
      effectiveStatus:
        r.effective_status !== undefined
          ? String(r.effective_status)
          : undefined,
      creativeId:
        r.creative_id !== undefined ? String(r.creative_id) : undefined,
    }));
  }

  async getInsights(
    ref: { type: MetaInsightLevel; id: string },
    token: string,
    query?: MetaInsightOptions,
  ): Promise<MetaInsightRow[]> {
    const fields = [...INSIGHT_DEFAULT_FIELDS, ...(query?.extraFields ?? [])];
    const params: Record<string, string> = {
      fields: fields.join(","),
      ...this.auth(token),
    };
    if (query?.datePreset) params.date_preset = query.datePreset;
    if (query?.timeRange) params.time_range = JSON.stringify(query.timeRange);
    if (query?.timeIncrement !== undefined) {
      params.time_increment =
        query.timeIncrement === "all_days"
          ? "all_days"
          : String(query.timeIncrement);
    }
    const accountPath = ref.id.startsWith("act_") ? ref.id : `act_${ref.id}`;
    const path =
      ref.type === "account"
        ? `${accountPath}/insights?level=${query?.level ?? "ad"}`
        : `${ref.id}/insights`;

    const rows = await graphGet<Record<string, unknown>>(
      this.version,
      path,
      params,
      this.fetchFn,
    );
    return rows.map(normalizeInsightRow);
  }

  async updateBudget(
    input: UpdateBudgetInput,
    token: string,
  ): Promise<MetaUpdateResult> {
    const body = await graphPost(
      this.version,
      input.entityId,
      { daily_budget: input.dailyBudgetCents },
      token,
      this.fetchFn,
      this.appSecret,
    );
    return {
      success: true,
      entityType: input.entityType,
      entityId: input.entityId,
      metaResponse: body,
    };
  }

  async setStatus(
    input: SetStatusInput,
    token: string,
  ): Promise<MetaUpdateResult> {
    const body = await graphPost(
      this.version,
      input.entityId,
      { status: input.status },
      token,
      this.fetchFn,
      this.appSecret,
    );
    return {
      success: true,
      entityType: input.entityType,
      entityId: input.entityId,
      metaResponse: body,
    };
  }

  async createCampaign(
    input: CreateCampaignInput,
    token: string,
  ): Promise<MetaCreateCampaignResult> {
    const body = (await graphPost(
      this.version,
      `act_${input.accountId}/campaigns`,
      buildCreateCampaignBody(input),
      token,
      this.fetchFn,
      this.appSecret,
    )) as { id?: unknown };
    const id = body?.id;
    if (!id) throw new Error("Meta kampanya oluşturmadı: id dönmedi.");
    // Kampanya nesnesinde inceleme geri bildirimi alanı yoktur (inceleme reklam düzeyindedir, `ad_review_feedback`).
    // Oluşturma sonrası ek okuma yapılmaz: başarısız bir okuma, Meta'da oluşmuş kampanyanın kimliğini kaybettirirdi.
    return { success: true, campaignId: String(id), metaResponse: body };
  }

  async getAdReview(
    adId: string,
    token: string,
  ): Promise<MetaAdReviewResult> {
    const raw = await graphGet<Record<string, unknown>>(
      this.version,
      adId,
      { fields: AD_REVIEW_FIELDS, ...this.auth(token) },
      this.fetchFn,
      1,
    );
    return { review: parseAdReview(raw[0], adId), fetchedAt: new Date().toISOString() };
  }

  async getAdReviews(adIds: string[], token: string): Promise<MetaAdReview[]> {
    const ids = Array.from(new Set(adIds.map((id) => id.trim()).filter((id) => /^[0-9A-Za-z_]+$/.test(id))));
    const out: MetaAdReview[] = [];
    for (let i = 0; i < ids.length; i += AD_REVIEW_BATCH_SIZE) {
      const chunk = ids.slice(i, i + AD_REVIEW_BATCH_SIZE);
      try {
        // Çoklu kimlik okuması: yanıt `{ "<id>": {...} }` biçimindedir (sayfalı değil).
        const rows = await graphGet<Record<string, unknown>>(
          this.version,
          "",
          { ids: chunk.join(","), fields: AD_REVIEW_FIELDS, ...this.auth(token) },
          this.fetchFn,
          1,
        );
        out.push(...parseAdReviewBatch(rows[0], chunk));
      } catch (error) {
        // Kimliklerden biri artık yoksa (#100) Meta tüm isteği reddeder: bu parça tek tek okunur,
        // erişilemeyen reklam atlanır. Diğer hatalar (token, izin, limit) çağırana yükselir.
        if (!(error instanceof MetaGraphError) || error.detail.code !== 100) throw error;
        for (const id of chunk) {
          try {
            const { review } = await this.getAdReview(id, token);
            if (review) out.push(review);
          } catch (inner) {
            if (!(inner instanceof MetaGraphError) || inner.detail.code !== 100) throw inner;
          }
        }
      }
    }
    return out;
  }

  private async createUnder(path: string, body: GraphBody, token: string, what: string): Promise<MetaCreatedObject> {
    const response = await graphPost(this.version, path, body, token, this.fetchFn, this.appSecret);
    return { id: createdId(response, what), metaResponse: response };
  }

  async createAdSet(accountId: string, body: GraphBody, token: string): Promise<MetaCreatedObject> {
    return this.createUnder(`act_${accountId.replace(/^act_/, "")}/adsets`, body, token, "ad set");
  }

  async createAdCreative(accountId: string, body: GraphBody, token: string): Promise<MetaCreatedObject> {
    return this.createUnder(`act_${accountId.replace(/^act_/, "")}/adcreatives`, body, token, "kreatif");
  }

  async createAd(accountId: string, body: GraphBody, token: string): Promise<MetaCreatedObject> {
    return this.createUnder(`act_${accountId.replace(/^act_/, "")}/ads`, body, token, "reklam");
  }

  async createLeadForm(pageId: string, body: GraphBody, pageToken: string): Promise<MetaCreatedObject> {
    return this.createUnder(`${pageId}/leadgen_forms`, body, pageToken, "lead formu");
  }

  async uploadAdImage(accountId: string, image: AdImageUpload, token: string): Promise<MetaAdImage> {
    const response = (await graphPost(
      this.version,
      `act_${accountId.replace(/^act_/, "")}/adimages`,
      // Belgelenen parametre yalnızca `bytes` (base64); `filename` çok parçalı dosya yüklemesi içindir.
      { bytes: image.bytesBase64 },
      token,
      this.fetchFn,
      this.appSecret,
    )) as { images?: Record<string, { hash?: unknown; url?: unknown }> };
    // Yanıt: { images: { "<ad>": { hash, url, … } } } — anahtar dosya adı ya da "bytes" olabilir.
    const first = Object.values(response?.images ?? {})[0];
    if (!first || typeof first.hash !== "string" || first.hash === "")
      throw new Error("Meta görsel yüklemesi hash döndürmedi.");
    return { hash: first.hash, url: typeof first.url === "string" ? first.url : undefined };
  }

  async searchAdLocales(query: string, token: string): Promise<MetaAdLocale[]> {
    const rows = await graphGet<{ key?: unknown; name?: unknown }>(
      this.version,
      "search",
      { type: "adlocale", q: query, limit: "100", ...this.auth(token) },
      this.fetchFn,
      1,
    );
    return rows
      .map((r) => ({ key: Number(r.key), name: String(r.name ?? "") }))
      .filter((r) => Number.isInteger(r.key) && r.key > 0 && r.name !== "");
  }
}
