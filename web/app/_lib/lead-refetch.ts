import { prisma, Prisma } from "@admedic/database";
import { leadLookupHash } from "./lead-hash";
import { recordInstantFormConsent } from "./lead-consent";
import {
  fetchLeadgenForToken,
  leadProfileFromLeadgen,
  lockLeadIdentity,
  safeEncrypt,
  sendLeadAdGreeting,
  GUEST_NAME,
  type LeadgenFetchResult,
  type TenantContext,
} from "./webhook-ingest";

/**
 * Alanları çekilemeyen Lead Ads lead'lerinin (`metadata.pendingFetch`) yeniden denenmesi (ADR-0015).
 * Webhook anında sayfa token'ı yoksa/geçersizse ya da izin eksikse lead kimlikle (stub) kaydedilir; bu modül
 * token düzeldiğinde alanları Graph'tan yeniden çeker, lead'i tamamlar, rıza kaydını yazar ve telefonu gelen
 * lead için karşılamayı başlatır.
 *
 * Tetikleyiciler: yeni Meta bağlantısı / sayfa senkronu (OAuth dönüşü), aynı kuruluşa sorunsuz çekilen yeni
 * lead webhook'u (yanıttan sonra) ve paneldeki "Meta'dan yeniden çek" (`POST /api/leads/refetch`).
 */

/** Aynı lead için otomatik denemeler arasındaki en kısa süre (elle deneme bunu atlar). */
export const REFETCH_BACKOFF_MS = 10 * 60_000;
/** Bu süreden eski lead yeniden denenmez (Meta lead saklama süresi ~90 gün; DOĞRULANMADI — meta-constraints). */
export const REFETCH_MAX_AGE_DAYS = 90;
const DEFAULT_LIMIT = 25;

export interface RefetchInput {
  orgId: string;
  /** Panelden: yalnızca kullanıcının çalışma alanı. */
  workspaceId?: string;
  /** Yalnızca bu lead'ler (elle tek lead). */
  leadIds?: string[];
  limit?: number;
  /** Geri çekilme süresini yok say (elle deneme). */
  force?: boolean;
  /** Toplam süre bütçesi (ms); dolunca kalan lead'ler sonraki tetiğe kalır. */
  budgetMs?: number;
  /** Denetim kaydı için kullanıcı (otomatik tetikte null). */
  userId?: string | null;
}

export interface RefetchSummary {
  attempted: number;
  recovered: number;
  failed: number;
  skipped: number;
  /** Kapsamdaki, hâlâ bekleyen lead sayısı (çalışma sonrası). */
  remaining: number;
  results: Array<{ leadId: string; status: "RECOVERED" | "FAILED" | "SKIPPED"; message?: string }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function json(value: Record<string, unknown>): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

function pendingWhere(orgId: string, leadIds?: string[], workspaceId?: string): Prisma.LeadWhereInput {
  return {
    organizationId: orgId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(leadIds ? { id: { in: leadIds } } : {}),
    channel: "LEAD_AD",
    leadgenId: { not: null },
    createdAt: { gte: new Date(Date.now() - REFETCH_MAX_AGE_DAYS * 86_400_000) },
    metadata: { path: ["pendingFetch"], equals: true },
  };
}

/** Bekleyen (alanları çekilemeyen) Lead Ads lead sayısı. */
export async function countPendingLeadFetches(orgId: string, workspaceId?: string): Promise<number> {
  return prisma.lead.count({ where: pendingWhere(orgId, undefined, workspaceId) });
}

/** Lead'in geldiği sayfanın bağlantısı (webhook tenant çözümüyle aynı öncelik: OAuth PAGE kaydı). */
async function pageConnection(orgId: string, pageId: string | null) {
  if (!pageId) return null;
  const rows = await prisma.metaConnection.findMany({
    where: { orgId, pageId, status: { in: ["CONNECTED", "DEGRADED"] }, tokenCiphertext: { not: null } },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    select: { id: true, type: true, tokenCiphertext: true },
    take: 5,
  });
  return rows.find((r) => r.type === "PAGE") ?? rows[0] ?? null;
}

async function recordFailure(leadId: string, metadata: Record<string, unknown>, message: string): Promise<void> {
  const attempts = typeof metadata.fetchAttempts === "number" ? metadata.fetchAttempts : 1;
  await prisma.lead.updateMany({
    // Aynı anda başka bir deneme lead'i tamamladıysa üzerine yazılmaz.
    where: { id: leadId, metadata: { path: ["pendingFetch"], equals: true } },
    data: {
      metadata: json({
        ...metadata,
        pendingFetch: true,
        fetchError: message.slice(0, 300),
        fetchAttempts: attempts + 1,
        lastFetchAttemptAt: new Date().toISOString(),
      }),
    },
  });
}

type PendingLead = Prisma.LeadGetPayload<{
  select: { id: true; workspaceId: true; organizationId: true; leadgenId: true; language: true; metadata: true; campaignId: true; adSetId: true; adId: true };
}>;

/** Çekilen veriyi lead'e uygular; lead artık bekleyen değilse (eşzamanlı deneme) false döner. */
async function applyRecovered(
  lead: PendingLead,
  fetched: LeadgenFetchResult & { data: NonNullable<LeadgenFetchResult["data"]> },
  userId: string | null,
): Promise<{ applied: boolean; conversationId: string | null; phone: string | null; language: string }> {
  const data = fetched.data;
  const profile = leadProfileFromLeadgen(data.normalized, lead.language);
  const hash = leadLookupHash({ orgId: lead.organizationId, phone: profile.phone, email: profile.email });
  const outcome = await prisma.$transaction(async (tx) => {
    if (hash) await lockLeadIdentity(tx, lead.organizationId, hash);
    // Aynı lead'in eşzamanlı denemeleri (webhook sonrası, OAuth dönüşü, panel) satır kilidiyle sıralanır:
    // ikincisi lead'i artık bekleyen görmez ve hiçbir şey yazmaz.
    await tx.$executeRaw`SELECT id FROM "Lead" WHERE id = ${lead.id} FOR UPDATE`;
    const current = await tx.lead.findUnique({ where: { id: lead.id }, select: { metadata: true } });
    const metadata = asRecord(current?.metadata);
    if (metadata.pendingFetch !== true) return null;
    const primary = hash
      ? await tx.lead.findFirst({
          where: { organizationId: lead.organizationId, lookupHash: hash, id: { not: lead.id } },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
      : null;
    const rest: Record<string, unknown> = { ...metadata };
    delete rest.pendingFetch;
    delete rest.fetchError;
    const formId = data.formId ?? (typeof metadata.form_id === "string" ? metadata.form_id : null);
    const createdTime = data.createdTime ?? (typeof metadata.created_time === "string" ? metadata.created_time : null);
    await tx.lead.update({
      where: { id: lead.id },
      data: {
        firstName: profile.first || GUEST_NAME,
        lastName: profile.last,
        email: safeEncrypt(profile.email),
        phone: safeEncrypt(profile.phone),
        country: profile.country,
        language: profile.language,
        interestedService: profile.interestedService,
        campaignId: lead.campaignId ?? data.campaignId,
        adSetId: lead.adSetId ?? data.adsetId,
        adId: lead.adId ?? data.adId,
        lookupHash: primary ? null : hash,
        duplicateOf: primary?.id ?? null,
        metadata: json({
          ...rest,
          form_id: formId,
          ad_id: lead.adId ?? data.adId,
          adset_id: lead.adSetId ?? data.adsetId,
          campaign_id: lead.campaignId ?? data.campaignId,
          created_time: createdTime,
          platform: data.platform,
          is_organic: data.isOrganic,
          city: profile.city,
          answers: profile.answers,
          disclaimer_responses: data.disclaimerResponses,
          data_source: fetched.dataSource,
          fetchRecoveredAt: new Date().toISOString(),
        }),
      },
    });
    const consent = await recordInstantFormConsent(tx, {
      orgId: lead.organizationId,
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      leadgenId: lead.leadgenId!,
      formId,
      responses: data.disclaimerResponses,
      submittedAt: createdTime,
    });
    let conversationId: string | null = null;
    if (profile.phone) {
      const existing = await tx.conversation.findFirst({
        where: { leadId: lead.id, channel: "WHATSAPP" },
        select: { id: true },
      });
      conversationId =
        existing?.id ??
        (
          await tx.conversation.create({
            data: { leadId: lead.id, workspaceId: lead.workspaceId, channel: "WHATSAPP", status: "ACTIVE", initiatedBy: "bot" },
            select: { id: true },
          })
        ).id;
    }
    await tx.auditLog.create({
      data: {
        orgId: lead.organizationId,
        workspaceId: lead.workspaceId,
        userId,
        action: "LEAD_FETCH_RECOVERED",
        entityType: "LEAD",
        entityId: lead.id,
        after: json({
          leadgen_id: lead.leadgenId,
          data_source: fetched.dataSource,
          duplicateOf: primary?.id ?? null,
          consent: { status: consent.status, reason: consent.reason, basis: consent.basis ?? null },
        }),
      },
    });
    return { conversationId };
  });
  if (!outcome) return { applied: false, conversationId: null, phone: null, language: profile.language };
  return { applied: true, conversationId: outcome.conversationId, phone: profile.phone, language: profile.language };
}

export async function refetchPendingLeads(input: RefetchInput): Promise<RefetchSummary> {
  const deadline = Date.now() + (input.budgetMs ?? 20_000);
  const summary: RefetchSummary = { attempted: 0, recovered: 0, failed: 0, skipped: 0, remaining: 0, results: [] };
  const leads = await prisma.lead.findMany({
    where: pendingWhere(input.orgId, input.leadIds, input.workspaceId),
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100),
    select: {
      id: true,
      workspaceId: true,
      organizationId: true,
      leadgenId: true,
      language: true,
      metadata: true,
      campaignId: true,
      adSetId: true,
      adId: true,
    },
  });
  for (const lead of leads) {
    const metadata = asRecord(lead.metadata);
    const last = typeof metadata.lastFetchAttemptAt === "string" ? Date.parse(metadata.lastFetchAttemptAt) : NaN;
    if (
      Date.now() >= deadline ||
      (!input.force && Number.isFinite(last) && Date.now() - last < REFETCH_BACKOFF_MS)
    ) {
      summary.skipped++;
      summary.results.push({ leadId: lead.id, status: "SKIPPED" });
      continue;
    }
    summary.attempted++;
    const pageId = typeof metadata.page_id === "string" ? metadata.page_id : null;
    const connection = await pageConnection(lead.organizationId, pageId);
    let fetched: LeadgenFetchResult;
    try {
      fetched = await fetchLeadgenForToken(connection?.tokenCiphertext ?? null, lead.leadgenId!, {
        formId: typeof metadata.form_id === "string" ? metadata.form_id : null,
      });
    } catch (error) {
      fetched = {
        data: null,
        dataSource: "graph",
        fetchError: `Geçici Meta hatası: ${error instanceof Error ? error.message.slice(0, 200) : "bilinmeyen"}`,
      };
    }
    if (!fetched.data) {
      const message = fetched.fetchError ?? "Lead alanları çekilemedi.";
      await recordFailure(lead.id, metadata, message);
      summary.failed++;
      summary.results.push({ leadId: lead.id, status: "FAILED", message });
      continue;
    }
    const applied = await applyRecovered(lead, { ...fetched, data: fetched.data }, input.userId ?? null);
    if (!applied.applied) {
      summary.skipped++;
      summary.results.push({ leadId: lead.id, status: "SKIPPED" });
      continue;
    }
    summary.recovered++;
    summary.results.push({ leadId: lead.id, status: "RECOVERED" });
    if (applied.conversationId && applied.phone) {
      const tenant: TenantContext = {
        connectionId: connection?.id ?? "",
        orgId: lead.organizationId,
        workspaceId: lead.workspaceId,
        tokenCiphertext: connection?.tokenCiphertext ?? null,
        sourceId: pageId ?? "",
      };
      try {
        await sendLeadAdGreeting({
          tenant,
          leadId: lead.id,
          conversationId: applied.conversationId,
          channel: "WHATSAPP",
          language: applied.language,
          phone: applied.phone,
          psid: null,
        });
      } catch (error) {
        console.warn(`[lead-refetch] karşılama gönderilemedi (lead ${lead.id}): ${error instanceof Error ? error.message.slice(0, 120) : "?"}`);
      }
    }
  }
  summary.remaining = await prisma.lead.count({ where: pendingWhere(input.orgId, input.leadIds, input.workspaceId) });
  return summary;
}
