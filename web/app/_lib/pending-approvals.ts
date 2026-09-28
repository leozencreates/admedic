/**
 * Onay işi (ADR-0016 · Faz 1 madde 11): bir insanın kararını ya da işlemini bekleyen kayıtlar.
 * - İçerik onayı: reklam içeriği (stüdyo taslağı) IN_REVIEW → stüdyoda Hesap sahibi veya Yönetici onaylar.
 * - Kampanya onayı: kampanya IN_REVIEW → planlayıcıda Hesap sahibi veya Yönetici onaylar.
 * - Etkinleştirme: Meta'ya kapalı yüklenmiş kampanya (PUBLISHED_PAUSED) → harcama yetkisi olanlar etkinleştirir.
 * - Bütçe önerisi: öneri PENDING → Öneriler sayfasında Hesap sahibi veya Yönetici onaylar.
 * Yetki metinleri API kurallarıyla aynıdır (`studio-service.changeDraft`, `api/campaigns/[id]/approve`,
 * `campaign-publish.activateCampaign` + `spend-authority`, `api/recommendations/[id]/approve`).
 *
 * Ajan kararları (AgentDecision) onay işi DEĞİLDİR: onları onaylayan bir kod yolu yoktur
 * (ADR-0002; `api/decisions` salt okunur). Bu yüzden burada sayılmaz.
 *
 * Şemada "gönderen" alanı olmadığından gönderen ve bekleme başlangıcı denetim kaydından okunur
 * (DRAFT_SUBMIT, CAMPAIGN_SUBMITTED, CAMPAIGN_PUBLISHED/PAUSED, RECOMMENDATION_UPDATED,
 * RECOMMENDATIONS_GENERATED); kayıt yoksa gönderen bilinmez, başlangıç kaydın son güncellemesidir.
 * Sunucu modülüdür (Prisma); istemci bileşenleri içe aktarmaz.
 */
import { prisma, type Prisma } from "@admedic/database";
import { formatMoney } from "./format";
import { policyRiskStyle, priorityLabel, roleLabel } from "./labels";
import { RECOMMENDATION_KIND_LABEL, recommendationKind } from "./recommendation-kinds";
import { RECOMMENDATIONS_HREF, campaignHref, studioDraftHref } from "./record-refs";

export const PENDING_APPROVAL_KINDS = ["CONTENT", "CAMPAIGN", "ACTIVATION", "RECOMMENDATION"] as const;
export type PendingApprovalKind = (typeof PENDING_APPROVAL_KINDS)[number];

/** Onaylar sayfasındaki bölüm adı ve Genel Bakış kırılımındaki kısa ad. */
export const PENDING_APPROVAL_LABEL: Record<PendingApprovalKind, { section: string; short: string }> = {
  CONTENT: { section: "İçerik onayı", short: "İçerik" },
  CAMPAIGN: { section: "Kampanya onayı", short: "Kampanya" },
  ACTIVATION: { section: "Etkinleştirme", short: "Etkinleştirme" },
  RECOMMENDATION: { section: "Bütçe önerisi", short: "Öneri" },
};

/** İçerik, kampanya ve öneri onayı: yalnızca OWNER/ADMIN. */
export const APPROVER_LABEL = `${roleLabel("OWNER")} veya ${roleLabel("ADMIN")}`;
/** Etkinleştirme: Owner ya da Owner'ın harcama yetkisi verdiği üye (spec 3.6). */
export const SPEND_AUTHORITY_LABEL = "Harcama yetkisi olanlar";

export interface PendingApprovalItem {
  kind: PendingApprovalKind;
  id: string;
  title: string;
  /** Ek bağlam: içerik kontrolü, günlük bütçe, öneri türü ve önceliği. */
  detail: string | null;
  /** Gönderenin adı (yoksa e-postası); bilinmiyorsa null. */
  submittedBy: string | null;
  /** "Gönderen", "Meta'ya yükleyen", "Duraklatan", "Onaya gönderen", "Oluşturan". */
  submittedByLabel: string;
  /** Beklemenin başladığı an: ilgili denetim kaydı, yoksa kaydın son güncellemesi. */
  waitingSince: Date;
  createdAt: Date;
  updatedAt: Date;
  /** Kim işlem yapabilir. */
  actors: string;
  /** Kararın ya da işlemin verildiği sayfa. */
  href: string;
  /** Gönderenin kullanıcı kimliği (Reklam uzmanı yalnızca kendi gönderdiklerini görür); bilinmiyorsa null. */
  submittedById: string | null;
  /** İçerik taslağının sürümü (onay/ret çağrısı eşzamanlılık denetimi için). */
  version?: number;
  /** Kampanya ve etkinleştirme: günlük bütçe (minor unit) ve para birimi. */
  dailyBudgetCents?: number | null;
  currency?: string;
  /** Kampanya iş akışı durumu (aşama şeridi için). */
  workflowStatus?: string;
}

/** Düzeltme istenen iş (içerik ya da kampanya): gönderene geri döner. */
export interface CorrectionItem {
  kind: "CONTENT" | "CAMPAIGN";
  id: string;
  title: string;
  reason: string | null;
  rejectedBy: string | null;
  rejectedAt: Date;
  href: string;
}

export interface PendingApprovalCounts {
  total: number;
  byKind: Record<PendingApprovalKind, number>;
}

export interface PendingApprovals {
  counts: PendingApprovalCounts;
  /** Her türde en uzun bekleyen önce. */
  items: Record<PendingApprovalKind, PendingApprovalItem[]>;
}

const where = {
  content: (workspaceId: string) => ({ workspaceId, status: "IN_REVIEW" as const }),
  campaign: (workspaceId: string) => ({ workspaceId, workflowStatus: "IN_REVIEW" as const }),
  activation: (workspaceId: string) => ({ workspaceId, workflowStatus: "PUBLISHED_PAUSED" as const }),
  recommendation: (workspaceId: string) => ({ workspaceId, status: "PENDING" as const }),
};

export async function countPendingApprovals(workspaceId: string): Promise<PendingApprovalCounts> {
  const [content, campaign, activation, recommendation] = await Promise.all([
    prisma.studioDraft.count({ where: where.content(workspaceId) }),
    prisma.campaign.count({ where: where.campaign(workspaceId) }),
    prisma.campaign.count({ where: where.activation(workspaceId) }),
    prisma.recommendation.count({ where: where.recommendation(workspaceId) }),
  ]);
  return {
    total: content + campaign + activation + recommendation,
    byKind: { CONTENT: content, CAMPAIGN: campaign, ACTIVATION: activation, RECOMMENDATION: recommendation },
  };
}

function riskText(risk: unknown): string | null {
  if (risk !== "LOW" && risk !== "MEDIUM" && risk !== "HIGH") return null;
  return `İçerik kontrolü: ${policyRiskStyle(risk).label.toLocaleLowerCase("tr-TR")}`;
}

function joinDetail(parts: Array<string | null>): string | null {
  const present = parts.filter((p): p is string => Boolean(p));
  return present.length ? present.join(" · ") : null;
}

interface AuditHit {
  action: string;
  userId: string | null;
  createdAt: Date;
}

/** Tek denetim kaydı sorgusu; anahtar `tür:kimlik`, değer en yeni kayıt (sorgu yeniden eskiye sıralı). */
async function latestAudits(
  workspaceId: string,
  refs: { draftIds: string[]; reviewCampaignIds: string[]; pausedCampaignIds: string[]; recIds: string[]; experimentIds: string[] },
) {
  const branches: Prisma.AuditLogWhereInput[] = [];
  if (refs.draftIds.length)
    branches.push({ entityType: "STUDIO_DRAFT", action: "DRAFT_SUBMIT", entityId: { in: refs.draftIds } });
  if (refs.reviewCampaignIds.length)
    branches.push({ entityType: "CAMPAIGN", action: "CAMPAIGN_SUBMITTED", entityId: { in: refs.reviewCampaignIds } });
  if (refs.pausedCampaignIds.length)
    branches.push({
      entityType: "CAMPAIGN",
      action: { in: ["CAMPAIGN_PUBLISHED", "CAMPAIGN_PAUSED"] },
      entityId: { in: refs.pausedCampaignIds },
    });
  if (refs.recIds.length)
    branches.push({ entityType: "RECOMMENDATION", action: "RECOMMENDATION_UPDATED", entityId: { in: refs.recIds } });
  if (refs.experimentIds.length)
    branches.push({
      entityType: "STUDIO_EXPERIMENT",
      action: "RECOMMENDATIONS_GENERATED",
      entityId: { in: refs.experimentIds },
    });
  const byEntity = new Map<string, AuditHit>();
  /** Taslaktan onaya gönderilen öneri (RECOMMENDATION_UPDATED, after.status = PENDING). */
  const recSubmitted = new Map<string, AuditHit>();
  /** Öneriyi üreten kullanıcı (RECOMMENDATIONS_GENERATED, after.recommendations[].id). */
  const recGenerated = new Map<string, AuditHit>();
  if (!branches.length) return { byEntity, recSubmitted, recGenerated };

  const logs = await prisma.auditLog.findMany({
    where: { workspaceId, OR: branches },
    orderBy: { createdAt: "desc" },
    select: { action: true, entityType: true, entityId: true, userId: true, after: true, createdAt: true },
  });
  for (const log of logs) {
    if (!log.entityId) continue;
    const hit: AuditHit = { action: log.action, userId: log.userId, createdAt: log.createdAt };
    const after = (log.after ?? {}) as { status?: unknown; recommendations?: unknown };
    if (log.action === "RECOMMENDATION_UPDATED") {
      if (after.status === "PENDING" && !recSubmitted.has(log.entityId)) recSubmitted.set(log.entityId, hit);
      continue;
    }
    if (log.action === "RECOMMENDATIONS_GENERATED") {
      const generated = Array.isArray(after.recommendations) ? after.recommendations : [];
      for (const rec of generated) {
        const id = (rec as { id?: unknown } | null)?.id;
        if (typeof id === "string" && !recGenerated.has(id)) recGenerated.set(id, hit);
      }
      continue;
    }
    const key = `${log.entityType}:${log.entityId}`;
    if (!byEntity.has(key)) byEntity.set(key, hit);
  }
  return { byEntity, recSubmitted, recGenerated };
}

async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
  return new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));
}

const byWaiting = (a: PendingApprovalItem, b: PendingApprovalItem) => a.waitingSince.getTime() - b.waitingSince.getTime();

/**
 * Kişiye göre süzülecek listelerde (reklam uzmanı: "kendi gönderdiklerim") süzgeç sınırdan ÖNCE uygulanabilsin diye
 * taranan kayıt sayısı; başkalarının 50+ işi kişinin işlerini listeden düşürmez.
 */
export const SCOPED_SCAN_LIMIT = 500;

/** Rolün Onaylar görünümü kişiye göre süzülüyorsa geniş tarama sınırı. */
export function approvalScanLimit(role: string): number | undefined {
  return role === "OWNER" || role === "ADMIN" ? undefined : SCOPED_SCAN_LIMIT;
}

/**
 * Onay bekleyen işlerin listesi (Onaylar sayfası). Sayılar her zaman kesindir; liste her türde
 * en çok `limit` kayıt içerir (varsayılan 50; kişiye göre süzülecekse `approvalScanLimit`).
 */
export async function listPendingApprovals(
  workspaceId: string,
  options: { limit?: number } = {},
): Promise<PendingApprovals> {
  const take = options.limit ?? 50;
  const campaignSelect = {
    id: true,
    name: true,
    dailyBudget: true,
    policyRisk: true,
    workflowStatus: true,
    createdAt: true,
    updatedAt: true,
    adAccount: { select: { currency: true } },
  } as const;
  const [counts, drafts, reviewCampaigns, pausedCampaigns, recommendations] = await Promise.all([
    countPendingApprovals(workspaceId),
    prisma.studioDraft.findMany({
      where: where.content(workspaceId),
      orderBy: { updatedAt: "asc" },
      take,
      select: { id: true, name: true, policy: true, version: true, createdAt: true, updatedAt: true },
    }),
    prisma.campaign.findMany({ where: where.campaign(workspaceId), orderBy: { updatedAt: "asc" }, take, select: campaignSelect }),
    prisma.campaign.findMany({ where: where.activation(workspaceId), orderBy: { updatedAt: "asc" }, take, select: campaignSelect }),
    prisma.recommendation.findMany({
      where: where.recommendation(workspaceId),
      orderBy: { createdAt: "asc" },
      take,
      select: {
        id: true,
        type: true,
        action: true,
        title: true,
        priority: true,
        experimentId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const audits = await latestAudits(workspaceId, {
    draftIds: drafts.map((d) => d.id),
    reviewCampaignIds: reviewCampaigns.map((c) => c.id),
    pausedCampaignIds: pausedCampaigns.map((c) => c.id),
    recIds: recommendations.map((r) => r.id),
    experimentIds: [...new Set(recommendations.map((r) => r.experimentId))],
  });
  const names = await userNames([
    ...[...audits.byEntity.values()].map((a) => a.userId),
    ...[...audits.recSubmitted.values()].map((a) => a.userId),
    ...[...audits.recGenerated.values()].map((a) => a.userId),
  ]);
  const nameOf = (hit: AuditHit | undefined) => (hit?.userId ? (names.get(hit.userId) ?? null) : null);

  const content = drafts.map((d): PendingApprovalItem => {
    const hit = audits.byEntity.get(`STUDIO_DRAFT:${d.id}`);
    return {
      kind: "CONTENT",
      id: d.id,
      title: d.name,
      detail: riskText((d.policy as { risk?: unknown } | null)?.risk),
      submittedBy: nameOf(hit),
      submittedByLabel: "Gönderen",
      waitingSince: hit?.createdAt ?? d.updatedAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      actors: APPROVER_LABEL,
      href: studioDraftHref(d.id),
      submittedById: hit?.userId ?? null,
      version: d.version,
    };
  });

  const campaign = reviewCampaigns.map((c): PendingApprovalItem => {
    const hit = audits.byEntity.get(`CAMPAIGN:${c.id}`);
    const currency = c.adAccount?.currency || "EUR";
    return {
      kind: "CAMPAIGN",
      id: c.id,
      title: c.name,
      detail: joinDetail([
        c.dailyBudget != null ? `Günlük bütçe: ${formatMoney(c.dailyBudget, currency)}` : null,
        riskText(c.policyRisk),
      ]),
      submittedBy: nameOf(hit),
      submittedByLabel: "Gönderen",
      waitingSince: hit?.createdAt ?? c.updatedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      actors: APPROVER_LABEL,
      href: campaignHref(c.id),
      submittedById: hit?.userId ?? null,
      dailyBudgetCents: c.dailyBudget,
      currency,
      workflowStatus: c.workflowStatus,
    };
  });

  const activation = pausedCampaigns.map((c): PendingApprovalItem => {
    const hit = audits.byEntity.get(`CAMPAIGN:${c.id}`);
    const currency = c.adAccount?.currency || "EUR";
    return {
      kind: "ACTIVATION",
      id: c.id,
      title: c.name,
      detail:
        c.dailyBudget != null
          ? `Etkinleştirilince günlük ${formatMoney(c.dailyBudget, currency)} harcama başlar.`
          : "Etkinleştirilince harcama başlar.",
      submittedBy: nameOf(hit),
      submittedByLabel: hit?.action === "CAMPAIGN_PAUSED" ? "Duraklatan" : "Meta'ya yükleyen",
      waitingSince: hit?.createdAt ?? c.updatedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      actors: SPEND_AUTHORITY_LABEL,
      href: campaignHref(c.id),
      submittedById: hit?.userId ?? null,
      dailyBudgetCents: c.dailyBudget,
      currency,
      workflowStatus: c.workflowStatus,
    };
  });

  const recommendation = recommendations.map((r): PendingApprovalItem => {
    const submitted = audits.recSubmitted.get(r.id);
    const generated = audits.recGenerated.get(r.id);
    const kind = recommendationKind(r);
    return {
      kind: "RECOMMENDATION",
      id: r.id,
      title: r.title,
      detail: joinDetail([RECOMMENDATION_KIND_LABEL[kind] ?? "Diğer öneri", priorityLabel(r.priority)]),
      submittedBy: nameOf(submitted ?? generated),
      submittedByLabel: submitted ? "Onaya gönderen" : "Oluşturan",
      waitingSince: submitted?.createdAt ?? r.createdAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      actors: APPROVER_LABEL,
      href: RECOMMENDATIONS_HREF,
      submittedById: (submitted ?? generated)?.userId ?? null,
    };
  });

  return {
    counts,
    items: {
      CONTENT: content.sort(byWaiting),
      CAMPAIGN: campaign.sort(byWaiting),
      ACTIVATION: activation.sort(byWaiting),
      RECOMMENDATION: recommendation.sort(byWaiting),
    },
  };
}

/**
 * Rol görünümü (ADR-0018): Hesap sahibi ve Yönetici tüm işleri görür. Reklam uzmanı onay veremez;
 * yalnızca kendi gönderdiği ya da Meta'ya yüklediği işleri izler (etkinleştirmeyi harcama yetkisi varsa
 * kendisi de yapabilir, bu yüzden tüm etkinleştirmeler ona da görünür).
 */
export function scopePendingApprovals(
  data: PendingApprovals,
  actor: { userId: string; role: string },
  options: { canApproveSpend: boolean },
): PendingApprovals {
  if (actor.role === "OWNER" || actor.role === "ADMIN") return data;
  const mine = (item: PendingApprovalItem) => item.submittedById === actor.userId;
  const items: PendingApprovals["items"] = {
    CONTENT: data.items.CONTENT.filter(mine),
    CAMPAIGN: data.items.CAMPAIGN.filter(mine),
    ACTIVATION: options.canApproveSpend ? data.items.ACTIVATION : data.items.ACTIVATION.filter(mine),
    RECOMMENDATION: [],
  };
  const byKind = {
    CONTENT: items.CONTENT.length,
    CAMPAIGN: items.CAMPAIGN.length,
    ACTIVATION: items.ACTIVATION.length,
    RECOMMENDATION: 0,
  };
  return { counts: { total: Object.values(byKind).reduce((a, b) => a + b, 0), byKind }, items };
}

/**
 * Düzeltme istenen işler: reddedilmiş içerik taslakları ve kampanyalar. `userId` verilirse yalnızca o kişinin
 * onaya gönderdikleri (Reklam uzmanının "düzeltme istenenler" listesi). Gerekçe denetim kaydından okunur.
 */
export async function listCorrectionRequests(
  workspaceId: string,
  options: { userId?: string; limit?: number } = {},
): Promise<CorrectionItem[]> {
  const take = options.limit ?? 20;
  // Kişiye göre süzülecekse süzgeç sınırdan önce uygulanır: geniş tara, sonra kes.
  const scan = options.userId ? SCOPED_SCAN_LIMIT : take;
  const [drafts, campaigns] = await Promise.all([
    prisma.studioDraft.findMany({
      where: { workspaceId, status: "REJECTED" },
      orderBy: { updatedAt: "desc" },
      take: scan,
      select: { id: true, name: true, updatedAt: true },
    }),
    prisma.campaign.findMany({
      where: { workspaceId, workflowStatus: "REJECTED" },
      orderBy: { updatedAt: "desc" },
      take: scan,
      select: { id: true, name: true, updatedAt: true, rejectionReason: true, rejectionBy: true },
    }),
  ]);
  const draftIds = drafts.map((d) => d.id);
  const campaignIds = campaigns.map((c) => c.id);
  const logs =
    draftIds.length || campaignIds.length
      ? await prisma.auditLog.findMany({
          where: {
            workspaceId,
            OR: [
              ...(draftIds.length
                ? [{ entityType: "STUDIO_DRAFT", action: { in: ["DRAFT_SUBMIT", "DRAFT_REJECT"] }, entityId: { in: draftIds } }]
                : []),
              ...(campaignIds.length
                ? [{ entityType: "CAMPAIGN", action: { in: ["CAMPAIGN_SUBMITTED", "CAMPAIGN_REJECTED"] }, entityId: { in: campaignIds } }]
                : []),
            ],
          },
          orderBy: { createdAt: "desc" },
          select: { action: true, entityId: true, userId: true, after: true, createdAt: true },
        })
      : [];
  const latest = new Map<string, (typeof logs)[number]>();
  for (const log of logs) {
    const key = `${log.action}:${log.entityId}`;
    if (!latest.has(key)) latest.set(key, log);
  }
  const names = await userNames([...logs.map((l) => l.userId), ...campaigns.map((c) => c.rejectionBy)]);
  const reasonOf = (after: unknown) => {
    const reason = (after as { reason?: unknown } | null)?.reason;
    return typeof reason === "string" && reason.trim() ? reason.trim() : null;
  };
  const items: Array<CorrectionItem & { submitterId: string | null }> = [
    ...drafts.map((d) => {
      const rejected = latest.get(`DRAFT_REJECT:${d.id}`);
      return {
        kind: "CONTENT" as const,
        id: d.id,
        title: d.name,
        reason: reasonOf(rejected?.after),
        rejectedBy: rejected?.userId ? (names.get(rejected.userId) ?? null) : null,
        rejectedAt: rejected?.createdAt ?? d.updatedAt,
        href: studioDraftHref(d.id),
        submitterId: latest.get(`DRAFT_SUBMIT:${d.id}`)?.userId ?? null,
      };
    }),
    ...campaigns.map((c) => ({
      kind: "CAMPAIGN" as const,
      id: c.id,
      title: c.name,
      reason: c.rejectionReason ?? reasonOf(latest.get(`CAMPAIGN_REJECTED:${c.id}`)?.after),
      rejectedBy: c.rejectionBy ? (names.get(c.rejectionBy) ?? null) : null,
      rejectedAt: latest.get(`CAMPAIGN_REJECTED:${c.id}`)?.createdAt ?? c.updatedAt,
      href: campaignHref(c.id),
      submitterId: latest.get(`CAMPAIGN_SUBMITTED:${c.id}`)?.userId ?? null,
    })),
  ];
  return items
    .filter((item) => !options.userId || item.submitterId === options.userId)
    .sort((a, b) => b.rejectedAt.getTime() - a.rejectedAt.getTime())
    .slice(0, take)
    .map(({ submitterId: _submitterId, ...item }) => item);
}
