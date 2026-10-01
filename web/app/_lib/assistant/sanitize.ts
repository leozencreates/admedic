/**
 * Sesli asistan araç sonuçlarını kişisel veriden arındırır (ADR-0028 §4, spec §3.11, ADR-0023 §1). Araç sonuçları
 * üçüncü tarafa (ElevenLabs ve ajanın LLM sağlayıcısı) gider; bu yüzden her uç yanıtı **beyaz listeyle** küçültülür:
 * - Lead'ler adla değil yalnızca oturum ref'iyle (`l3`) görünür; ad, e-posta, telefon, mesaj içeriği, ilgilenilen
 *   hizmet (sağlık beyanı), meta veri ve onay metni hiçbir zaman dönmez. Sayılar ve durumlar döner.
 * - Gerçek kimlikler ref'e çevrilir (`ref-map.ts`); ajan veritabanı kimliği görmez.
 * - Serbest metinler (uyarı başlığı, karar gerekçesi) kısaltılır ve e-posta/telefon benzeri diziler maskelenir.
 * - Listeler en çok `LIST_LIMIT` öğe taşır; toplam ayrıca bildirilir.
 *
 * Saf modül; girdi tipleri gevşektir (yanıt biçimi değişirse alan düşer, sızmaz).
 */
import type { RefMap } from "./ref-map";

export const LIST_LIMIT = 10;
const TEXT_LIMIT = 160;

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function rec(v: unknown): Raw {
  return isRecord(v) ? v : {};
}
function list(v: unknown): Raw[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
/** Minor unit (cent) → major; ajan "12,5 EUR" diye okur (ADR-0011). */
function major(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n) / 100;
}
function day(v: unknown): string | null {
  const s = str(v) ?? (v instanceof Date ? v.toISOString() : null);
  return s ? s.slice(0, 10) : null;
}
function ratio(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n * 10000) / 10000;
}

const EMAIL = /[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[A-Za-z]{2,}/g;
const PHONE = /\+?\d[\d\s().-]{5,}\d/g;

/** Serbest metin: e-posta ve 7+ haneli telefon benzeri diziler maskelenir, uzunluk sınırlanır. */
export function scrubText(v: unknown, limit = TEXT_LIMIT): string | null {
  const s = str(v);
  if (!s) return null;
  const masked = s
    .replace(EMAIL, "[e-posta]")
    .replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 7 ? "[telefon]" : m))
    .replace(/\s+/g, " ")
    .trim();
  return masked.length > limit ? `${masked.slice(0, limit - 1)}…` : masked;
}

function countBy(rows: Raw[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = str(row[key]) ?? "UNKNOWN";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function topCounts(counts: Record<string, number>, limit = 5): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit));
}

function refFor(refs: RefMap, kind: Parameters<RefMap["ref"]>[0], id: unknown): string | null {
  const s = str(id);
  return s ? refs.ref(kind, s) : null;
}

// ---------------------------------------------------------------- Kampanya

/** `GET /api/campaigns` listesindeki ya da `GET /api/campaigns/:id` içindeki kampanya görünümü. */
export function sanitizeCampaign(raw: unknown, refs: RefMap) {
  const c = rec(raw);
  const review = isRecord(c.review) ? c.review : null;
  const readiness = isRecord(c.readiness) ? c.readiness : null;
  const publish = isRecord(c.publish) ? c.publish : null;
  return {
    ref: refFor(refs, "campaign", c.id),
    name: scrubText(c.name, 100),
    status: str(c.status),
    workflowStatus: str(c.workflowStatus),
    objective: str(c.objective),
    dailyBudget: major(c.budgetCents ?? c.dailyBudget),
    currency: str(c.currency),
    policyRisk: str(c.policyRisk),
    adSets: num(c.adSets),
    ads: num(c.ads),
    metaReview: review ? { status: str(review.status), disapproved: num(review.disapproved), withIssues: num(review.withIssues) } : null,
    readyToPublish: readiness ? bool(readiness.ready) : null,
    publish: publish ? str(publish.status) : null,
    createdAt: day(c.createdAt),
  };
}

export function sanitizeCampaignList(raw: unknown, refs: RefMap, filter?: { workflowStatus?: string }) {
  const all = list(rec(raw).campaigns);
  const rows = filter?.workflowStatus ? all.filter((c) => c.workflowStatus === filter.workflowStatus) : all;
  return {
    total: rows.length,
    shown: Math.min(rows.length, LIST_LIMIT),
    byWorkflowStatus: countBy(all, "workflowStatus"),
    campaigns: rows.slice(0, LIST_LIMIT).map((c) => {
      const s = sanitizeCampaign(c, refs);
      return { ref: s.ref, name: s.name, status: s.status, workflowStatus: s.workflowStatus, dailyBudget: s.dailyBudget, currency: s.currency };
    }),
  };
}

function sanitizeMetrics(raw: unknown) {
  const m = rec(raw);
  return {
    spend: major(m.spend),
    impressions: num(m.impressions),
    clicks: num(m.clicks),
    leads: num(m.leads),
    purchases: num(m.purchases),
  };
}

/** `GET /api/campaigns/:id`: kampanya + 7/30 gün performans + son kararlar (ad set adları ve hedefleme dönmez). */
export function sanitizeCampaignDetail(raw: unknown, refs: RefMap) {
  const r = rec(raw);
  const metrics = rec(r.metrics);
  const decisions = list(r.decisions);
  return {
    campaign: sanitizeCampaign(r.campaign, refs),
    metrics: { last7Days: sanitizeMetrics(metrics.days7), last30Days: sanitizeMetrics(metrics.days30) },
    adSetCount: list(r.adSets).length,
    decisions: {
      total: decisions.length,
      pending: decisions.filter((d) => d.approval === "PENDING").length,
      latest: decisions.slice(0, 5).map((d) => sanitizeDecisionRow(d, refs)),
    },
  };
}

// ---------------------------------------------------------------- Bugün (kabuk özeti)

/** `GET /api/shell`: sayılar ve son bildirim başlıkları. Kullanıcı adı ve e-postası dönmez. */
export function sanitizeShellSummary(raw: unknown) {
  const r = rec(raw);
  const counts = rec(r.counts);
  const notifications = list(r.notifications);
  return {
    workspace: scrubText(rec(r.user).workspaceName, 80),
    role: str(rec(r.user).roleLabel),
    pendingApprovals: num(counts.approvals) ?? 0,
    leadsAwaitingReply: num(counts.leads) ?? 0,
    openAlerts: num(counts.alerts) ?? 0,
    latestNotifications: notifications.slice(0, 5).map((n) => ({
      title: scrubText(n.title),
      severity: str(n.severity),
      date: day(n.createdAt),
    })),
  };
}

// ---------------------------------------------------------------- Uyarı, öneri, karar

/** Uyarı: başlık ve tür; gövde metni (`message`) dönmez. */
export function sanitizeAlert(raw: unknown, refs: RefMap) {
  const a = rec(raw);
  return {
    ref: refFor(refs, "alert", a.id),
    type: str(a.type),
    severity: str(a.severity),
    status: str(a.status),
    title: scrubText(a.title),
    date: day(a.createdAt),
  };
}

export function sanitizeAlertList(raw: unknown, refs: RefMap) {
  const rows = list(rec(raw).alerts);
  return {
    total: rows.length,
    shown: Math.min(rows.length, LIST_LIMIT),
    bySeverity: countBy(rows, "severity"),
    alerts: rows.slice(0, LIST_LIMIT).map((a) => sanitizeAlert(a, refs)),
  };
}

export function sanitizeRecommendation(raw: unknown, refs: RefMap) {
  const r = rec(raw);
  const action = rec(r.action);
  return {
    ref: refFor(refs, "recommendation", r.id),
    type: str(action.type) ?? str(r.type),
    status: str(r.status),
    priority: str(r.priority),
    title: scrubText(r.title),
    date: day(r.createdAt),
  };
}

export function sanitizeRecommendationList(raw: unknown, refs: RefMap, filter?: { status?: string }) {
  const all = list(rec(raw).recommendations);
  const rows = filter?.status ? all.filter((r) => r.status === filter.status) : all;
  return {
    total: rows.length,
    shown: Math.min(rows.length, LIST_LIMIT),
    byStatus: countBy(all, "status"),
    recommendations: rows.slice(0, LIST_LIMIT).map((r) => sanitizeRecommendation(r, refs)),
  };
}

function sanitizeDecisionRow(raw: Raw, refs: RefMap) {
  const targetId = str(raw.targetId);
  return {
    ref: refFor(refs, "decision", raw.id),
    targetType: str(raw.targetType),
    // Hedef kampanyaysa ve daha önce eşlenmişse ref'i; aksi halde kimlik gönderilmez.
    targetRef: targetId && raw.targetType === "CAMPAIGN" ? refs.existingRef("campaign", targetId) : null,
    action: str(raw.action),
    approval: str(raw.approval),
    budgetBefore: major(raw.budgetBefore),
    budgetAfter: major(raw.budgetAfter),
    changePct: num(raw.changePct),
    reason: scrubText(raw.reason),
    date: day(raw.createdAt),
    applied: raw.appliedAt ? true : false,
  };
}

export function sanitizeDecisionList(raw: unknown, refs: RefMap) {
  const rows = list(rec(raw).decisions);
  return {
    total: rows.length,
    shown: Math.min(rows.length, LIST_LIMIT),
    pendingApproval: rows.filter((d) => d.approval === "PENDING").length,
    decisions: rows.slice(0, LIST_LIMIT).map((d) => sanitizeDecisionRow(d, refs)),
  };
}

// ---------------------------------------------------------------- Performans ve rapor

/** `GET /api/insights`: özet metrikler + kırılımlar; öneri açıklamaları ve gerekçeleri dönmez. */
export function sanitizeInsights(raw: unknown, refs: RefMap) {
  const r = rec(raw);
  const insights = rec(r.insights);
  const s = rec(insights.summary);
  const campaigns = list(insights.campaigns);
  return {
    currency: str(r.currency),
    periodDays: num(rec(insights.period).days),
    summary: {
      spend: major(s.totalSpend),
      impressions: num(s.totalImpressions),
      clicks: num(s.totalClicks),
      ctr: ratio(s.ctr),
      cpm: major(s.cpmCents),
      cpc: major(s.cpcCents),
      cpl: major(s.cplCents),
      roas: num(s.roas),
      leads: num(s.totalLeads),
      qualifiedLeads: num(s.qualifiedLeads),
      qualifiedLeadRatio: ratio(s.qualifiedLeadRatio),
    },
    activeCampaigns: {
      total: campaigns.length,
      top: [...campaigns]
        .sort((a, b) => (num(b.spentCents) ?? 0) - (num(a.spentCents) ?? 0))
        .slice(0, 5)
        .map((c) => ({
          ref: refFor(refs, "campaign", c.id),
          name: scrubText(c.name, 100),
          spend: major(c.spentCents),
          leads: num(c.leadCount),
          cpl: major(c.cplCents),
          ctr: ratio(c.ctr),
        })),
    },
    byCountry: list(insights.byCountry).slice(0, 5).map((g) => ({ country: str(g.country), leads: num(g.leads), qualified: num(g.qualified) })),
    byLanguage: list(insights.byLanguage).slice(0, 5).map((g) => ({ language: str(g.language), leads: num(g.leads), qualified: num(g.qualified) })),
    openAlerts: list(r.alerts).length,
    pendingRecommendations: list(r.pendingRecommendations).length,
  };
}

/** `GET /api/reports/weekly` (JSON): haftalık özet. */
export function sanitizeWeeklyReport(raw: unknown, refs: RefMap) {
  const report = rec(rec(raw).report);
  const period = rec(report.period);
  const s = rec(report.summary);
  const campaigns = list(report.campaigns);
  const alerts = list(report.unreadAlerts);
  return {
    period: { start: day(period.start), end: day(period.end) },
    summary: {
      spend: major(s.totalSpend),
      impressions: num(s.totalImpressions),
      clicks: num(s.totalClicks),
      purchases: num(s.totalPurchases),
      ctr: ratio(s.ctr),
      // Rapor CPL'yi zaten major birimde verir (`@admedic/reporting`); harcama minor'dür.
      cpl: num(s.cpl),
      newLeads: num(s.newLeads),
      qualifiedLeads: num(s.qualifiedLeads),
      totalLeads: num(s.totalLeads),
    },
    campaigns: {
      total: campaigns.length,
      items: campaigns.slice(0, LIST_LIMIT).map((c) => ({ ref: refFor(refs, "campaign", c.id), name: scrubText(c.name, 100), status: str(c.status) })),
    },
    unreadAlerts: {
      total: alerts.length,
      items: alerts.slice(0, 5).map((a) => ({ severity: str(a.severity), title: scrubText(a.title) })),
    },
  };
}

// ---------------------------------------------------------------- Politika

/** `GET /api/policies`: optimizasyon sınırları ve etkin kural sayısı. */
export function sanitizePolicyStatus(raw: unknown) {
  const r = rec(raw);
  const p = isRecord(r.optimizationPolicy) ? r.optimizationPolicy : null;
  const rules = list(r.optimizationRules);
  return {
    configured: Boolean(p),
    policy: p
      ? {
          enabled: bool(p.enabled),
          mode: str(p.mode),
          objective: str(p.objective),
          maxIncreasePct: num(p.maxIncreasePct),
          maxDecreasePct: num(p.maxDecreasePct),
          maxChangePer24hPct: num(p.maxChangePer24hPct),
          minHoursBetweenChanges: num(p.minHoursBetweenChanges),
          accountDailyMax: major(p.accountDailyMaxCents),
          accountMonthlyMax: major(p.accountMonthlyMaxCents),
          campaignDailyMax: major(p.campaignDailyMaxCents),
          targetRoas: num(p.targetRoas),
        }
      : null,
    rules: { total: rules.length, active: rules.filter((x) => x.active === true).length },
  };
}

// ---------------------------------------------------------------- Lead

/**
 * `GET /api/leads`: yalnızca sayılar, durumlar ve ref'ler. Bilerek okunan alanlar: id (ref'e çevrilir), status,
 * channel, country, language, createdAt, inbox.needsReply / handedOff / conversationStatus. Diğer her alan
 * (ad, soyad, e-posta, telefon, ilgilenilen hizmet, meta veri, son mesaj önizlemesi, devralan kişinin adı) düşer.
 */
export function sanitizeLeadStats(raw: unknown, refs: RefMap) {
  const rows = list(rec(raw).leads);
  const inbox = (l: Raw) => rec(l.inbox);
  return {
    total: rows.length,
    note: rows.length >= 100 ? "Sayılar en yeni lead'ler ve yanıt bekleyenler üzerinden." : undefined,
    awaitingReply: rows.filter((l) => inbox(l).needsReply === true).length,
    handedOffUnclaimed: rows.filter((l) => inbox(l).handedOff === true).length,
    byStatus: countBy(rows, "status"),
    byChannel: countBy(rows, "channel"),
    byCountry: topCounts(countBy(rows, "country")),
    byLanguage: topCounts(countBy(rows, "language")),
    recent: rows.slice(0, LIST_LIMIT).map((l) => ({
      ref: refFor(refs, "lead", l.id),
      status: str(l.status),
      channel: str(l.channel),
      language: str(l.language),
      date: day(l.createdAt),
      awaitingReply: inbox(l).needsReply === true,
    })),
  };
}

/** `GET /api/leads/refetch`. */
export function sanitizePendingLeads(raw: unknown) {
  return { pending: num(rec(raw).pending) ?? 0 };
}

// ---------------------------------------------------------------- Abonelik

/** `GET /api/billing/subscription`: plan ve durum; fiyat tablosu ve Stripe kimlikleri dönmez. */
export function sanitizeSubscription(raw: unknown) {
  const r = rec(raw);
  const s = isRecord(r.subscription) ? r.subscription : null;
  return {
    subscription: s
      ? {
          plan: str(s.plan),
          status: str(s.status),
          currentPeriodEnd: day(s.currentPeriodEnd),
          cancelAtPeriodEnd: bool(s.cancelAtPeriodEnd),
        }
      : null,
    demoMode: bool(r.mock),
  };
}
