import { randomBytes, createDecipheriv, scryptSync } from "node:crypto";
import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { createMetaClient, type MetaClientLike } from "@admedic/meta-api";
import type { Alert } from "@admedic/database";
import { AlertSeverity, AlertType } from "@admedic/database";
import {
  buildWeeklyReport,
  isReportDay,
  reportPeriod,
  renderReportPdf,
  sendWeeklyReportEmail,
} from "@admedic/reporting";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
function getKey(): Buffer {
  const env = loadEnv();
  if (env.ENCRYPTION_KEY && env.ENCRYPTION_KEY.length === 64)
    return Buffer.from(env.ENCRYPTION_KEY, "hex");
  return scryptSync(`admedic-enc:${env.AUTH_SECRET}`, "admedic-salt", 32);
}
function decryptToken(ciphertext: string): string {
  const key = getKey();
  const buffer = Buffer.from(ciphertext, "base64");
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = buffer.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export interface ScheduledJob {
  run(): Promise<{
    insightsSynced: number;
    alertsCreated: number;
    completed: number;
    emailsSent: number;
  }>;
}
export function createMetaSyncScheduler(
  client?: MetaClientLike,
): ScheduledJob {
  const meta = client ?? createMetaClient();
  return { async run() { return runScheduled(meta); } };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function start(intervalMs = 5 * 60 * 1000): void {
  stop();
  runScheduled(createMetaClient()).catch(() => {});
  timer = setInterval(() => runScheduled(createMetaClient()).catch(() => {}), intervalMs);
}
export function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
export async function runOnce(): Promise<{
  insightsSynced: number;
  alertsCreated: number;
  completed: number;
  emailsSent: number;
}> {
  return runScheduled(createMetaClient());
}

async function runScheduled(meta: MetaClientLike) {
  loadEnv();
  const workspaceIds = (await prisma.workspace.findMany({ select: { id: true } })).map((w) => w.id);
  let insightsSynced = 0;
  let alertsCreated = 0;
  let completed = 0;
  let emailsSent = 0;
  for (const wsId of workspaceIds) {
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: wsId },
      include: { adAccounts: { include: { connection: true } } },
    });
    const org = await prisma.organization.findUnique({
      where: { id: workspace.orgId },
      select: { id: true, retentionDays: true },
    });
    insightsSynced += await syncInsights(meta, workspace);
    alertsCreated += await checkConnectionHealth(workspace);
    alertsCreated += await runAnonRetention(org ?? { id: workspace.orgId, retentionDays: 0 }, workspace.id);
    emailsSent += await deliverWeeklyReport(workspace.id);
    const experiments = await prisma.studioExperiment.findMany({
      where: { draft: { workspaceId: wsId }, status: "RUNNING" },
      include: { draft: { include: { workspace: { include: { adAccounts: true } } } } },
    });
    for (const experiment of experiments) {
      const result = await syncExperiment(meta, experiment);
      alertsCreated += result.alerts.length;
      completed += result.completed ? 1 : 0;
    }
  }
  return { insightsSynced, alertsCreated, completed, emailsSent };
}

async function deliverWeeklyReport(workspaceId: string): Promise<number> {
  const env = loadEnv();
  const reportDay = env.WEEKLY_REPORT_DAY;
  if (!isReportDay(new Date(), reportDay)) return 0;
  if (!env.RESEND_API_KEY || !env.WEEKLY_REPORT_RECIPIENT) return 0;
  const { start } = reportPeriod(new Date(), reportDay);
  const sent = await prisma.reportDelivery.findUnique({
    where: { workspaceId_periodStart: { workspaceId, periodStart: start } },
    select: { id: true },
  });
  if (sent) return 0;
  try {
    const report = await buildWeeklyReport(workspaceId, new Date(), reportDay);
    const pdf = await renderReportPdf(report);
    const result = await sendWeeklyReportEmail(report, pdf);
    await prisma.reportDelivery.create({
      data: {
        workspaceId,
        periodStart: start,
        recipient: env.WEEKLY_REPORT_RECIPIENT,
        error: result.error ?? null,
      },
    });
    return result.error ? 0 : 1;
  } catch (err) {
    console.warn(`[reporting] ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function runAnonRetention(org: { id: string; retentionDays: number | null }, workspaceId: string): Promise<number> {
  const env = loadEnv();
  if (!org || !org.retentionDays || org.retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - org.retentionDays * 24 * 3600 * 1000);
  const stale = await prisma.lead.findMany({
    where: {
      organizationId: org.id,
      updatedAt: { lt: cutoff },
      OR: [{ status: "LOST" }, { status: "TREATED" }, { status: "CONSULTATION_BOOKED" }],
    },
    select: { id: true },
  });
  let anonymized = 0;
  for (const lead of stale) {
    await prisma.$transaction([
      prisma.message.updateMany({
        where: { conversation: { leadId: lead.id, workspaceId } },
        data: { content: "[anonymized]", sender: null, metadata: {} },
      }),
      prisma.conversation.updateMany({
        where: { leadId: lead.id, workspaceId },
        data: { status: "CLOSED", closedAt: new Date(), initiatedBy: null, escalatedTo: null },
      }),
      prisma.consentRecord.updateMany({
        where: { leadId: lead.id, workspaceId },
        data: { status: "WITHDRAWN", withdrawnAt: new Date(), consentText: "[anonymized]", ip: null, userAgent: null },
      }),
      prisma.lead.update({
        where: { id: lead.id },
        data: { firstName: "[anonymized]", lastName: "[anonymized]", email: null, phone: null, country: null, lostReason: null, duplicateOf: null, metadata: {} },
      }),
    ]);
    anonymized++;
  }
  return anonymized;
}

async function checkConnectionHealth(workspace: any): Promise<number> {
  let alerts = 0;
  const accounts = workspace.adAccounts?.filter((a: any) => a.connectionId) ?? [];
  for (const account of accounts) {
    const conn = account.connection;
    if (!conn) continue;
    if (conn.status === "EXPIRED" || conn.status === "REVOKED" || conn.status === "REJECTED") {
      const env = loadEnv();
      const existing = await prisma.alert.findFirst({
        where: { workspaceId: workspace.id, type: AlertType.META_DISCONNECTED, entityId: conn.id, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
      });
      if (!existing) {
        await prisma.alert.create({
          data: {
            workspaceId: workspace.id,
            type: AlertType.META_DISCONNECTED,
            severity: AlertSeverity.CRITICAL,
            title: `Meta bağlantısı ${conn.status}: ${account.id}`,
            message: `Ad account ${account.id} bağlantısı ${conn.status} durumunda. Kampanya işlemleri durduruldu.`,
            entityType: "META_CONNECTION",
            entityId: conn.id,
          },
        });
        alerts++;
      }
    }
  }
  return alerts;
}

async function syncInsights(meta: MetaClientLike, workspace: any): Promise<number> {
  let synced = 0;
  const accounts = workspace.adAccounts?.filter((a: any) => a.connectionId) ?? [];
  for (const account of accounts) {
    const token = decryptToken(account.connection.tokenCiphertext);
    const campaigns = await meta.listCampaigns(account.id, token).catch(() => []);
    for (const camp of campaigns) {
      const rows = await meta
        .getInsights({ type: "campaign", id: camp.id }, token, { datePreset: "last_7d", level: "campaign" })
        .catch(() => []);
      for (const row of rows) {
        const date = new Date(String(row.dateStart ?? new Date().toISOString()).slice(0, 10));
        const existing = await prisma.insightSnapshot.findFirst({
          where: { workspaceId: workspace.id, adAccountId: account.id, campaignId: camp.id, date },
        });
        const data = {
          workspaceId: workspace.id,
          adAccountId: account.id,
          campaignId: camp.id,
          date,
          granularity: "DAILY" as const,
          source: "META",
          spend: row.spendMajor ?? 0,
          impressions: row.impressions ?? 0,
          reach: row.reach ?? 0,
          clicks: row.clicks ?? 0,
          linkClicks: row.linkClicks ?? 0,
          outboundClicks: (row as any).outboundClicks ?? 0,
          landingPageViews: (row as any).landingPageViews ?? 0,
          addsToCart: (row as any).addsToCart ?? 0,
          initiatesCheckout: (row as any).initiatesCheckout ?? 0,
          purchases: row.purchases ?? 0,
          conversionValue: row.purchaseValueMajor ?? 0,
          frequency: row.frequency,
          ctr: row.ctr,
          cpc: row.cpc,
          cpm: row.cpm,
          capturedAt: new Date(),
        };
        if (existing) {
          await prisma.insightSnapshot.update({ where: { id: existing.id }, data });
        } else {
          await prisma.insightSnapshot.create({ data });
        }
        synced++;
      }
    }
  }
  return synced;
}

export async function syncExperiment(
  meta: MetaClientLike,
  experiment: any,
): Promise<{
  variantMetrics: Array<{ variantId: string; pointsCreated: number }>;
  alerts: Alert[];
  completed: boolean;
}> {
  const draft = experiment.draft;
  const workspace = draft.workspace;
  const adAccount =
    workspace.adAccounts?.find((a: any) => a.isDefault) ??
    workspace.adAccounts?.[0];
  if (!adAccount)
    throw new Error(`No ad account for workspace ${workspace.id}`);
  const token = decryptToken(adAccount.connection.tokenCiphertext);
  const snapshot = JSON.parse(experiment.snapshot as string) as {
    variants: Array<{ id: string }>;
    duration: number;
  };
  const variants = snapshot.variants ?? [];
  const variantMetrics: Array<{ variantId: string; pointsCreated: number }> = [];
  const alerts: Alert[] = [];

  for (let i = 0; i < variants.length; i++) {
    const adSets = await meta
      .listAdSets(adAccount.id, token)
      .catch(() => []);
    let totalSpend = 0;
    let totalClicks = 0;
    let totalImpressions = 0;
    let totalLeads = 0;
    let totalPoints = 0;

    for (const adSet of adSets) {
      let rows: any[] = [];
      try {
        rows = await meta.getInsights(
          { type: "adset", id: adSet.id },
          token,
          { datePreset: "last_7d", level: "adset" },
        );
      } catch { continue; }
      for (const row of rows) {
        const spendMajor = row.spendMajor ?? 0;
        totalSpend += spendMajor;
        totalClicks += row.clicks;
        totalImpressions += row.impressions;
        totalLeads += row.purchases ?? 0;
        totalPoints++;
        await prisma.experimentMetricPoint.create({
          data: {
            experimentId: experiment.id,
            variantId: variants[i].id,
            spend: spendMajor,
            revenue: row.purchaseValueMajor ?? 0,
            purchases: row.purchases ?? 0,
            impressions: row.impressions,
            clicks: row.clicks,
            addsToCart: 0,
            initiatesCheckout: 0,
            ctr: row.ctr,
          },
        });
      }
    }
    variantMetrics.push({
      variantId: variants[i].id,
      pointsCreated: totalPoints,
    });

    const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    if (totalPoints > 0 && ctr < 0.005) {
      const alert = await prisma.alert.create({
        data: {
          workspaceId: workspace.id,
          type: AlertType.CREATIVE_FATIGUE,
          severity: AlertSeverity.WARNING,
          title: `Kreatif yorgunluk: ${experiment.id}`,
          message: `Varyant ${i + 1} CTR oranı düşük (%${(ctr * 100).toFixed(2)}).`,
          entityType: "STUDIO_EXPERIMENT",
          entityId: experiment.id,
        },
      });
      alerts.push(alert);
    }
    if (totalSpend > 0 && totalPoints > 0) {
      const avgCpl = totalLeads > 0 ? totalSpend / totalLeads : Infinity;
      if (avgCpl > 500000) {
        const alert = await prisma.alert.create({
          data: {
            workspaceId: workspace.id,
            type: AlertType.HIGH_CPA,
            severity: AlertSeverity.CRITICAL,
            title: `Yüksek CPL: ${experiment.id}`,
            message: `Varyant ${i + 1} ortalama CPL ₺${(avgCpl / 100).toFixed(0)}.`,
            entityType: "STUDIO_EXPERIMENT",
            entityId: experiment.id,
          },
        });
        alerts.push(alert);
      }
    }
  }

  const variantTotals = await Promise.all(
    variants.map(async (v: any) => {
      const agg = await prisma.experimentMetricPoint.aggregate({
        where: { experimentId: experiment.id, variantId: v.id },
        _sum: { spend: true, clicks: true },
        _count: { _all: true },
      });
      return {
        spend: (agg as any)._sum.spend ?? 0,
        clicks: (agg as any)._count._all ?? 0,
        leads: 0,
      };
    }),
  );
  const totalClicks = variantTotals.reduce((s: number, v: any) => s + v.clicks, 0);
  const elapsedDays = experiment.elapsedDays + 1;
  const completed = elapsedDays >= snapshot.duration;

  await prisma.studioExperiment.updateMany({
    where: { id: experiment.id },
    data: {
      metrics: JSON.stringify(variantTotals),
      elapsedDays,
      status: completed ? "COMPLETED" : "RUNNING",
      version: { increment: 1 },
    },
  });

  return { variantMetrics, alerts, completed };
}