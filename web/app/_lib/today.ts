/**
 * "Bugün" ana sayfası (ADR-0018 · K3-A): role göre "sizden beklenenler" kuyruğu, temel göstergeler ve
 * kurulum rehberi. Sunucu modülüdür (Prisma). Her sorgu çalışma alanı / kuruluşla sınırlıdır.
 *
 * Kuyruk satırı tek bir eylem taşır (ör. "İncele", "Devral", "Düzelt"); eylem her zaman işin yapıldığı
 * sayfaya götürür. Bu modül hiçbir kaydı değiştirmez.
 */
import { prisma, type Prisma } from "@admedic/database";
import type { Actor } from "./auth";
import { formatMoney, formatNumber } from "./format";
import { HANDOFF_ALERT_TYPE } from "./lead-assistant";
import {
  PENDING_APPROVAL_LABEL,
  listCorrectionRequests,
  listPendingApprovals,
  scopePendingApprovals,
} from "./pending-approvals";
import { alertRecordLinks, campaignHref, leadHref } from "./record-refs";
import { hasSpendAuthority } from "./spend-authority";
import { activeMonthlyCommitmentCents } from "./spend-cap";

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
const isCare = (role: string) => ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR"].includes(role);

async function accountCurrency(actor: Actor): Promise<string> {
  const account = await prisma.adAccount.findFirst({
    where: { orgId: actor.orgId, workspaceId: actor.workspaceId, status: "ACTIVE" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { currency: true },
  });
  return account?.currency ?? "EUR";
}

/** Sizden beklenenler: role göre, önce sorunlar sonra en uzun bekleyen. */
export async function todayQueue(actor: Actor): Promise<{ items: QueueItem[]; total: number }> {
  const items: QueueItem[] = [];
  const role = actor.role;

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

  // 2) Asistanın devrettiği, kimsenin devralmadığı konuşmalar (hastayla yazışabilen roller).
  if (isCare(role)) {
    const handoffs = await prisma.conversation.findMany({
      where: { workspaceId: actor.workspaceId, status: "ESCALATED", escalatedTo: null },
      orderBy: { escalatedAt: "asc" },
      take: 6,
      select: { id: true, channel: true, escalatedAt: true, lead: { select: { id: true, firstName: true, lastName: true } } },
    });
    for (const h of handoffs)
      items.push({
        key: `handoff-${h.id}`,
        kind: "Hasta devri",
        title: [h.lead.firstName, h.lead.lastName].filter(Boolean).join(" ") || "Adsız lead",
        context: "Asistan konuşmayı devretti; henüz kimse devralmadı.",
        tone: "human",
        since: h.escalatedAt,
        action: { label: "Devral", href: leadHref(h.lead.id) },
      });
  }

  // 3) Onay işleri (Onaylar kutusuyla aynı kapsam) ve düzeltme istenenler.
  if (isManager(role) || role === "MEDIA_BUYER") {
    const [all, canApproveSpend] = await Promise.all([listPendingApprovals(actor.workspaceId, { limit: 10 }), hasSpendAuthority(actor)]);
    const scoped = scopePendingApprovals(all, actor, { canApproveSpend });
    const canAct = (kind: string) => (kind === "ACTIVATION" ? canApproveSpend : isManager(role));
    for (const kind of ["ACTIVATION", "CAMPAIGN", "CONTENT", "RECOMMENDATION"] as const) {
      for (const item of scoped.items[kind]) {
        if (!canAct(kind)) continue; // Reklam uzmanının kendi gönderdikleri onun işi değil; Onaylar'da izlenir.
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

  // 4) Yanıt bekleyen lead'ler: tek özet satırı (liste Lead'ler sayfasında).
  if (isCare(role)) {
    const [waiting, oldest] = await Promise.all([
      prisma.lead.count({ where: { workspaceId: actor.workspaceId, status: "NEW" } }),
      prisma.lead.findFirst({ where: { workspaceId: actor.workspaceId, status: "NEW" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    ]);
    if (waiting > 0)
      items.push({
        key: "leads-waiting",
        kind: "Lead'ler",
        title: `${formatNumber(waiting)} lead yanıt bekliyor`,
        context: "En uzun bekleyenden başlayın.",
        tone: "human",
        since: oldest?.createdAt ?? null,
        action: { label: "Lead'leri aç", href: "/leads?status=NEW" },
      });
  }

  const rank = (i: QueueItem) => (i.tone === "problem" ? 0 : 1);
  items.sort((a, b) => rank(a) - rank(b) || (a.since?.getTime() ?? Infinity) - (b.since?.getTime() ?? Infinity));
  return { items: items.slice(0, QUEUE_LIMIT), total: items.length };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** "12 dk", "3 sa 5 dk", "2 gün". */
export function responseDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} sa ${minutes % 60} dk` : `${hours} sa`;
  return `${Math.round(hours / 24)} gün`;
}

/** Hedef ilk yanıt süresi (spec 3.8: hızlı yanıt); aşılırsa gösterge amber. */
export const FIRST_RESPONSE_TARGET_MS = 15 * 60_000;

/**
 * Dört temel gösterge: bu ayın harcaması / aylık üst sınır, son 7 gün lead başı maliyet (CPL),
 * son 30 gün nitelikli lead oranı ve ilk yanıt süresi medyanı (asistan yanıtları dahil).
 */
export async function todayKpis(actor: Actor, now = new Date()): Promise<Kpi[]> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  weekStart.setUTCHours(0, 0, 0, 0);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const currency = await accountCurrency(actor);
  const [month, week, org, committed, leads30, responded] = await Promise.all([
    prisma.insightSnapshot.aggregate({ where: { workspaceId: actor.workspaceId, date: { gte: monthStart } }, _sum: { spend: true } }),
    prisma.insightSnapshot.aggregate({ where: { workspaceId: actor.workspaceId, date: { gte: weekStart } }, _sum: { spend: true, leads: true } }),
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

  const spendMonth = month._sum.spend ?? 0;
  const cap = org.monthlyAdBudgetCap;
  const spendWeek = week._sum.spend ?? 0;
  const leadsWeek = week._sum.leads ?? 0;
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
          ? `Aylık üst sınır ${formatMoney(cap, currency)} · etkin kampanyaların aylık tahmini ${formatMoney(committed, currency)}`
          : `Aylık üst sınır tanımlı değil · etkin kampanyaların aylık tahmini ${formatMoney(committed, currency)}`,
      warn: cap != null && committed > cap,
    },
    {
      key: "cpl",
      label: "Lead başı maliyet (CPL), 7 gün",
      value: leadsWeek > 0 ? formatMoney(Math.round(spendWeek / leadsWeek), currency, { precise: true }) : "—",
      hint: leadsWeek > 0 ? `${formatNumber(leadsWeek)} lead · ${formatMoney(spendWeek, currency)} harcama` : "Son 7 günde Meta'dan lead verisi yok.",
      warn: false,
    },
    {
      key: "qualified",
      label: "Nitelikli lead oranı, 30 gün",
      value: leads30.length ? `%${formatNumber(Math.round((qualified / leads30.length) * 100))}` : "—",
      hint: leads30.length ? `${formatNumber(qualified)} / ${formatNumber(leads30.length)} lead` : "Son 30 günde lead yok.",
      warn: false,
    },
    {
      key: "firstResponse",
      label: "İlk yanıt süresi (medyan)",
      value: medianResponse != null ? responseDuration(medianResponse) : "—",
      hint:
        medianResponse != null
          ? `${formatNumber(firstResponses.length)} lead, asistan yanıtları dahil · hedef ${responseDuration(FIRST_RESPONSE_TARGET_MS)}`
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
    { key: "campaign", label: "İlk kampanyanızı onaya gönderin", hint: "Planlayıcı pazar, dil ve bütçeyi önerir.", done: campaigns > 0, href: "/campaign-planner" },
  ];
}

/** Analist / izleyici: son 7 günün en iyi ve en zayıf kampanyaları (reklam getirisine göre). */
export async function campaignExtremes(actor: Actor): Promise<{ best: CampaignRow[]; worst: CampaignRow[] }> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - 6);
  // Anlık görüntüler reklam, reklam seti ya da kampanya düzeyinde olabilir; hepsi kampanyaya toplanır.
  const sums = await prisma.insightSnapshot.groupBy({
    by: ["campaignId", "adSetId", "adId"],
    where: { workspaceId: actor.workspaceId, date: { gte: since } },
    _sum: { spend: true, conversionValue: true, leads: true },
  });
  const adIds = [...new Set(sums.filter((s) => !s.campaignId && s.adId).map((s) => s.adId!))];
  const adSetIds = [...new Set(sums.filter((s) => !s.campaignId && !s.adId && s.adSetId).map((s) => s.adSetId!))];
  const [ads, adSets] = await Promise.all([
    adIds.length
      ? prisma.ad.findMany({ where: { workspaceId: actor.workspaceId, id: { in: adIds } }, select: { id: true, adSet: { select: { campaignId: true } } } })
      : [],
    adSetIds.length
      ? prisma.adSet.findMany({ where: { workspaceId: actor.workspaceId, id: { in: adSetIds } }, select: { id: true, campaignId: true } })
      : [],
  ]);
  const adCampaign = new Map(ads.map((a) => [a.id, a.adSet.campaignId]));
  const adSetCampaign = new Map(adSets.map((a) => [a.id, a.campaignId]));
  const totals = new Map<string, { spend: number; value: number; leads: number }>();
  for (const s of sums) {
    const campaignId = s.campaignId ?? (s.adId ? adCampaign.get(s.adId) : s.adSetId ? adSetCampaign.get(s.adSetId) : undefined);
    if (!campaignId) continue;
    const t = totals.get(campaignId) ?? { spend: 0, value: 0, leads: 0 };
    t.spend += s._sum.spend ?? 0;
    t.value += s._sum.conversionValue ?? 0;
    t.leads += s._sum.leads ?? 0;
    totals.set(campaignId, t);
  }
  const withSpend = [...totals.entries()].filter(([, t]) => t.spend > 0);
  if (!withSpend.length) return { best: [], worst: [] };
  const campaigns = await prisma.campaign.findMany({
    where: { workspaceId: actor.workspaceId, id: { in: withSpend.map(([id]) => id) } },
    select: { id: true, name: true, adAccount: { select: { currency: true } } },
  });
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const rows: CampaignRow[] = withSpend
    .filter(([id]) => byId.has(id))
    .map(([id, t]) => {
      const c = byId.get(id)!;
      return {
        id: c.id,
        name: c.name,
        currency: c.adAccount.currency || "EUR",
        spend: t.spend,
        leads: t.leads,
        roas: t.spend > 0 ? t.value / t.spend : null,
      };
    })
    .sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0));
  return { best: rows.slice(0, 3), worst: rows.length > 3 ? rows.slice(-3).reverse() : [] };
}

export interface CampaignRow {
  id: string;
  name: string;
  currency: string;
  spend: number;
  leads: number;
  roas: number | null;
}
