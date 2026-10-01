/**
 * Okuma araçları (R0, ADR-0028 §3 "Okuma"). Her araç mevcut bir GET ucunu kullanıcının kendi oturumuyla çağırır;
 * sonuç `sanitize.ts` ile kişisel veriden arındırılır ve kısa JSON olarak ajana döner. `plan_campaign` Faz 0
 * doğrulamasına kadar yoktur.
 */
import {
  sanitizeAlertList,
  sanitizeCampaignDetail,
  sanitizeCampaignList,
  sanitizeDecisionList,
  sanitizeInsights,
  sanitizeLeadStats,
  sanitizePendingLeads,
  sanitizePolicyStatus,
  sanitizeRecommendationList,
  sanitizeShellSummary,
  sanitizeSubscription,
  sanitizeWeeklyReport,
} from "../sanitize";
import { json, type ToolHandler } from "./context";

function optional(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export const readHandlers: Record<string, ToolHandler> = {
  async get_today_summary(_params, ctx) {
    return { result: json(sanitizeShellSummary(await ctx.api("/api/shell"))) };
  },

  async list_campaigns(params, ctx) {
    const data = await ctx.api("/api/campaigns");
    return { result: json(sanitizeCampaignList(data, ctx.refs, { workflowStatus: optional(params.workflowStatus) })) };
  },

  async get_campaign(params, ctx) {
    const id = ctx.refs.resolve(params.ref, "campaign");
    const data = await ctx.api(`/api/campaigns/${encodeURIComponent(id)}`);
    return { result: json(sanitizeCampaignDetail(data, ctx.refs)), entityId: id };
  },

  async get_insights(_params, ctx) {
    return { result: json(sanitizeInsights(await ctx.api("/api/insights"), ctx.refs)) };
  },

  async get_weekly_report_summary(_params, ctx) {
    return { result: json(sanitizeWeeklyReport(await ctx.api("/api/reports/weekly"), ctx.refs)) };
  },

  async list_alerts(params, ctx) {
    const status = optional(params.status) ?? "OPEN";
    const data = await ctx.api(`/api/alerts?status=${encodeURIComponent(status)}`);
    return { result: json({ status, ...sanitizeAlertList(data, ctx.refs) }) };
  },

  async list_recommendations(params, ctx) {
    const data = await ctx.api("/api/recommendations");
    return { result: json(sanitizeRecommendationList(data, ctx.refs, { status: optional(params.status) })) };
  },

  async list_decisions(_params, ctx) {
    return { result: json(sanitizeDecisionList(await ctx.api("/api/decisions"), ctx.refs)) };
  },

  async get_policy_status(_params, ctx) {
    return { result: json(sanitizePolicyStatus(await ctx.api("/api/policies"))) };
  },

  async get_lead_stats(_params, ctx) {
    return { result: json(sanitizeLeadStats(await ctx.api("/api/leads"), ctx.refs)) };
  },

  async pending_leads_count(_params, ctx) {
    return { result: json(sanitizePendingLeads(await ctx.api("/api/leads/refetch"))) };
  },

  async get_subscription(_params, ctx) {
    return { result: json(sanitizeSubscription(await ctx.api("/api/billing/subscription"))) };
  },
};
