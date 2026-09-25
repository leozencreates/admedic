import { mulberry32, seedFromString } from "@admedic/shared";

import type {
  CreateCampaignInput,
  DatePreset,
  InsightDateRange,
  MetaAccount,
  MetaAd,
  MetaAdSet,
  MetaCampaign,
  MetaCreateCampaignResult,
  MetaInsightLevel,
  MetaInsightOptions,
  MetaInsightRow,
  MetaUpdateResult,
  MetaAdReviewResult,
  SetStatusInput,
  UpdateBudgetInput,
} from "./types";

/** Mock ad account sabitleri (mock moddayken kullanılır). */
export const MOCK_AD_ACCOUNT_ID = "act_mock_001";
export const MOCK_CURRENCY = "EUR";

interface MockAdSeed {
  adId: string;
  name: string;
  quality: number;
  aovEuro: number;
  targetRoas: number;
  adsetId: string;
  campaignId: string;
}

const CAMPAIGNS_META: { name: string; aovEuro: number; targetRoas: number }[] =
  [
    { name: "Germany - Hair Restoration", aovEuro: 2900, targetRoas: 4.5 },
    { name: "UK - Hair Restoration", aovEuro: 2700, targetRoas: 4.2 },
    { name: "France - Dental Implants", aovEuro: 3400, targetRoas: 4.0 },
    { name: "Gulf - Body Contouring", aovEuro: 4200, targetRoas: 3.8 },
    { name: "RU-KZ - Check-up Package", aovEuro: 1600, targetRoas: 5.2 },
  ];

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(since: string, until: string): number {
  const a = new Date(`${since}T00:00:00Z`).getTime();
  const b = new Date(`${until}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((b - a) / 86400_000) + 1);
}

function daysFromPreset(
  preset: DatePreset,
  now = new Date(),
): InsightDateRange {
  const until = dateKey(now);
  const n: Record<DatePreset, number> = {
    today: 1,
    yesterday: 1,
    last_3d: 3,
    last_7d: 7,
    last_14d: 14,
    last_28d: 28,
    last_30d: 30,
    last_90d: 90,
    this_month: 1,
    last_month: 1,
    maximum: 180,
  };
  const count = n[preset] ?? 30;
  const since = dateKey(new Date(now.getTime() - (count - 1) * 86400_000));
  return { since, until };
}

/** Deterministik günlük ad metrik üretimi (kalite + gün tohumu). */
function dailyAdMetrics(
  seed: MockAdSeed,
  day: Date,
): {
  spendMajor: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  linkClicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  purchases: number;
  purchaseValueMajor: number;
} {
  const rnd = mulberry32(seedFromString(`${seed.adId}:${dateKey(day)}`));
  const quality = seed.quality; // 0.55–1.65: daha yüksek → daha iyi dönüşüm olasılığı
  const spendMajor = 40 + rnd() * 160;
  const frequency = 1.4 + rnd() * 1.6;
  const impressions = Math.round(
    (spendMajor / (2.5 + rnd() * 3)) * 1000 * (0.8 + quality * 0.3),
  );
  const clicks = Math.round(impressions * (0.008 + rnd() * 0.014));
  const ctr = clicks / Math.max(impressions, 1);
  const linkClicks = Math.round(clicks * 0.6);
  const purchaseRoll = rnd();
  const purchases =
    purchaseRoll < 0.15 + quality * 0.4 ? 1 + Math.floor(rnd() * 6) : 0;
  const purchaseValueMajor =
    purchases > 0 ? seed.aovEuro * purchases * (0.85 + rnd() * 0.3) : 0;
  return {
    spendMajor,
    impressions,
    reach: Math.round(impressions * 0.8),
    frequency,
    clicks,
    linkClicks,
    ctr,
    cpc: clicks > 0 ? Math.round(spendMajor / clicks) : 0,
    cpm: Math.round(spendMajor / 1000),
    purchases,
    purchaseValueMajor: Number(purchaseValueMajor.toFixed(2)),
  };
}

function buildAdSeeds(): MockAdSeed[] {
  const out: MockAdSeed[] = [];
  for (let ci = 0; ci < CAMPAIGNS_META.length; ci++) {
    const meta = CAMPAIGNS_META[ci]!;
    const campaignId = `cmp_mock_${ci + 1}`;
    for (let a = 0; a < 2; a++) {
      const adsetId = `as_mock_${ci}_${a}`;
      for (let i = 0; i < 5; i++) {
        const adId = `ad_mock_${ci}_${a}_${i}`;
        const quality =
          0.55 + mulberry32(seedFromString(`${adId}:q`) + 1)() * 1.1;
        out.push({
          adId,
          name: `${meta.name} — Ad ${i + 1} (${a === 0 ? "CTRL" : "VAR"})`,
          quality,
          aovEuro: meta.aovEuro,
          targetRoas: meta.targetRoas,
          adsetId,
          campaignId,
        });
      }
    }
  }
  return out;
}

function campaignName(campaignId: string): string {
  const idx = Number(campaignId.split("_").pop());
  return (CAMPAIGNS_META[idx - 1] ?? CAMPAIGNS_META[0]!).name;
}

export class MockMetaClient {
  private readonly version: string;
  private readonly adAccountId: string;

  constructor(options: { version?: string; adAccountId?: string } = {}) {
    this.version = options.version ?? "v26.0";
    this.adAccountId = options.adAccountId ?? MOCK_AD_ACCOUNT_ID;
  }

  getVersion(): string {
    return this.version;
  }

  async getAdAccounts(_token: string): Promise<MetaAccount[]> {
    return [
      {
        id: this.adAccountId,
        name: "Mock Ana Hesap (Demo)",
        currency: MOCK_CURRENCY,
        timezone: "Europe/Istanbul",
        status: "1",
      },
    ];
  }

  async listCampaigns(
    accountId: string,
    _token: string,
  ): Promise<MetaCampaign[]> {
    if (accountId !== this.adAccountId) return [];
    return CAMPAIGNS_META.map((m, i) => ({
      id: `cmp_mock_${i + 1}`,
      name: m.name,
      objective: "OUTCOME_LEADS",
      status: "ACTIVE",
      effectiveStatus: "ACTIVE",
      dailyBudgetMajor: 500,
    }));
  }

  async listAdSets(accountId: string, _token: string): Promise<MetaAdSet[]> {
    if (accountId !== this.adAccountId) return [];
    const out: MetaAdSet[] = [];
    for (let ci = 0; ci < CAMPAIGNS_META.length; ci++) {
      for (let a = 0; a < 2; a++) {
        out.push({
          id: `as_mock_${ci}_${a}`,
          campaignId: `cmp_mock_${ci + 1}`,
          name: `${CAMPAIGNS_META[ci]!.name} — AdSet ${a + 1}`,
          status: "ACTIVE",
          effectiveStatus: "ACTIVE",
          bidStrategy: "LOWEST_COST_WITHOUT_CAP",
          optimizationGoal: "LEAD_GENERATION",
          billingEvent: "IMPRESSIONS",
          dailyBudgetMajor: 150,
          targeting: { countries: [], minAge: 25, maxAge: 65 },
        });
      }
    }
    return out;
  }

  async listAds(accountId: string, _token: string): Promise<MetaAd[]> {
    if (accountId !== this.adAccountId) return [];
    return buildAdSeeds().map((s, idx) => ({
      id: s.adId,
      adSetId: s.adsetId,
      name: s.name,
      status: "ACTIVE",
      effectiveStatus: "ACTIVE",
      creativeId: `cr_mock_${idx + 1}`,
    }));
  }

  async getAdReview(
    adId: string,
    _token: string,
  ): Promise<MetaAdReviewResult> {
    if (adId === "ad_mock_rejected") {
      return {
        review: {
          id: adId,
          effectiveStatus: "DISAPPROVED",
          configuredStatus: "ACTIVE",
          reviewFeedbackGlobal: {
            personal_health: "İçerik sağlık iddiaları içeriyor.",
          },
        },
        fetchedAt: new Date().toISOString(),
      };
    }
    return {
      review: {
        id: adId,
        effectiveStatus: "ACTIVE",
        configuredStatus: "ACTIVE",
        reviewFeedbackGlobal: {},
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  async getInsights(
    ref: { type: MetaInsightLevel; id: string },
    _token: string,
    query?: MetaInsightOptions,
  ): Promise<MetaInsightRow[]> {
    const range =
      query?.timeRange ??
      (query?.datePreset
        ? daysFromPreset(query.datePreset)
        : daysFromPreset("last_30d"));
    const dayCount = daysBetween(range.since, range.until);
    const perDay = query?.timeIncrement === 1;

    const days: Date[] = [];
    const untilT = new Date(`${range.until}T00:00:00Z`).getTime();
    for (let d = 0; d < dayCount; d++) {
      days.push(new Date(untilT - d * 86400_000));
    }

    const rows: MetaInsightRow[] = [];
    const targets = this.selectTargets(ref);
    for (const t of targets) {
      if (perDay) {
        for (const day of days) {
          rows.push(this.rowFor(t, day, range));
        }
      } else {
        const agg = days.map((d) => this.rowFor(t, d, range));
        rows.push(this.aggregate(t, agg, range));
      }
    }
    return rows;
  }

  async updateBudget(
    input: UpdateBudgetInput,
    _token: string,
  ): Promise<MetaUpdateResult> {
    return {
      success: true,
      entityType: input.entityType,
      entityId: input.entityId,
      metaResponse: { success: true },
    };
  }

  async setStatus(
    input: SetStatusInput,
    _token: string,
  ): Promise<MetaUpdateResult> {
    return {
      success: true,
      entityType: input.entityType,
      entityId: input.entityId,
      metaResponse: { success: true },
    };
  }

  async createCampaign(
    input: CreateCampaignInput,
    _token: string,
  ): Promise<MetaCreateCampaignResult> {
    const id = `cmp_mock_pub_${(seedFromString(input.name) % 9000) + 1000}`;
    const isRejected = input.name.toLowerCase().includes("rejected");
    return {
      success: true,
      campaignId: id,
      metaResponse: { id, success: true, status: input.status ?? "PAUSED" },
      reviewFeedbackGlobal: isRejected ? { personal_health: "İçerik sağlık iddiaları içeriyor." } : {},
      reviewFeedbackPlacements: {},
    };
  }

  private selectTargets(ref: {
    type: MetaInsightLevel;
    id: string;
  }): MockAdSeed[] {
    const seeds = buildAdSeeds();
    switch (ref.type) {
      case "ad":
        return seeds.filter((s) => s.adId === ref.id);
      case "adset": {
        const list = seeds.filter((s) => s.adsetId === ref.id);
        return list.length > 0 ? list : [{ ...seeds[0]!, adsetId: ref.id }];
      }
      case "campaign": {
        const list = seeds.filter((s) => s.campaignId === ref.id);
        return list.length > 0 ? list : [{ ...seeds[0]!, campaignId: ref.id }];
      }
      default:
        return seeds;
    }
  }

  private rowFor(
    seed: MockAdSeed,
    day: Date,
    _range: InsightDateRange,
  ): MetaInsightRow {
    const m = dailyAdMetrics(seed, day);
    return {
      dateStart: dateKey(day),
      dateStop: dateKey(day),
      campaignId: seed.campaignId,
      campaignName: campaignName(seed.campaignId),
      adsetId: seed.adsetId,
      adId: seed.adId,
      adName: seed.name,
      impressions: m.impressions,
      reach: m.reach,
      frequency: m.frequency,
      clicks: m.clicks,
      linkClicks: m.linkClicks,
      ctr: m.ctr,
      cpc: m.cpc,
      cpm: m.cpm,
      spendMajor: m.spendMajor,
      purchases: m.purchases,
      purchaseValueMajor: m.purchaseValueMajor,
    };
  }

  private aggregate(
    seed: MockAdSeed,
    rows: MetaInsightRow[],
    range: InsightDateRange,
  ): MetaInsightRow {
    const first = rows[0]!;
    const spend = rows.reduce((a, r) => a + r.spendMajor, 0);
    const impressions = rows.reduce((a, r) => a + r.impressions, 0);
    const clicks = rows.reduce((a, r) => a + r.clicks, 0);
    return {
      dateStart: range.since,
      dateStop: range.until,
      campaignId: first.campaignId,
      campaignName: first.campaignName,
      adsetId: first.adsetId,
      adId: first.adId,
      adName: first.adName,
      impressions,
      reach: rows.reduce((a, r) => a + (r.reach ?? 0), 0),
      frequency:
        impressions > 0
          ? Number(
              (
                impressions /
                Math.max(
                  rows.reduce((a, r) => a + (r.reach ?? 0), 0),
                  1,
                )
              ).toFixed(2),
            )
          : undefined,
      clicks,
      linkClicks: rows.reduce((a, r) => a + r.linkClicks, 0),
      ctr: impressions > 0 ? clicks / impressions : undefined,
      cpc: clicks > 0 ? spend / clicks : 0,
      cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
      spendMajor: Number(spend.toFixed(2)),
      purchases: rows.reduce((a, r) => a + r.purchases, 0),
      purchaseValueMajor: Number(
        rows.reduce((a, r) => a + r.purchaseValueMajor, 0).toFixed(2),
      ),
    };
  }
}
