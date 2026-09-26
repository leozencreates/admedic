import { graphGet, graphPost, getGraphVersion } from "./http";
import { normalizeInsightRow } from "./parse";
import type {
  CreateCampaignInput,
  MetaAccount,
  MetaAd,
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
 * `status` her zaman PAUSED; `daily_budget` yalnızca CBO'da (ABO'da bütçe ad set'tedir).
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
    ...(sendBudget ? { daily_budget: Math.round(input.dailyBudgetCents!) } : {}),
  };
}

export class MetaMarketingClient implements MetaClientLike {
  private readonly version: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: MetaClientOptions = {}) {
    this.version = getGraphVersion(options.version);
    this.fetchFn = options.fetchFn ?? fetch;
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
        access_token: token,
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
        access_token: token,
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
        access_token: token,
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
        access_token: token,
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
      access_token: token,
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
    )) as { id?: unknown };
    const id = body?.id;
    if (!id) throw new Error("Meta kampanya oluşturmadı: id dönmedi.");
    const campaignId = String(id);
    // graphGet tek nesne yanıtını tek elemanlı dizi olarak döndürür.
    const reviewRows = (await graphGet<Record<string, unknown>>(
      this.version,
      campaignId,
      { fields: "review_feedback", access_token: token },
      this.fetchFn,
    )) as { review_feedback?: { global?: Record<string, string>; placement_specific?: Record<string, Record<string, string>> } }[];
    const rf = reviewRows[0]?.review_feedback ?? {};
    return {
      success: true,
      campaignId,
      metaResponse: body,
      reviewFeedbackGlobal: rf.global,
      reviewFeedbackPlacements: rf.placement_specific,
    };
  }

  async getAdReview(
    adId: string,
    token: string,
  ): Promise<MetaAdReviewResult> {
    const raw = await graphGet<Record<string, unknown>>(
      this.version,
      adId,
      {
        fields: "id,effective_status,configured_status,review_feedback",
        access_token: token,
      },
      this.fetchFn,
    );
    const obj = (raw as Record<string, unknown>[])[0] ?? {};
    const rf = (obj.review_feedback ?? {}) as {
      global?: Record<string, string>;
      placement_specific?: Record<string, Record<string, string>>;
    };
    return {
      review: {
        id: String(obj.id ?? adId),
        effectiveStatus:
          obj.effective_status !== undefined
            ? String(obj.effective_status)
            : undefined,
        configuredStatus:
          obj.configured_status !== undefined
            ? String(obj.configured_status)
            : undefined,
        reviewFeedbackGlobal: rf.global,
        reviewFeedbackPlacements: rf.placement_specific,
      },
      fetchedAt: new Date().toISOString(),
    };
  }
}
