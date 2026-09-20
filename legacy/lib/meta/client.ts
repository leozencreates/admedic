export interface MetaInsightPoint {
  date: string; // YYYY-MM-DD
  impressions: number;
  clicks: number;
  spend: number; // TL (ondalık)
  conversions: number;
  revenue: number; // TL (ondalık)
}

export interface MetaAdSet {
  id: string;
  name: string;
  status: string;
  dailyBudget?: number; // TL
  lifetimeBudget?: number; // TL
  adIds: string[];
}

export interface MetaCampaign {
  id: string;
  name: string;
  status: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  currency: string;
  adSets: MetaAdSet[];
}

const GRAPH_URL = "https://graph.facebook.com";
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";

function getApp(): { appId: string; appSecret: string; redirectUri: string } {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) {
    throw new Error(
      "Meta uygulama bilgileri eksik. .env içinde META_APP_ID, META_APP_SECRET ve META_REDIRECT_URI tanımlı olmalı."
    );
  }
  return { appId, appSecret, redirectUri };
}

export function buildOAuthUrl(state: string): string {
  const { appId, redirectUri } = getApp();
  const scope = "ads_management,ads_read,business_management";
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(code: string): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const { appId, appSecret, redirectUri } = getApp();
  const url = new URL(`${GRAPH_URL}/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Meta token değişimi başarısız: ${JSON.stringify(json.error ?? json)}`
    );
  }
  return {
    accessToken: String(json.access_token),
    expiresIn: Number(json.expires_in ?? 0),
  };
}

interface GraphEnvelope<T> {
  data?: T[];
  error?: { message: string };
}

async function graphGet<T>(
  path: string,
  params: Record<string, string>,
  token: string
): Promise<GraphEnvelope<T>> {
  const url = new URL(`${GRAPH_URL}/${GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json()) as GraphEnvelope<T>;
  if (!res.ok || json.error) {
    throw new Error(`Meta API hatası: ${json.error?.message ?? res.status}`);
  }
  return json;
}

export async function listAdAccounts(token: string): Promise<{ id: string; name: string }[]> {
  const res = await graphGet<{ id: string; name?: string }>(
    "me/adaccounts",
    { fields: "id,name" },
    token
  );
  return (res.data ?? []).map((a) => ({ id: a.id, name: a.name ?? a.id }));
}

function accountingId(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
}

interface CampaignRow {
  id: string;
  name?: string;
  status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  currency?: string;
}

export async function fetchCampaigns(
  token: string,
  adAccountId: string
): Promise<MetaCampaign[]> {
  const res = await graphGet<CampaignRow>(
    `${accountingId(adAccountId)}/campaigns`,
    { fields: "id,name,status,daily_budget,lifetime_budget,currency" },
    token
  );

  const out: MetaCampaign[] = [];
  for (const c of res.data ?? []) {
    const adSets = await fetchAdSets(token, c.id);
    out.push({
      id: c.id,
      name: c.name ?? c.id,
      status: c.status ?? "UNKNOWN",
      dailyBudget: c.daily_budget ? Number(c.daily_budget) : undefined,
      lifetimeBudget: c.lifetime_budget ? Number(c.lifetime_budget) : undefined,
      currency: c.currency ?? "TRY",
      adSets,
    });
  }
  return out;
}

interface AdSetRow {
  id: string;
  name?: string;
  status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
}

async function fetchAdSets(token: string, campaignId: string): Promise<MetaAdSet[]> {
  const res = await graphGet<AdSetRow>(
    `${campaignId}/adsets`,
    { fields: "id,name,status,daily_budget,lifetime_budget" },
    token
  );
  const out: MetaAdSet[] = [];
  for (const a of res.data ?? []) {
    const ads = await graphGet<{ id: string; name?: string; status?: string }>(
      `${a.id}/ads`,
      { fields: "id,name,status" },
      token
    );
    out.push({
      id: a.id,
      name: a.name ?? a.id,
      status: a.status ?? "UNKNOWN",
      dailyBudget: a.daily_budget ? Number(a.daily_budget) : undefined,
      lifetimeBudget: a.lifetime_budget ? Number(a.lifetime_budget) : undefined,
      adIds: (ads.data ?? []).map((ad) => ad.id),
    });
  }
  return out;
}

const INSIGHT_FIELDS =
  "date_start,impressions,clicks,spend,actions,action_values";

function parseInsightActions(
  value: unknown
): { conversions: number; revenue: number } {
  const arr = Array.isArray(value) ? value : [];
  let conversions = 0;
  let revenue = 0;
  for (const item of arr as { action_type?: string; value?: string | number }[]) {
    if (item.action_type === "purchase") {
      conversions += Number(item.value ?? 0);
    }
  }
  for (const item of arr as { action_type?: string; value?: string | number }[]) {
    if (item.action_type === "purchase") {
      revenue += Number(item.value ?? 0);
    }
  }
  return { conversions, revenue };
}

interface InsightRow {
  adset_id?: string;
  date_start?: string;
  impressions?: string;
  clicks?: string;
  spend?: string;
  actions?: unknown;
  action_values?: unknown;
}

// Reklam seti (ad set) bazında günlük metrikler → key = ad set id
export async function fetchAdSetDailyInsights(
  token: string,
  adAccountId: string,
  days = 30
): Promise<Record<string, MetaInsightPoint[]>> {
  const res = await graphGet<InsightRow>(
    `${accountingId(adAccountId)}/insights`,
    {
      level: "adset",
      time_increment: "1",
      date_preset: `last_${days}d`,
      fields: INSIGHT_FIELDS,
    },
    token
  );

  const map: Record<string, MetaInsightPoint[]> = {};
  for (const row of res.data ?? []) {
    const adSetId = row.adset_id;
    if (!adSetId) continue;
    const { conversions, revenue } = parseInsightActions(row.actions);
    const revenueFromValues = parseInsightActions(row.action_values).revenue;
    map[adSetId] ??= [];
    map[adSetId].push({
      date: row.date_start ?? "",
      impressions: Number(row.impressions ?? 0),
      clicks: Number(row.clicks ?? 0),
      spend: Number(row.spend ?? 0),
      conversions,
      revenue: revenueFromValues > 0 ? revenueFromValues : revenue,
    });
  }
  return map;
}

export async function updateAdSetDailyBudget(
  token: string,
  adAccountId: string,
  updates: { adSetId: string; dailyBudget: number }[],
  campaignId: string,
  currency: string
): Promise<void> {
  // Belgelere göre: POST /act_{id}/adsets?adset_ids=...&campaign_id=...&daily_budget=...
  const byBudget = new Map<number, string[]>();
  for (const u of updates) {
    const key = Math.round(u.dailyBudget * 100) / 100;
    byBudget.set(key, [...(byBudget.get(key) ?? []), u.adSetId]);
  }
  for (const [budget, ids] of byBudget) {
    const url = new URL(
      `${GRAPH_URL}/${GRAPH_VERSION}/${accountingId(adAccountId)}/adsets`
    );
    url.searchParams.set("adset_ids", ids.join(","));
    url.searchParams.set("campaign_id", campaignId);
    url.searchParams.set("daily_budget", String(budget));
    url.searchParams.set("currency", currency);
    url.searchParams.set("access_token", token);
    const res = await fetch(url, { method: "POST", cache: "no-store" });
    const json = (await res.json()) as { error?: { message: string } };
    if (!res.ok) {
      throw new Error(
        `Bütçe güncellenemedi: ${json?.error?.message ?? res.status}`
      );
    }
  }
}