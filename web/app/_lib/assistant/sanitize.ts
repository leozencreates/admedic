/**
 * Sesli asistan araç sonuçlarını kişisel veriden arındırır (ADR-0028 §4, spec §3.11, ADR-0023 §1). Araç sonuçları
 * üçüncü tarafa (ElevenLabs ve ajanın LLM sağlayıcısı) gider; bu yüzden her uç yanıtı **beyaz listeyle** küçültülür:
 * - Lead'ler adla değil yalnızca oturum ref'iyle (`l3`) görünür; ad, e-posta, telefon, mesaj içeriği, ilgilenilen
 *   hizmet (sağlık beyanı), meta veri ve onay metni hiçbir zaman dönmez. Sayılar ve durumlar döner.
 * - Gerçek kimlikler ref'e çevrilir (`ref-map.ts`); ajan veritabanı kimliği görmez.
 * - Serbest metinler (uyarı başlığı, karar gerekçesi) kısaltılır; e-posta, telefon ve kimlik (cuid/uuid) benzeri
 *   diziler maskelenir.
 * - Lead'in ülke/dil/kanal alanları elle girilebildiği için (`POST /api/leads` serbest metin kabul eder) beyaz listeyle
 *   kalıba indirgenir; kalıba uymayan değer anahtar ya da değer olarak gönderilmez, `OTHER` altında sayılır.
 * - Bağlantı etiketi (personel adı, hesap kimliği) gömen uyarı başlıkları türe özgü sabit başlıkla değiştirilir.
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
/** Veritabanı kimlikleri: uuid ve cuid (`c` + 20+ harf/rakam). Telefon maskesinden önce uygulanır. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CUID = /\bc[a-z0-9]{20,}\b/gi;

/** Serbest metin: e-posta, 7+ haneli telefon ve kimlik (cuid/uuid) benzeri diziler maskelenir, uzunluk sınırlanır. */
export function scrubText(v: unknown, limit = TEXT_LIMIT): string | null {
  const s = str(v);
  if (!s) return null;
  const masked = s
    .replace(EMAIL, "[e-posta]")
    .replace(UUID, "[kimlik]")
    .replace(CUID, "[kimlik]")
    .replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 7 ? "[telefon]" : m))
    .replace(/\s+/g, " ")
    .trim();
  return masked.length > limit ? `${masked.slice(0, limit - 1)}…` : masked;
}

// ---------------------------------------------------------------- Lead boyutları (beyaz liste)

/** Beyaz listeye uymayan ülke/dil/kanal değeri bu anahtarla toplanır (ham değer gönderilmez). */
export const OTHER = "OTHER";

/** `Lead.channel` için bilinen değerler (`schema.prisma` yorumu, `labels.ts` CHANNEL_LABEL, `webhook-ingest.ts`). */
export const LEAD_CHANNELS: ReadonlySet<string> = new Set(["LEAD_AD", "WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"]);

/** ISO 3166-1 alpha-2 (büyük harfe çevrilir). Boş → null; kalıba uymayan → `OTHER`. */
export function leadCountry(v: unknown): string | null {
  const s = str(v)?.trim().toUpperCase();
  if (!s) return null;
  return /^[A-Z]{2}$/.test(s) ? s : OTHER;
}

/**
 * ISO 639-1 dil kodu (iki harf, küçük harfe çevrilir). Bölge/yazı alt etiketi (`pt-BR`, `zh_Hant`) kabul edilir ama
 * **atılır**: ajan için temel dil yeterli, bölge bilgisi ülke alanında zaten var ve kırılım kardinalitesi düşük kalır.
 * Üç harfli kodlar kabul edilmez: elle girilen `language` alanına yazılmış "Ali", "Ece" gibi kısa adlar dil kodu
 * gibi görünüp ajana gitmesin. Alt etiket BCP 47 biçimine (2–8 harf/rakam) uymuyorsa değer `OTHER` olur. Boş → null.
 */
export function leadLanguage(v: unknown): string | null {
  const s = str(v)?.trim().toLowerCase().replace(/_/g, "-");
  if (!s) return null;
  const m = /^([a-z]{2})(?:-[a-z0-9]{2,8})*$/.exec(s);
  return m ? m[1] : OTHER;
}

/** Kanal: yalnızca `LEAD_CHANNELS` (büyük harfe çevrilir). Boş → null; bilinmeyen → `OTHER`. */
export function leadChannel(v: unknown): string | null {
  const s = str(v)?.trim().toUpperCase();
  if (!s) return null;
  return LEAD_CHANNELS.has(s) ? s : OTHER;
}

// ---------------------------------------------------------------- Uyarı başlığı

/**
 * Başlığına bağlantı etiketi (`conn.name` = bağlayan personelin Facebook adı, `metaAccountId` ya da ham `conn.id`)
 * gömülen uyarı türleri (`workers/meta-sync/src/scheduler.ts` ensureDisconnectAlert/ensureExpiringAlert,
 * `web/app/api/meta/connections/[id]/route.ts`): başlık yerine türe özgü sabit metin gönderilir.
 */
const FIXED_ALERT_TITLES: Record<string, string> = {
  META_DISCONNECTED: "Meta bağlantısı kesildi",
  TOKEN_EXPIRING: "Meta bağlantısının erişim anahtarının süresi dolmak üzere",
};
/** Türü taşımayan bildirimler (`/api/shell`) için aynı başlıkların önekleri. */
const FIXED_TITLE_PREFIXES: [RegExp, string][] = [
  [/^\s*Meta bağlantısı\s/i, "META_DISCONNECTED"],
  [/^\s*Meta token/i, "TOKEN_EXPIRING"],
];
/** Yayımlanan reklam/form adına eklenen kimlik parçası (`campaign-publish.ts`: `#${id.slice(-6)}`), AD_DISAPPROVED başlığına geçer. */
const ID_FRAGMENT = /\s*#[A-Za-z0-9]{6,}\b/g;

/**
 * Uyarı/bildirim başlığı: etiket gömen türlerde sabit başlık; diğerlerinde `#xxxxxx` kimlik parçası atılır ve metin
 * `scrubText` ile maskelenir. Tür yoksa (bildirim) etiket gömen başlıklar önekinden tanınır.
 */
export function alertTitle(type: unknown, title: unknown): string | null {
  const s = str(title);
  const t = str(type) ?? FIXED_TITLE_PREFIXES.find(([re]) => re.test(s ?? ""))?.[1] ?? null;
  if (t && FIXED_ALERT_TITLES[t]) return FIXED_ALERT_TITLES[t];
  return s ? scrubText(s.replace(ID_FRAGMENT, "")) : null;
}

function countBy(rows: Raw[], key: string, normalize: (v: unknown) => string | null = str): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = normalize(row[key]) ?? "UNKNOWN";
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
      title: alertTitle(n.type, n.title),
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
    title: alertTitle(a.type, a.title),
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

// ---------------------------------------------------------------- A/B testleri (Faz 5)

/** Varyant metrikleri (manuel ölçüm): harcama ana birimde (`test-detail.tsx` ile aynı), tıklama ve lead sayı. */
export function sanitizeExperimentMetrics(raw: unknown): { variant: "A" | "B"; spend: number | null; clicks: number | null; leads: number | null }[] {
  const rows = Array.isArray(raw) ? raw : [];
  return (["A", "B"] as const).map((variant, index) => {
    const m = rec(rows[index]);
    return { variant, spend: num(m.spend), clicks: num(m.clicks), leads: num(m.leads) };
  });
}

/**
 * `GET /api/experiments` ya da `GET /api/experiments/:id` içindeki A/B testi. Yalnızca ref, taslak adı (maskelenmiş),
 * durum, gün sayıları ve varyant metrikleri döner; reklam içeriği (anlık görüntü: klinik, başlıklar, metinler) dönmez.
 */
export function sanitizeExperiment(raw: unknown, refs: RefMap) {
  const e = rec(raw);
  const snapshot = rec(e.snapshot);
  return {
    ref: refFor(refs, "experiment", e.id),
    name: scrubText(rec(e.draft).name, 100),
    status: str(e.status),
    elapsedDays: num(e.elapsedDays),
    plannedDays: num(snapshot.duration),
    variants: sanitizeExperimentMetrics(e.metrics),
    updatedAt: day(e.updatedAt),
  };
}

export function sanitizeExperimentList(raw: unknown, refs: RefMap, filter?: { status?: string }) {
  const all = list(rec(raw).experiments);
  const rows = filter?.status ? all.filter((e) => e.status === filter.status) : all;
  return {
    total: rows.length,
    shown: Math.min(rows.length, LIST_LIMIT),
    byStatus: countBy(all, "status"),
    experiments: rows.slice(0, LIST_LIMIT).map((e) => sanitizeExperiment(e, refs)),
  };
}

// ---------------------------------------------------------------- Performans ve rapor

/**
 * İçgörü kırılımı (ülke/dil): anahtar beyaz listeyle normalize edilir, aynı anahtara düşen gruplar (ör. birden çok
 * `OTHER`) birleştirilir; lead sayısına göre ilk 5.
 */
function mergeGroups(rows: Raw[], key: string, normalize: (v: unknown) => string | null) {
  const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  const merged = new Map<string | null, { key: string | null; leads: number | null; qualified: number | null }>();
  for (const g of rows) {
    const k = normalize(g[key]);
    const prev = merged.get(k);
    if (!prev) merged.set(k, { key: k, leads: num(g.leads), qualified: num(g.qualified) });
    else {
      prev.leads = add(prev.leads, num(g.leads));
      prev.qualified = add(prev.qualified, num(g.qualified));
    }
  }
  return [...merged.values()].sort((a, b) => (b.leads ?? 0) - (a.leads ?? 0)).slice(0, 5);
}

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
    byCountry: mergeGroups(list(insights.byCountry), "country", leadCountry).map(({ key, leads, qualified }) => ({ country: key, leads, qualified })),
    byLanguage: mergeGroups(list(insights.byLanguage), "language", leadLanguage).map(({ key, leads, qualified }) => ({ language: key, leads, qualified })),
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
      items: alerts.slice(0, 5).map((a) => ({ severity: str(a.severity), title: alertTitle(a.type, a.title) })),
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
    byChannel: countBy(rows, "channel", leadChannel),
    byCountry: topCounts(countBy(rows, "country", leadCountry)),
    byLanguage: topCounts(countBy(rows, "language", leadLanguage)),
    recent: rows.slice(0, LIST_LIMIT).map((l) => ({
      ref: refFor(refs, "lead", l.id),
      status: str(l.status),
      channel: leadChannel(l.channel),
      language: leadLanguage(l.language),
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

// ---------------------------------------------------------------- İç yazma (R1) sonuçları

/** `POST /api/campaigns`: yeni taslağın ref'i ve durumu. Politika bulgu metni (`policyWarning`) dönmez. */
export function sanitizeCreatedCampaign(raw: unknown, refs: RefMap) {
  const c = rec(rec(raw).campaign);
  return {
    ref: refFor(refs, "campaign", c.id),
    workflowStatus: str(c.workflowStatus) ?? "DRAFT",
    status: str(c.status),
    dailyBudget: major(c.budgetCents),
    currency: str(c.currency),
    policyRisk: str(c.policyRisk),
    adSets: num(c.adSets),
  };
}

/** `POST /api/campaigns/:id/submit`: yeni iş akışı durumu ve politika riski (bulgu metni dönmez). */
export function sanitizeSubmittedCampaign(raw: unknown, refs: RefMap) {
  const c = rec(rec(raw).campaign);
  return {
    ref: refFor(refs, "campaign", c.id),
    workflowStatus: str(c.workflowStatus),
    policyRisk: str(c.policyRisk),
  };
}

/** `PATCH /api/alerts/:id`: uyarının yeni durumu (gövde metni dönmez). */
export function sanitizeUpdatedAlert(raw: unknown, refs: RefMap) {
  const a = rec(rec(raw).alert);
  return { ref: refFor(refs, "alert", a.id), status: str(a.status) };
}

/**
 * `POST /api/studio/generate`: üretilen reklam metni (başlık, gövde, eylem çağrısı) ve politika riski. Reklam metni
 * kişisel veri değildir; yine de maskelenir ve kısaltılır. Klinik profili, form soruları ve WhatsApp karşılaması dönmez
 * (yalnızca var olup olmadıkları).
 */
export function sanitizeGeneratedCopy(raw: unknown) {
  const r = rec(raw);
  const content = rec(r.content);
  const questions = rec(content.instantForm).questions;
  return {
    variants: list(content.variants)
      .slice(0, 4)
      .map((v) => ({ headline: scrubText(v.headline, 150), text: scrubText(v.text, 400), cta: str(v.cta) })),
    instantFormQuestions: Array.isArray(questions) ? questions.length : 0,
    whatsappWelcome: Boolean(str(rec(content.whatsapp).welcome)),
    policyRisk: str(rec(r.policy).risk),
  };
}

/** `POST /api/studio` ve `PATCH /api/studio/:id`: taslağın ref'i, durumu ve politika riski. */
export function sanitizeStudioDraft(raw: unknown, refs: RefMap) {
  const r = rec(raw);
  const d = isRecord(r.draft) ? r.draft : r;
  return {
    ref: refFor(refs, "studio", d.id),
    status: str(d.status),
    policyRisk: str(rec(d.policy).risk),
  };
}

/** `POST /api/leads/refetch`: yalnızca sayılar; lead başına sonuç (`results`) dönmez. */
export function sanitizeRefetchSummary(raw: unknown) {
  const r = rec(raw);
  return {
    attempted: num(r.attempted) ?? 0,
    recovered: num(r.recovered) ?? 0,
    failed: num(r.failed) ?? 0,
    skipped: num(r.skipped) ?? 0,
    remaining: num(r.remaining) ?? 0,
  };
}

// ---------------------------------------------------------------- Dış etki ve harcama (R2/R3) sonuçları

/**
 * `POST /api/campaigns/:id/publish` (PUBLISH/PAUSE/ARCHIVE/ACTIVATE): yeni durum ve yükleme ilerlemesi. Politika bulgu
 * metni, Meta kimliği ve yükleme uyarıları dönmez.
 */
export function sanitizeCampaignAction(raw: unknown, refs: RefMap) {
  const r = rec(raw);
  const c = rec(r.campaign);
  const publish = isRecord(r.publish) ? r.publish : null;
  return {
    ref: refFor(refs, "campaign", c.id),
    action: str(c.action),
    workflowStatus: str(c.workflowStatus),
    status: str(c.status),
    publishStatus: publish ? str(publish.status) : null,
    policyWarning: c.policyWarning ? true : null,
    adsActivated: num(c.adsActivated),
  };
}

/** `PATCH /api/campaigns/:id/budget`: yeni günlük bütçe (ana birim). Ad set payları dönmez. */
export function sanitizeBudgetChange(raw: unknown, refs: RefMap, currency: string | null) {
  const c = rec(rec(raw).campaign);
  return { ref: refFor(refs, "campaign", c.id), dailyBudget: major(c.dailyBudgetCents), currency };
}

/** `POST /api/meta/review-sync`: sayılar ve kampanya başına durum; kampanya ve reklam adları, hata metni dönmez. */
export function sanitizeReviewSync(raw: unknown, refs: RefMap) {
  const r = rec(raw);
  const rows = list(r.campaigns);
  return {
    synced: num(r.synced) ?? rows.length,
    byStatus: countBy(rows, "status"),
    newlyDisapproved: rows.reduce((sum, row) => sum + (num(row.newlyDisapproved) ?? 0), 0),
    campaigns: rows.slice(0, LIST_LIMIT).map((row) => ({
      ref: refFor(refs, "campaign", row.campaignId),
      status: str(row.status),
      ads: num(row.ads),
      newlyDisapproved: num(row.newlyDisapproved),
    })),
  };
}

/** `POST /api/recommendations/:id/apply`: uygulanan kampanyanın ref'i ve bütçe eski → yeni (ana birim). */
export function sanitizeAppliedRecommendation(raw: unknown, refs: RefMap, recommendationId: string) {
  const r = rec(raw);
  return {
    ref: refs.ref("recommendation", recommendationId),
    status: str(r.status) ?? "APPLIED",
    campaignRef: refFor(refs, "campaign", r.appliedCampaignId ?? r.campaignId),
    previousDailyBudget: major(r.previousDailyBudgetCents),
    dailyBudget: major(r.dailyBudgetCents),
    metaSynced: bool(r.metaSynced),
  };
}
