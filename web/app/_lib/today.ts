/**
 * "Bugün" ana sayfası (ADR-0018 · K3-A): role göre "sizden beklenenler" kuyruğu, temel göstergeler ve
 * kurulum rehberi. Sunucu modülüdür (Prisma). Her sorgu çalışma alanı / kuruluşla sınırlıdır.
 *
 * Kuyruk satırı tek bir eylem taşır (ör. "İncele", "Devral", "Düzelt"); eylem her zaman işin yapıldığı
 * sayfaya götürür. Bu modül hiçbir kaydı değiştirmez.
 */
import { prisma, type Prisma } from "@admedic/database";
import { TEAMS, TEAM_SIZE } from "@admedic/lead-team";
import { alertScope } from "./alert-scope";
import { EDIT_ROLES, ESCALATION_ROLES, LEAD_READ_ROLES, type Actor } from "./auth";
import { formatDuration, formatMoney, formatNumber, formatPercent } from "./format";
import { HANDOFF_ALERT_TYPE } from "./lead-assistant";
import { needsReplySummary } from "./inbox";
import {
  PENDING_APPROVAL_LABEL,
  approvalScanLimit,
  listCorrectionRequests,
  listPendingApprovals,
  scopePendingApprovals,
} from "./pending-approvals";
import { alertRecordLinks, campaignHref, leadHref } from "./record-refs";
import { hasSpendAuthority } from "./spend-authority";
import { activeMonthlyCommitmentCents } from "./spend-cap";
import { campaignMetrics, cpl, roas, sinceDays, workspaceMetrics } from "./campaign-metrics";

export type QueueTone = "problem" | "human";

export interface QueueItem {
  key: string;
  /** Satırın türü (küçük üst etiket): "Uyarı", "Etkinleştirme", "Hasta devri"… */
  kind: string;
  title: string;
  context: string | null;
  tone: QueueTone;
  /** Beklemenin başladığı an (sıralama ve "12 dk bekliyor"); bilinmiyorsa null. */
  since: Date | null;
  action: { label: string; href: string };
}

export interface Kpi {
  key: "spend" | "cpl" | "qualified" | "firstResponse";
  label: string;
  value: string;
  hint: string | null;
  /** Hedef aşıldı / eşik dışı: amber vurgulanır (metinde de yazar). */
  warn: boolean;
}

export interface SetupStep {
  key: "meta" | "clinic" | "privacy" | "cap" | "campaign";
  label: string;
  hint: string;
  done: boolean;
  href: string;
}

const ALERT_KIND_ALWAYS_URGENT = ["META_DISCONNECTED", "TOKEN_EXPIRING", "AD_DISAPPROVED", "META_API_ERROR"];
const QUEUE_LIMIT = 12;

const isManager = (role: string) => role === "OWNER" || role === "ADMIN";
/** Hastaya yazabilen roller (ADR-0019): devir ve "yanıt bekliyor" satırları yalnızca onların işidir. */
const canReply = (role: Actor["role"]) => ESCALATION_ROLES.includes(role);
const CLOSED_LEAD = ["TREATED", "LOST"] as const;

async function accountCurrency(actor: Actor): Promise<string> {
  const account = await prisma.adAccount.findFirst({
    where: { orgId: actor.orgId, workspaceId: actor.workspaceId, status: "ACTIVE" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { currency: true },
  });
  return account?.currency ?? "EUR";
}

/** Sizden beklenenler: role göre, önce sorunlar sonra en uzun bekleyen. */
export async function todayQueue(actor: Actor): Promise<{ items: QueueItem[]; total: number; more: boolean }> {
  const items: QueueItem[] = [];
  const role = actor.role;
  /** Bir kaynak kendi sınırına ulaştıysa toplam "en az" sayıdır. */
  let more = false;

  // 1) Uyarılar: yöneticiler ve reklam uzmanı kritik ya da Meta kaynaklı açık uyarıları görür.
  if (isManager(role) || role === "MEDIA_BUYER") {
    const where: Prisma.AlertWhereInput = {
      workspaceId: actor.workspaceId,
      status: "OPEN",
      type: { not: HANDOFF_ALERT_TYPE },
      OR: [{ severity: "CRITICAL" }, { type: { in: ALERT_KIND_ALWAYS_URGENT as Prisma.EnumAlertTypeFilter["in"] } }],
    };
    const alerts = await prisma.alert.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: 6,
      select: { id: true, title: true, message: true, createdAt: true, entityType: true, entityId: true },
    });
    if (alerts.length === 6) more = true;
    const links = await alertRecordLinks(actor.workspaceId, alerts);
    for (const a of alerts)
      items.push({
        key: `alert-${a.id}`,
        kind: "Kritik uyarı",
        title: a.title,
        context: a.message.length > 140 ? `${a.message.slice(0, 137)}…` : a.message,
        tone: "problem",
        since: a.createdAt,
        action: { label: "İncele", href: links.get(a.id) ?? "/alerts" },
      });
  }

  // 2) Asistanın devrettiği, kimsenin devralmadığı konuşmalar (hastayla yazışabilen roller; kapanmış lead'ler hariç).
  const handoffLeadIds = new Set<string>();
  if (canReply(role)) {
    const handoffs = await prisma.conversation.findMany({
      where: {
        workspaceId: actor.workspaceId,
        status: "ESCALATED",
        escalatedTo: null,
        lead: { status: { notIn: [...CLOSED_LEAD] } },
      },
      orderBy: [{ escalatedAt: "asc" }, { createdAt: "asc" }],
      take: 6,
      select: {
        id: true,
        channel: true,
        escalatedAt: true,
        createdAt: true,
        lead: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (handoffs.length === 6) more = true;
    for (const h of handoffs) handoffLeadIds.add(h.lead.id);
    for (const h of handoffs)
      items.push({
        key: `handoff-${h.id}`,
        kind: "Hasta devri",
        title: [h.lead.firstName, h.lead.lastName].filter(Boolean).join(" ") || "Adsız lead",
        context: "Asistan konuşmayı devretti; henüz kimse devralmadı.",
        tone: "human",
        since: h.escalatedAt ?? h.createdAt,
        action: { label: "Devral", href: leadHref(h.lead.id) },
      });
  }

  // 3) Onay işleri (Onaylar kutusuyla aynı kapsam) ve düzeltme istenenler.
  if (isManager(role) || role === "MEDIA_BUYER") {
    const [all, canApproveSpend] = await Promise.all([listPendingApprovals(actor.workspaceId, { limit: approvalScanLimit(role) }), hasSpendAuthority(actor)]);
    const scoped = scopePendingApprovals(all, actor, { canApproveSpend });
    let approvalRows = 0;
    const canAct = (kind: string) => (kind === "ACTIVATION" ? canApproveSpend : isManager(role));
    for (const kind of ["ACTIVATION", "CAMPAIGN", "CONTENT", "RECOMMENDATION", "LEAD_PROPOSAL"] as const) {
      for (const item of scoped.items[kind]) {
        if (!canAct(kind)) continue; // Reklam uzmanının kendi gönderdikleri onun işi değil; Onaylar'da izlenir.
        if (++approvalRows > 10) {
          more = true;
          continue;
        }
        items.push({
          key: `approval-${kind}-${item.id}`,
          kind: PENDING_APPROVAL_LABEL[kind].section,
          title: item.title,
          context: item.detail,
          tone: "human",
          since: item.waitingSince,
          action: { label: kind === "ACTIVATION" ? "Etkinleştir" : "İncele", href: "/approvals" },
        });
      }
    }
    if (role === "MEDIA_BUYER") {
      const corrections = await listCorrectionRequests(actor.workspaceId, { userId: actor.userId, limit: 6 });
      if (corrections.length === 6) more = true;
      for (const c of corrections)
        items.push({
          key: `correction-${c.kind}-${c.id}`,
          kind: "Düzeltme istendi",
          title: c.title,
          context: c.reason ? `Gerekçe: ${c.reason}` : null,
          tone: "problem",
          since: c.rejectedAt,
          action: { label: "Düzelt", href: c.href },
        });
      // Onaylanmış, Meta'ya yüklenmeyi bekleyen kampanyalar.
      const ready = await prisma.campaign.findMany({
        where: { workspaceId: actor.workspaceId, workflowStatus: "APPROVED" },
        orderBy: { approvedAt: "asc" },
        take: 6,
        select: { id: true, name: true, approvedAt: true, updatedAt: true },
      });
      if (ready.length === 6) more = true;
      for (const c of ready)
        items.push({
          key: `ready-${c.id}`,
          kind: "Meta'ya yüklenmeye hazır",
          title: c.name,
          context: "Onaylandı; Meta'ya kapalı yükleyin. Harcama etkinleştirmeyle başlar.",
          tone: "human",
          since: c.approvedAt ?? c.updatedAt,
          action: { label: "Meta'ya yükle", href: campaignHref(c.id) },
        });
    }
  }

  // 4) Yanıt bekleyen diğer lead'ler: tek özet satırı (liste Lead'ler sayfasında). Yukarıda ayrı satırda
  //    gösterilen devirler burada yeniden sayılmaz.
  if (canReply(role)) {
    const summary = await needsReplySummary(actor);
    const others = summary.leadIds.filter((id) => !handoffLeadIds.has(id));
    if (others.length > 0)
      items.push({
        key: "leads-waiting",
        kind: "Lead'ler",
        title: `${formatNumber(others.length)} lead yanıt bekliyor`,
        context: handoffLeadIds.size ? "Yukarıdaki devirler dışında; en uzun bekleyenden başlayın." : "En uzun bekleyenden başlayın.",
        tone: "human",
        since: summary.oldest,
        action: { label: "Lead'leri aç", href: "/leads?tab=waiting" },
      });
  }

  // Önce sorunlar, hemen ardından bir insan bekleyen hasta devirleri, sonra diğerleri; her grupta en uzun bekleyen önce.
  const rank = (i: QueueItem) => (i.tone === "problem" ? 0 : i.key.startsWith("handoff-") ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b) || (a.since?.getTime() ?? Infinity) - (b.since?.getTime() ?? Infinity));
  if (items.length > QUEUE_LIMIT) more = true;
  return { items: items.slice(0, QUEUE_LIMIT), total: items.length, more };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Hedef ilk yanıt süresi (spec 3.8: hızlı yanıt); aşılırsa gösterge amber. */
export const FIRST_RESPONSE_TARGET_MS = 15 * 60_000;

/**
 * Dört temel gösterge: bu ayın harcaması / aylık üst sınır, son 7 gün lead başı maliyet (CPL),
 * son 30 gün nitelikli lead oranı ve ilk yanıt süresi medyanı (asistan yanıtları dahil).
 */
export async function todayKpis(actor: Actor, now = new Date()): Promise<Kpi[]> {
  // Kampanya toplamlarıyla aynı kural (campaign-metrics.ts: en üst düzey, günlük satırlar, UTC günü).
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const weekStart = sinceDays(7, now);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const currency = await accountCurrency(actor);
  const [month, week, org, committed, leads30, responded] = await Promise.all([
    workspaceMetrics(actor.workspaceId, monthStart),
    workspaceMetrics(actor.workspaceId, weekStart),
    prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { monthlyAdBudgetCap: true } }),
    activeMonthlyCommitmentCents(prisma, actor.orgId, currency),
    prisma.lead.findMany({
      where: { workspaceId: actor.workspaceId, createdAt: { gte: monthAgo } },
      select: { status: true, qualifiedAt: true },
    }),
    prisma.lead.findMany({
      where: { workspaceId: actor.workspaceId, createdAt: { gte: monthAgo } },
      select: {
        createdAt: true,
        conversations: {
          select: { messages: { where: { direction: "OUTGOING" }, orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } } },
        },
      },
    }),
  ]);

  const spendMonth = month.spend;
  const cap = org.monthlyAdBudgetCap;
  const spendWeek = week.spend;
  const leadsWeek = week.leads;
  const cplWeek = cpl(week);
  const qualifiedStatuses = ["QUALIFIED", "CONSULTATION_BOOKED", "TRAVEL_PLANNED", "TREATED"];
  const qualified = leads30.filter((l) => l.qualifiedAt || qualifiedStatuses.includes(l.status)).length;
  const firstResponses = responded
    .map((l) => {
      const first = l.conversations
        .flatMap((c) => c.messages.map((m) => m.createdAt.getTime()))
        .sort((a, b) => a - b)[0];
      return first != null ? Math.max(0, first - l.createdAt.getTime()) : null;
    })
    .filter((v): v is number => v != null);
  const medianResponse = median(firstResponses);

  return [
    {
      key: "spend",
      label: "Bu ayın harcaması",
      value: formatMoney(spendMonth, currency),
      hint:
        cap != null
          ? `Kuruluşun aylık üst sınırı ${formatMoney(cap, currency)} · etkin kampanyaların aylık tahmini ${formatMoney(committed, currency)}`
          : `Kuruluşun aylık üst sınırı tanımlı değil · etkin kampanyaların aylık tahmini ${formatMoney(committed, currency)}`,
      warn: cap != null && committed > cap,
    },
    {
      key: "cpl",
      label: "Lead başı maliyet (CPL), 7 gün",
      value: cplWeek != null ? formatMoney(cplWeek, currency, { precise: true }) : "—",
      hint: leadsWeek > 0 ? `${formatNumber(leadsWeek)} lead · ${formatMoney(spendWeek, currency)} harcama` : "Son 7 günde Meta'dan lead verisi yok.",
      warn: false,
    },
    {
      key: "qualified",
      label: "Nitelikli lead oranı, 30 gün",
      value: leads30.length ? formatPercent((qualified / leads30.length) * 100, 0) : "—",
      hint: leads30.length ? `${formatNumber(qualified)} / ${formatNumber(leads30.length)} lead` : "Son 30 günde lead yok.",
      warn: false,
    },
    {
      key: "firstResponse",
      label: "İlk yanıt süresi (medyan)",
      value: medianResponse != null ? formatDuration(medianResponse) : "—",
      hint:
        medianResponse != null
          ? `${formatNumber(firstResponses.length)} lead, asistan yanıtları dahil · hedef ${formatDuration(FIRST_RESPONSE_TARGET_MS)}`
          : "Son 30 günde yanıtlanan lead yok.",
      warn: medianResponse != null && medianResponse > FIRST_RESPONSE_TARGET_MS,
    },
  ];
}

/** Kurulum rehberi (yalnızca Hesap sahibi / Yönetici; tamamlanınca gösterilmez). */
export async function setupSteps(actor: Actor): Promise<SetupStep[]> {
  const [meta, clinics, org, campaigns] = await Promise.all([
    prisma.metaConnection.count({ where: { orgId: actor.orgId, status: "CONNECTED" } }),
    prisma.clinicProfile.count({ where: { workspaceId: actor.workspaceId } }),
    prisma.organization.findUniqueOrThrow({
      where: { id: actor.orgId },
      select: { privacyPolicyUrl: true, consentText: true, privacyNoticeText: true, monthlyAdBudgetCap: true },
    }),
    prisma.campaign.count({ where: { workspaceId: actor.workspaceId, workflowStatus: { not: "DRAFT" } } }),
  ]);
  return [
    { key: "meta", label: "Meta hesabınızı bağlayın", hint: "Reklam hesabı, sayfa ve lead formları için gerekli.", done: meta > 0, href: "/meta-connections" },
    { key: "clinic", label: "Klinik profilini oluşturun", hint: "Hizmetler, diller ve yasaklı ifadeler reklam üretimine girer.", done: clinics > 0, href: "/clinic" },
    {
      key: "privacy",
      label: "Aydınlatma ve açık rıza metinlerini girin",
      hint: "Anında Form yayını için aydınlatma metni bağlantısı zorunludur.",
      done: Boolean(org.privacyPolicyUrl && (org.privacyNoticeText || org.consentText)),
      href: "/clinic",
    },
    { key: "cap", label: "Aylık harcama üst sınırını belirleyin", hint: "Etkin kampanyaların aylık toplamı bu sınırı aşamaz.", done: org.monthlyAdBudgetCap != null, href: "/campaign-planner" },
    { key: "campaign", label: "İlk kampanyanızı onaya gönderin", hint: "Yeni kampanya ekranı pazar, dil ve bütçeyi önerir.", done: campaigns > 0, href: "/campaign-planner" },
  ];
}

/** Son 7 günde harcaması olan kampanyalar, reklam getirisine göre yüksekten düşüğe. */
async function campaignRowsByRoas(actor: Actor): Promise<CampaignRow[]> {
  const totals = await campaignMetrics(actor.workspaceId, sinceDays(7));
  const withSpend = [...totals.entries()].filter(([, t]) => t.spend > 0);
  if (!withSpend.length) return [];
  const campaigns = await prisma.campaign.findMany({
    where: { workspaceId: actor.workspaceId, id: { in: withSpend.map(([id]) => id) } },
    select: { id: true, name: true, adAccount: { select: { currency: true } } },
  });
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  return withSpend
    .filter(([id]) => byId.has(id))
    .map(([id, t]): CampaignRow => {
      const c = byId.get(id)!;
      return { id: c.id, name: c.name, currency: c.adAccount.currency || "EUR", spend: t.spend, leads: t.leads, roas: roas(t) };
    })
    .sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0));
}

/** Analist / izleyici: son 7 günün en iyi ve en zayıf kampanyaları (reklam getirisine göre). */
export async function campaignExtremes(actor: Actor): Promise<{ best: CampaignRow[]; worst: CampaignRow[] }> {
  const rows = await campaignRowsByRoas(actor);
  // En düşük listesi en yüksek listesindeki kampanyayı tekrar etmez (az kampanyada liste kısalır).
  return { best: rows.slice(0, 3), worst: rows.slice(Math.max(3, rows.length - 3)).reverse() };
}

/** Bugün ekranındaki kampanya getirisi çubukları (ADR-0030): son 7 günün en yüksek getirili kampanyaları. */
export async function campaignRanking(actor: Actor, limit = 5): Promise<CampaignRow[]> {
  return (await campaignRowsByRoas(actor)).slice(0, limit);
}

export interface PipelineStage {
  key: "draft" | "review" | "live" | "leads" | "booked" | "alerts";
  label: string;
  count: number;
  href: string;
  /** `live`: yayındaki iş (vurgulu); `warn`: bir insandan eylem bekleyen iş (yalnızca sayı sıfırdan büyükken amber). */
  tone: "idle" | "live" | "warn";
}

const CAMPAIGN_READ_ROLES: Actor["role"][] = ["OWNER", "ADMIN", "MEDIA_BUYER", "ANALYST", "VIEWER"];

/**
 * Akış bandı (ADR-0030): işin hangi aşamada kaç kayıtla durduğu — taslak, onay, yayın, lead, randevu, uyarı.
 * Her hücre rolün menüde görebildiği sayfaya gider; rolün göremediği aşama bantta yer almaz. Sayılar çalışma
 * alanıyla sınırlıdır; onay sayısı Onaylar kutusuyla aynı kapsamı kullanır.
 */
export async function todayPipeline(actor: Actor): Promise<PipelineStage[]> {
  const role = actor.role;
  const stages: PipelineStage[] = [];
  const inWorkspace = { workspaceId: actor.workspaceId };

  if (CAMPAIGN_READ_ROLES.includes(role)) {
    const [draft, live] = await Promise.all([
      prisma.campaign.count({ where: { ...inWorkspace, workflowStatus: { in: ["DRAFT", "REJECTED"] } } }),
      prisma.campaign.count({ where: { ...inWorkspace, workflowStatus: "ACTIVE" } }),
    ]);
    stages.push({ key: "draft", label: "Taslak", count: draft, href: "/campaigns", tone: "idle" });
    if (EDIT_ROLES.includes(role)) {
      const [all, canApproveSpend] = await Promise.all([
        listPendingApprovals(actor.workspaceId, { limit: approvalScanLimit(role) }),
        hasSpendAuthority(actor),
      ]);
      const pending = scopePendingApprovals(all, actor, { canApproveSpend }).counts.total;
      stages.push({ key: "review", label: "Onay bekliyor", count: pending, href: "/approvals", tone: "warn" });
    }
    stages.push({ key: "live", label: "Yayında", count: live, href: "/campaigns", tone: "live" });
  }

  if (LEAD_READ_ROLES.includes(role)) {
    const [waiting, booked] = await Promise.all([
      canReply(role)
        ? needsReplySummary(actor).then((summary) => summary.count)
        : prisma.lead.count({ where: { ...inWorkspace, status: "NEW" } }),
      prisma.lead.count({ where: { ...inWorkspace, status: "CONSULTATION_BOOKED" } }),
    ]);
    stages.push(
      canReply(role)
        ? { key: "leads", label: "Yanıt bekleyen lead", count: waiting, href: "/leads?tab=waiting", tone: "warn" }
        : { key: "leads", label: "Yeni lead", count: waiting, href: "/leads", tone: "idle" },
    );
    stages.push({ key: "booked", label: "Randevu", count: booked, href: "/leads", tone: "idle" });
  }

  const scope = alertScope(actor);
  if (scope) {
    const open = await prisma.alert.count({ where: { ...scope, status: "OPEN" } });
    stages.push({ key: "alerts", label: "Açık uyarı", count: open, href: "/alerts", tone: "warn" });
  }
  return stages;
}

export interface CampaignRow {
  id: string;
  name: string;
  currency: string;
  spend: number;
  leads: number;
  roas: number | null;
}

export interface LeadTeamSnapshot {
  /** Hiç çalıştırılmadıysa null. */
  status: "RUNNING" | "COMPLETED" | "FAILED" | null;
  simulated: boolean;
  teamSize: number;
  agentsDone: number;
  /** Son çalıştırmanın bir insanın kararını bekleyen önerileri. */
  pendingProposals: number;
  startedAt: Date | null;
  teams: { key: string; title: string; specialists: number; reported: number }[];
}

const LEAD_TEAM_VIEW_ROLES: Actor["role"][] = [...EDIT_ROLES, "ANALYST"];

/**
 * Bugün ekranındaki lead takımı özeti (ADR-0030): kadro hiyerarşisi ve son çalıştırmanın durumu. Sayfayı menüde
 * göremeyen rolde null döner. Yalnızca okur; takılı kalan çalıştırmayı Lead takımı sayfası kapatır.
 */
export async function todayLeadTeam(actor: Actor): Promise<LeadTeamSnapshot | null> {
  if (!LEAD_TEAM_VIEW_ROLES.includes(actor.role)) return null;
  const latest = await prisma.leadTeamRun.findFirst({
    where: { workspaceId: actor.workspaceId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, simulated: true, agentsCompleted: true, agentsFailed: true, startedAt: true },
  });
  const [reports, pendingProposals] = latest
    ? await Promise.all([
        prisma.leadTeamReport.findMany({
          where: { runId: latest.id, role: "SPECIALIST", status: "COMPLETED" },
          select: { team: true },
        }),
        prisma.leadTeamProposal.count({ where: { runId: latest.id, workspaceId: actor.workspaceId, status: "PENDING" } }),
      ])
    : [[], 0];
  const reported = new Map<string, number>();
  for (const r of reports) if (r.team) reported.set(r.team, (reported.get(r.team) ?? 0) + 1);
  return {
    status: latest?.status ?? null,
    simulated: latest?.simulated ?? false,
    teamSize: TEAM_SIZE,
    agentsDone: latest ? latest.agentsCompleted + latest.agentsFailed : 0,
    pendingProposals,
    startedAt: latest?.startedAt ?? null,
    teams: TEAMS.map((team) => ({
      key: team.key,
      title: team.title,
      specialists: team.specialists.length,
      reported: reported.get(team.key) ?? 0,
    })),
  };
}
