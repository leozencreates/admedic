/**
 * Lead takımı (ADR-0029): 50 ajanlık hiyerarşinin panel tarafı — bağlamın veritabanından kurulması, çalıştırmanın
 * başlatılması, ajan raporlarının ve direktör önerilerinin kaydı.
 *
 * - Bağlam kişisel veri içermez: klinik profili, kampanya toplamları ve lead hunisinin SAYILARI gider.
 * - Ajanlar Meta'ya yazmaz ve harcama yapmaz. Direktörün önerileri `PENDING` kaydedilir; bir insan onaylar ya da
 *   reddeder. Onay hiçbir kampanyayı oluşturmaz ya da yayına almaz (ADR-0002).
 * Sunucu modülüdür (Prisma).
 */
import { getLlmConfig, loadEnv, LLM_NOT_CONFIGURED_MESSAGE, type LlmConfig } from "@admedic/config";
import { prisma, type Prisma } from "@admedic/database";
import {
  LEAD_TEAM_PROMPT_VERSION,
  TEAM_SIZE,
  runLeadTeam,
  simulateAgentReply,
  type AgentCall,
  type AgentReport,
  type LeadTeamContext,
} from "@admedic/lead-team";
import { anthropicMessages } from "@admedic/llm";
import type { Actor } from "./auth";
import { campaignMetrics } from "./campaign-metrics";
import { HttpError } from "./http";
import { LOST_REASONS } from "./labels";
import { withLlmLog } from "./llm-log";
import { errorSummary, logger } from "./log";
import { activeMonthlyCommitmentCents } from "./spend-cap";

/** Her çalıştırma 50 LLM çağrısıdır; çalışma alanı başına günlük sınır. */
export const DAILY_RUN_LIMIT = 3;
/** Bu süreden uzun süredir RUNNING kalan çalıştırma yarıda kalmış sayılır (sunucu yeniden başlamış olabilir). */
export const STALE_RUN_MS = 20 * 60_000;
const PERFORMANCE_DAYS = 30;

type Scope = Pick<Actor, "orgId" | "workspaceId">;

function countMap(rows: Array<{ key: string | null; count: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.key ?? "bilinmiyor"] = (out[row.key ?? "bilinmiyor"] ?? 0) + row.count;
  return out;
}

/**
 * Kayıp nedeni serbest metin not içerebilir ("Fiyat — eşi karşı çıktı"); ajanlara yalnızca hazır neden gider,
 * not ve "Diğer" metni gitmez.
 */
function lostReasonBucket(reason: string | null): string {
  const known = LOST_REASONS.find((r) => reason === r || reason?.startsWith(`${r} — `));
  return known ?? "Diğer";
}

export async function buildLeadTeamContext(scope: Scope): Promise<LeadTeamContext> {
  const since = new Date(Date.now() - PERFORMANCE_DAYS * 86_400_000);
  const [workspace, org, account, clinic, campaigns, totals, byStatus, byLanguage, byChannel, lost] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId }, select: { currency: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: scope.orgId }, select: { monthlyAdBudgetCap: true } }),
    prisma.adAccount.findFirst({
      where: { orgId: scope.orgId, workspaceId: scope.workspaceId, status: "ACTIVE" },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { currency: true },
    }),
    prisma.clinicProfile.findFirst({
      where: { workspaceId: scope.workspaceId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: {
        name: true, city: true, languages: true, targetMarket: true, accreditations: true, brandTone: true,
        brandBannedPhrases: true,
        services: {
          where: { status: "ACTIVE" },
          orderBy: { createdAt: "asc" },
          take: 20,
          select: { name: true, category: true, durationDays: true, packageIncludes: true },
        },
        marketTargets: { orderBy: { demand: "desc" }, take: 15, select: { country: true, language: true, demand: true } },
      },
    }),
    prisma.campaign.findMany({
      where: { workspaceId: scope.workspaceId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, name: true, status: true, dailyBudget: true },
    }),
    // Kampanya toplamları çift sayımsız (ADR-0020).
    campaignMetrics(scope.workspaceId, since),
    prisma.lead.groupBy({ by: ["status"], where: { workspaceId: scope.workspaceId }, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["language"], where: { workspaceId: scope.workspaceId }, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["channel"], where: { workspaceId: scope.workspaceId }, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["lostReason"], where: { workspaceId: scope.workspaceId, status: "LOST" }, _count: { _all: true } }),
  ]);
  const currency = account?.currency ?? workspace.currency;
  const committed = await activeMonthlyCommitmentCents(prisma, scope.orgId, currency);
  const lostCounts = countMap(lost.map((row) => ({ key: lostReasonBucket(row.lostReason), count: row._count._all })));
  return {
    currency,
    monthlyCap: org.monthlyAdBudgetCap == null ? null : org.monthlyAdBudgetCap / 100,
    monthlyCommitted: committed / 100,
    clinic: clinic
      ? {
          name: clinic.name,
          city: clinic.city,
          languages: clinic.languages,
          targetMarket: clinic.targetMarket,
          accreditations: clinic.accreditations,
          brandTone: clinic.brandTone?.slice(0, 500) ?? null,
          bannedPhrases: clinic.brandBannedPhrases.slice(0, 30),
          services: clinic.services,
          marketTargets: clinic.marketTargets,
        }
      : null,
    campaigns: campaigns.map((campaign) => {
      const sum = totals.get(campaign.id);
      return {
        name: campaign.name,
        status: campaign.status,
        dailyBudget: campaign.dailyBudget == null ? null : campaign.dailyBudget / 100,
        spend: (sum?.spend ?? 0) / 100,
        leads: sum?.leads ?? 0,
        clicks: sum?.clicks ?? 0,
      };
    }),
    leads: {
      byStatus: countMap(byStatus.map((row) => ({ key: row.status, count: row._count._all }))),
      // Anonimleştirilen lead'in dili "und" olur; ajanlara anlamlı değildir.
      byLanguage: countMap(byLanguage.filter((row) => row.language !== "und").map((row) => ({ key: row.language.toUpperCase(), count: row._count._all }))),
      byChannel: countMap(byChannel.map((row) => ({ key: row.channel, count: row._count._all }))),
      lostReasons: Object.entries(lostCounts)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

type RunMode = { simulated: true; llm: null } | { simulated: false; llm: LlmConfig };

/** Yapay zekâ ayarlıysa gerçek çağrı; ayarsızsa yalnızca deneme modunda deneme çıktısı, canlıda 503. */
function runMode(): RunMode {
  const llm = getLlmConfig();
  if (llm) return { simulated: false, llm };
  if (loadEnv().META_MOCK_MODE) return { simulated: true, llm: null };
  throw new HttpError(503, LLM_NOT_CONFIGURED_MESSAGE);
}

async function failStaleRuns(db: Prisma.TransactionClient, workspaceId: string, now: Date): Promise<void> {
  await db.leadTeamRun.updateMany({
    where: { workspaceId, status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } },
    data: { status: "FAILED", finishedAt: now, error: "Çalıştırma yarıda kaldı (sunucu yeniden başlamış olabilir). Yeniden çalıştırın." },
  });
}

/**
 * Çalıştırma kaydını açar. Aynı çalışma alanında süren çalıştırma varsa 409, günlük sınır aşıldıysa 429.
 * Ajanlar `executeLeadTeamRun` ile çalışır (yanıt gönderildikten sonra).
 */
export async function startLeadTeamRun(actor: Pick<Actor, "orgId" | "workspaceId" | "userId">, now: Date = new Date()): Promise<{ id: string; simulated: boolean }> {
  const mode = runMode();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.workspaceId}), hashtext('lead-team'))`;
    await failStaleRuns(tx, actor.workspaceId, now);
    if (await tx.leadTeamRun.findFirst({ where: { workspaceId: actor.workspaceId, status: "RUNNING" }, select: { id: true } }))
      throw new HttpError(409, "Lead takımı şu an çalışıyor. Bitmesini bekleyin.");
    const today = await tx.leadTeamRun.count({
      where: { workspaceId: actor.workspaceId, createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
    });
    if (today >= DAILY_RUN_LIMIT)
      throw new HttpError(429, `Lead takımı 24 saatte en fazla ${DAILY_RUN_LIMIT} kez çalıştırılabilir. Daha sonra tekrar deneyin.`);
    const run = await tx.leadTeamRun.create({
      data: {
        workspaceId: actor.workspaceId,
        organizationId: actor.orgId,
        requestedById: actor.userId,
        agentsTotal: TEAM_SIZE,
        simulated: mode.simulated,
        startedAt: now,
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        orgId: actor.orgId,
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        action: "LEAD_TEAM_RUN_STARTED",
        entityType: "LEAD_TEAM_RUN",
        entityId: run.id,
        after: { agents: TEAM_SIZE, simulated: mode.simulated },
      },
    });
    return { id: run.id, simulated: mode.simulated };
  });
}

export interface ExecuteOptions {
  /** Test: LLM taşıyıcısı. */
  transport?: typeof fetch;
}

/** Açılmış çalıştırmayı yürütür: 50 ajan çalışır, raporlar ve direktörün önerileri kaydedilir. Hata fırlatmaz. */
export async function executeLeadTeamRun(runId: string, options: ExecuteOptions = {}): Promise<void> {
  const run = await prisma.leadTeamRun.findUnique({
    where: { id: runId },
    select: { id: true, workspaceId: true, organizationId: true, status: true, simulated: true },
  });
  if (!run || run.status !== "RUNNING") return;
  try {
    const llm = run.simulated ? null : getLlmConfig();
    if (!run.simulated && !llm) throw new HttpError(503, LLM_NOT_CONFIGURED_MESSAGE);
    const context = await buildLeadTeamContext({ orgId: run.organizationId, workspaceId: run.workspaceId });
    const call = async (agentCall: AgentCall) => {
      if (!llm) return { text: simulateAgentReply(agentCall), usage: { inputTokens: 0, outputTokens: 0 } };
      return withLlmLog({
        workspaceId: run.workspaceId,
        agent: `lead-team:${agentCall.agent.key}`,
        promptVersion: LEAD_TEAM_PROMPT_VERSION,
        model: llm.model,
        run: () =>
          anthropicMessages({
            ...llm,
            system: agentCall.system,
            messages: [{ role: "user", content: agentCall.user }],
            maxTokens: agentCall.maxTokens,
            timeoutMs: 90_000,
            transport: options.transport,
          }),
      });
    };
    const onReport = async (report: AgentReport) => {
      await prisma.$transaction([
        prisma.leadTeamReport.create({
          data: {
            runId: run.id,
            agentKey: report.agent.key,
            role: report.agent.role,
            team: report.agent.team,
            status: report.status,
            ...(report.output ? { output: report.output as Prisma.InputJsonObject } : {}),
          },
        }),
        prisma.leadTeamRun.update({
          where: { id: run.id },
          data: {
            ...(report.status === "COMPLETED" ? { agentsCompleted: { increment: 1 } } : { agentsFailed: { increment: 1 } }),
            inputTokens: { increment: report.usage.inputTokens },
            outputTokens: { increment: report.usage.outputTokens },
          },
        }),
      ]);
    };
    const result = await runLeadTeam(context, { call, onReport });
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.leadTeamRun.update({
        where: { id: run.id },
        data: { status: result.status, summary: result.decision?.decision ?? null, error: result.error, finishedAt: now },
      });
      if (result.decision)
        await tx.leadTeamProposal.createMany({
          data: result.decision.proposals.map((proposal, index) => ({
            runId: run.id,
            workspaceId: run.workspaceId,
            rank: index + 1,
            title: proposal.title,
            market: proposal.market,
            language: proposal.language,
            service: proposal.service,
            angle: proposal.angle,
            dailyBudgetCents: proposal.dailyBudget == null ? null : Math.round(proposal.dailyBudget * 100),
            currency: context.currency,
            priority: proposal.priority,
            rationale: proposal.rationale,
          })),
        });
      await tx.auditLog.create({
        data: {
          orgId: run.organizationId,
          workspaceId: run.workspaceId,
          userId: null,
          action: result.status === "COMPLETED" ? "LEAD_TEAM_RUN_COMPLETED" : "LEAD_TEAM_RUN_FAILED",
          entityType: "LEAD_TEAM_RUN",
          entityId: run.id,
          after: { proposals: result.decision?.proposals.length ?? 0, by: "director" },
        },
      });
    });
  } catch (error) {
    logger.error({ runId, err: errorSummary(error) }, "lead takımı çalıştırması tamamlanamadı");
    await prisma.leadTeamRun
      .updateMany({
        where: { id: runId, status: "RUNNING" },
        data: { status: "FAILED", finishedAt: new Date(), error: error instanceof HttpError ? error.message : "Çalıştırma tamamlanamadı. Biraz sonra yeniden deneyin." },
      })
      .catch(() => undefined);
  }
}

/** Panel görünümü: son çalıştırmalar, en son çalıştırmanın raporları ve önerileri. */
export async function leadTeamOverview(scope: Scope, now: Date = new Date()) {
  await failStaleRuns(prisma, scope.workspaceId, now);
  const runs = await prisma.leadTeamRun.findMany({
    where: { workspaceId: scope.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true, status: true, simulated: true, agentsTotal: true, agentsCompleted: true, agentsFailed: true,
      summary: true, error: true, inputTokens: true, outputTokens: true, startedAt: true, finishedAt: true,
    },
  });
  const latest = runs[0] ?? null;
  const [reports, proposals] = latest
    ? await Promise.all([
        prisma.leadTeamReport.findMany({
          where: { runId: latest.id },
          orderBy: { createdAt: "asc" },
          select: { agentKey: true, role: true, team: true, status: true, output: true },
        }),
        prisma.leadTeamProposal.findMany({ where: { runId: latest.id, workspaceId: scope.workspaceId }, orderBy: { rank: "asc" } }),
      ])
    : [[], []];
  return { runs, latest, reports, proposals };
}
