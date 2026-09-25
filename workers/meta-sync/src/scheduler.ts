import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import {
  createMetaClient,
  exchangeUserToken,
  getAppAccessToken,
  getTokenDebug,
  type MetaClientLike,
} from "@admedic/meta-api";
import type { Alert } from "@admedic/database";
import { AlertSeverity, AlertType } from "@admedic/database";

/** Meta token yenileme eşiği: Süresi bu pencerenin altına inen bağlantılar yenilenir. */
const META_REFRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** debug_token ile geçerlilik kontrolüne girilecek pencere (revoked token tespiti). */
const META_DEBUG_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
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
    webhooksDelivered: number;
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
  webhooksDelivered: number;
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
  let webhooksDelivered = 0;
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
    const health = await checkConnectionHealth(workspace);
    alertsCreated += health.alerts;
    webhooksDelivered += health.webhooks;
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
  return { insightsSynced, alertsCreated, webhooksDelivered, completed, emailsSent };
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

async function checkConnectionHealth(
  workspace: any,
): Promise<{ alerts: number; webhooks: number }> {
  const env = loadEnv();
  let alerts = 0;
  let webhooks = 0;
  const accounts = workspace.adAccounts?.filter((a: any) => a.connectionId) ?? [];
  for (const account of accounts) {
    const conn = account.connection;
    if (!conn) continue;

    // 1) DB durumu zaten kopmuş → bildir.
    if (conn.status === "EXPIRED" || conn.status === "REVOKED") {
      const created = await ensureDisconnectAlert(workspace.id, conn, account.id, conn.status);
      alerts += created;
      if (created) webhooks += (await deliverDisconnectWebhook(workspace.id, conn, account.id, conn.status)) ? 1 : 0;
      continue;
    }
    if (conn.status !== "CONNECTED") continue;

    // Mock modda gerçek token yoktur; DB durumu yeterlidir.
    if (env.META_MOCK_MODE) continue;
    if (!conn.tokenCiphertext || !conn.expiresAt) continue;

    const token = decryptToken(conn.tokenCiphertext);
    const now = Date.now();

    if (conn.expiresAt.getTime() <= now) {
      // Süresi dolmuş token → EXPIRED, kritik uyarı.
      await prisma.metaConnection.update({
        where: { id: conn.id },
        data: { status: "EXPIRED", lastError: "Token süresi doldu." },
      });
      const created = await ensureDisconnectAlert(workspace.id, conn, account.id, "EXPIRED");
      alerts += created;
      if (created) webhooks += (await deliverDisconnectWebhook(workspace.id, conn, account.id, "EXPIRED")) ? 1 : 0;
      continue;
    }

    // 2) debug_token ile geçersiz/iptal tespiti (son kullanma yakınsa veya belirsizse).
    const nearExpiry = conn.expiresAt.getTime() - now < META_DEBUG_WINDOW_MS;
    if (!conn.expiresAt || nearExpiry) {
      if (env.META_APP_ID && env.META_APP_SECRET) {
        try {
          const debug = await getTokenDebug(token, getAppAccessToken());
          if (debug.isValid === false) {
            await prisma.metaConnection.update({
              where: { id: conn.id },
              data: {
                status: "REVOKED",
                lastError: debug.error ?? "Token geçersiz veya iptal edilmiş.",
              },
            });
            const created = await ensureDisconnectAlert(workspace.id, conn, account.id, "REVOKED");
            alerts += created;
            if (created) webhooks += (await deliverDisconnectWebhook(workspace.id, conn, account.id, "REVOKED")) ? 1 : 0;
            continue;
          }
          if (debug.expiresAt && (!conn.expiresAt || debug.expiresAt.getTime() > conn.expiresAt.getTime())) {
            await prisma.metaConnection.update({ where: { id: conn.id }, data: { expiresAt: debug.expiresAt } });
            conn.expiresAt = debug.expiresAt;
          }
        } catch {
          // debug_token çağrısı başarısızsa sessiz geç; işlem devam eder.
        }
      }
    }

    // 3) Süre dolmadan proaktif yenileme; başarısızsa TOKEN_EXPIRING uyarısı.
    if (conn.expiresAt.getTime() - now < META_REFRESH_WINDOW_MS) {
      if (env.META_APP_ID && env.META_APP_SECRET) {
        try {
          const exchanged = await exchangeUserToken(token);
          await prisma.metaConnection.update({
            where: { id: conn.id },
            data: {
              tokenCiphertext: encryptToken(exchanged.accessToken),
              expiresAt: exchanged.expiresAt ?? conn.expiresAt,
              status: "CONNECTED",
              lastError: null,
            },
          });
        } catch (err) {
          const created = await ensureExpiringAlert(
            workspace.id,
            conn,
            account.id,
            err instanceof Error ? err.message : String(err),
          );
          alerts += created;
        }
      } else {
        const created = await ensureExpiringAlert(
          workspace.id,
          conn,
          account.id,
          "META_APP_ID/META_APP_SECRET ayarlanmamış; proaktif yenileme yapılamadı.",
        );
        alerts += created;
      }
    }
  }
  return { alerts, webhooks };
}

function encryptToken(token: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

async function ensureDisconnectAlert(
  workspaceId: string,
  conn: any,
  accountId: string,
  status: string,
): Promise<number> {
  const existing = await prisma.alert.findFirst({
    where: { workspaceId, type: AlertType.META_DISCONNECTED, entityId: conn.id, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
  });
  if (existing) return 0;
  await prisma.alert.create({
    data: {
      workspaceId,
      type: AlertType.META_DISCONNECTED,
      severity: AlertSeverity.CRITICAL,
      title: `Meta bağlantısı ${status}: ${accountId}`,
      message: `Ad account ${accountId} bağlantısı ${status} durumunda. Kampanya işlemleri durduruldu.`,
      entityType: "META_CONNECTION",
      entityId: conn.id,
    },
  });
  return 1;
}

async function ensureExpiringAlert(
  workspaceId: string,
  conn: any,
  accountId: string,
  reason: string,
): Promise<number> {
  const existing = await prisma.alert.findFirst({
    where: { workspaceId, type: AlertType.TOKEN_EXPIRING, entityId: conn.id, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
  });
  if (existing) return 0;
  await prisma.alert.create({
    data: {
      workspaceId,
      type: AlertType.TOKEN_EXPIRING,
      severity: AlertSeverity.WARNING,
      title: `Meta token'ı süresi dolmak üzere: ${accountId}`,
      message: `Bağlantı ${conn.name ?? accountId} token'ı ${conn.expiresAt?.toISOString() ?? "kısa"}. Yenilenemedi: ${reason}`,
      entityType: "META_CONNECTION",
      entityId: conn.id,
    },
  });
  return 1;
}

async function deliverDisconnectWebhook(
  workspaceId: string,
  conn: any,
  accountId: string,
  status: string,
): Promise<boolean> {
  const env = loadEnv();
  if (!env.META_DISCONNECTED_WEBHOOK_URL) return false;
  try {
    const res = await fetch(env.META_DISCONNECTED_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "meta.connection.disconnected",
        workspaceId,
        connectionId: conn.id,
        adAccountId: accountId,
        connectionType: conn.type,
        status,
        connectionName: conn.name ?? null,
        metaAccountId: conn.metaAccountId ?? null,
        occurredAt: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.warn(`[meta-sync] webhook teslimi ${res.status}: ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[meta-sync] webhook teslimi başarısız: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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
          addsToCart: row.addsToCart ?? 0,
          initiatesCheckout: row.initiatesCheckout ?? 0,
          leads: row.leads ?? 0,
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