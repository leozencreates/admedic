import { prisma, anonymizeExpiredLeads } from "@admedic/database";
import { decryptField, encryptField, loadEnv } from "@admedic/config";
import {
  createMetaClient,
  exchangeUserToken,
  getAppAccessToken,
  getTokenDebug,
  MetaGraphError,
  type MetaClientLike,
} from "@admedic/meta-api";
import type { Alert } from "@admedic/database";
import { AlertSeverity, AlertType } from "@admedic/database";
import { detectAnomalies, type DailyCampaignRow } from "./anomalies";
import { toMinorUnits } from "./money";
import { runAssistant } from "./assistant";

/** Meta token yenileme eşiği: Süresi bu pencerenin altına inen bağlantılar yenilenir. */
const META_REFRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** debug_token ile geçerlilik kontrolüne girilecek pencere (revoked token tespiti). */
const META_DEBUG_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
/** Anomali karşılaştırması için geriye bakılan gün sayısı (2 × 7 gün + senkron gecikmesi payı). */
const ANOMALY_LOOKBACK_DAYS = 21;
/**
 * Meta rate limit / throttle hata kodları (docs/meta-constraints.md "Insights — rate limiting"):
 * 4 (app), 17 (user), 32 (page), 613 (custom rate limit), 80004 (ads insights request limit).
 */
const META_THROTTLE_CODES = new Set([4, 17, 32, 613, 80004]);
import {
  buildWeeklyReport,
  isReportDay,
  reportPeriod,
  renderReportPdf,
  sendWeeklyReportEmail,
} from "@admedic/reporting";

/** Çözülemeyen (bozuk/anahtarı değişmiş) token null döner; çağıran bağlantıyı atlar ve döngü sürer. */
const decryptToken = (ciphertext: string): string | null => {
  try {
    return decryptField(ciphertext);
  } catch {
    return null;
  }
};
const encryptToken = (token: string): string => encryptField(token) ?? "";

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

/**
 * Zamanlayıcıyı başlatır. Bu modül import edildiğinde HİÇBİR şey başlatmaz;
 * yalnızca `cli.ts` (pnpm start) çağırır.
 */
let running = false;
/** Üst üste binen çalıştırmaları engeller (uzun süren Meta/LLM çağrıları bir sonraki tetiği beklemez). */
async function runGuarded(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runScheduled(createMetaClient());
  } catch {
    // runScheduled kendi içinde workspace bazında hata yakalar; buraya düşen hatalar döngüyü durdurmaz.
  } finally {
    running = false;
  }
}
export function start(intervalMs = 5 * 60 * 1000): void {
  stop();
  void runGuarded();
  timer = setInterval(() => void runGuarded(), intervalMs);
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

function errorSummary(err: unknown): string {
  if (err instanceof MetaGraphError) return `MetaGraphError code=${err.detail.code ?? "-"} subcode=${err.detail.subcode ?? "-"}`;
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 120)}`;
  return String(err).slice(0, 120);
}

/** Meta throttle/rate-limit hatası mı? (hesap bazında atlanır, diğer hesaplar devam eder) */
export function isMetaThrottleError(err: unknown): boolean {
  if (!(err instanceof MetaGraphError)) return false;
  const { code, subcode } = err.detail;
  if (code !== undefined && META_THROTTLE_CODES.has(code)) return true;
  if (subcode !== undefined && META_THROTTLE_CODES.has(subcode)) return true;
  return code === 429;
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
    // Bir workspace'teki hata diğerlerini etkilemez (kiracı izolasyonu).
    try {
      const workspace = await prisma.workspace.findUniqueOrThrow({
        where: { id: wsId },
        include: { adAccounts: { include: { connection: true } } },
      });
      const org = await prisma.organization.findUnique({
        where: { id: workspace.orgId },
        select: { id: true, retentionDays: true, reportRecipient: true },
      });
      const health = await checkConnectionHealth(workspace);
      alertsCreated += health.alerts;
      webhooksDelivered += health.webhooks;
      insightsSynced += await syncInsights(meta, workspace);
      alertsCreated += await runAnomalyAlerts(workspace.id);
      alertsCreated += await runAnonRetention(org ?? { id: workspace.orgId, retentionDays: 0 }, workspace.id);
      emailsSent += await deliverWeeklyReport(workspace.id, org?.reportRecipient ?? null);
      const experiments = await prisma.studioExperiment.findMany({
        where: { draft: { workspaceId: wsId }, status: "RUNNING" },
        include: { draft: { include: { workspace: { include: { adAccounts: { include: { connection: true } } } } } } },
      });
      for (const experiment of experiments) {
        const result = await syncExperiment(meta, experiment);
        alertsCreated += result.alerts.length;
        completed += result.completed ? 1 : 0;
      }
    } catch (err) {
      // PII yok: yalnızca workspace id ve hata sınıfı/kodu.
      console.warn(`[meta-sync] workspace ${wsId} senkronu tamamlanamadı: ${errorSummary(err)}`);
    }
  }
  // AI asistan turu (spec 3.8): yanıtlanmamış gelen mesajlara bot yanıtı / devir (W7, assistant.ts).
  try {
    await runAssistant();
  } catch (err) {
    console.warn(`[meta-sync] asistan turu tamamlanamadı: ${errorSummary(err)}`);
  }
  return { insightsSynced, alertsCreated, webhooksDelivered, completed, emailsSent };
}

/**
 * Haftalık raporu tenant bazlı alıcıya gönderir: `Organization.reportRecipient` yoksa
 * `WEEKLY_REPORT_RECIPIENT`; ikisi de yoksa o workspace atlanır. `reportRecipient`
 * verilmezse (undefined) organizasyondan okunur.
 */
export async function deliverWeeklyReport(workspaceId: string, reportRecipient?: string | null): Promise<number> {
  const env = loadEnv();
  const now = new Date();
  if (!isReportDay(now, env.WEEKLY_REPORT_DAY)) return 0;
  if (!env.RESEND_API_KEY) return 0;
  let tenantRecipient = reportRecipient;
  if (tenantRecipient === undefined) {
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { org: { select: { reportRecipient: true } } },
    });
    tenantRecipient = ws?.org.reportRecipient ?? null;
  }
  const recipient = tenantRecipient?.trim() || env.WEEKLY_REPORT_RECIPIENT;
  if (!recipient) return 0;
  const { start } = reportPeriod(now, env.WEEKLY_REPORT_DAY);
  try {
    return await prisma.$transaction(async (tx) => {
      // Serialize deliveries across worker processes. Failed attempts remain retryable.
      // `pg_advisory_xact_lock` void döner → $executeRaw (sonuç deserializasyonu yok).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext(${start.toISOString()}))`;
      const key = { workspaceId_periodStart: { workspaceId, periodStart: start } };
      const sent = await tx.reportDelivery.findUnique({ where: key });
      if (sent && !sent.error) return 0;
      const report = await buildWeeklyReport(workspaceId, now, env.WEEKLY_REPORT_DAY);
      const pdf = await renderReportPdf(report);
      const result = await sendWeeklyReportEmail(report, pdf, recipient);
      const data = { recipient, error: result.error ? "Rapor gönderilemedi." : null, sentAt: now };
      await tx.reportDelivery.upsert({
        where: key, create: { workspaceId, periodStart: start, ...data }, update: data,
      });
      return result.error ? 0 : 1;
    }, { timeout: 60_000 });
  } catch (err) {
    console.warn(`[reporting] Haftalık rapor teslimi tamamlanamadı (workspace ${workspaceId}): ${errorSummary(err)}`);
    return 0;
  }
}

async function runAnonRetention(org: { id: string; retentionDays: number | null }, workspaceId: string): Promise<number> {
  return anonymizeExpiredLeads(prisma, { orgId: org.id, workspaceId, retentionDays: org.retentionDays ?? 365 });
}

/** Uyarı dedup penceresi: ACK/RESOLVED uyarıdan sonra 24 saat yeni uyarı üretilmez. */
const ALERT_DEDUP_MS = 24 * 3600 * 1000;

/**
 * Bağlantıyı kopmuş olarak kalıcılaştırır (durum + lastError) ve bağlı reklam
 * hesaplarını PAUSED'a alır (web DELETE ucuyla aynı davranış; spec 3.1).
 */
async function markConnectionBroken(connId: string, status: "EXPIRED" | "REVOKED", lastError: string): Promise<void> {
  await prisma.$transaction([
    prisma.metaConnection.update({ where: { id: connId }, data: { status, lastError } }),
    prisma.adAccount.updateMany({ where: { connectionId: connId, status: "ACTIVE" }, data: { status: "PAUSED" } }),
  ]);
}

/**
 * Bağlantı sağlığı — bağlantı bazlı döngü (her bağlantı bir kez; birden fazla reklam
 * hesabı aynı bağlantıya bağlı olabilir). Organizasyonun tüm bağlantıları (sayfa/WhatsApp
 * dahil) kontrol edilir; reklam hesabı kimlikleri uyarı/webhook yüküne eklenir.
 */
export async function checkConnectionHealth(
  workspace: any,
): Promise<{ alerts: number; webhooks: number }> {
  const env = loadEnv();
  let alerts = 0;
  let webhooks = 0;
  const accountIdsByConn = new Map<string, string[]>();
  for (const account of workspace.adAccounts ?? []) {
    if (!account.connectionId) continue;
    const list = accountIdsByConn.get(account.connectionId) ?? [];
    list.push(account.id);
    accountIdsByConn.set(account.connectionId, list);
  }
  const connections = await prisma.metaConnection.findMany({ where: { orgId: workspace.orgId } });
  for (const conn of connections) {
    const accountIds = accountIdsByConn.get(conn.id) ?? [];
    const notify = async (status: "EXPIRED" | "REVOKED") => {
      const created = await ensureDisconnectAlert(workspace.id, conn, accountIds, status);
      alerts += created;
      if (created) webhooks += (await deliverDisconnectWebhook(workspace.id, conn, accountIds, status)) ? 1 : 0;
    };

    // 1) DB durumu zaten kopmuş → reklam hesapları PAUSED (idempotent), bildir (dedup).
    if (conn.status === "EXPIRED" || conn.status === "REVOKED") {
      await prisma.adAccount.updateMany({ where: { connectionId: conn.id, status: "ACTIVE" }, data: { status: "PAUSED" } });
      await notify(conn.status);
      continue;
    }
    if (conn.status !== "CONNECTED") continue;

    // Mock modda gerçek token yoktur; DB durumu yeterlidir.
    if (env.META_MOCK_MODE) continue;
    if (!conn.tokenCiphertext) continue;

    const token = decryptToken(conn.tokenCiphertext);
    if (!token) {
      // Durum değiştirilmez (geçici anahtar hatası olabilir); bağlantı bu turda atlanır.
      console.warn(`[meta-sync] bağlantı ${conn.id}: token çözülemedi (ENCRYPTION_KEY değişmiş olabilir); atlandı.`);
      continue;
    }
    const now = Date.now();

    if (conn.expiresAt && conn.expiresAt.getTime() <= now) {
      // Süresi dolmuş token → EXPIRED + lastError, kritik uyarı.
      await markConnectionBroken(conn.id, "EXPIRED", "Token süresi doldu.");
      await notify("EXPIRED");
      continue;
    }

    // 2) debug_token ile geçersiz/iptal tespiti: son kullanma bilinmiyorsa (sayfa token'ı
    //    gibi süresiz token) her turda, biliniyorsa yalnızca son kullanma yakınsa.
    const nearExpiry = conn.expiresAt ? conn.expiresAt.getTime() - now < META_DEBUG_WINDOW_MS : true;
    if (nearExpiry && env.META_APP_ID && env.META_APP_SECRET) {
      try {
        const debug = await getTokenDebug(token, getAppAccessToken());
        if (debug.isValid === false) {
          await markConnectionBroken(conn.id, "REVOKED", debug.error ?? "Token geçersiz veya iptal edilmiş.");
          await notify("REVOKED");
          continue;
        }
        if (debug.expiresAt && (!conn.expiresAt || debug.expiresAt.getTime() > conn.expiresAt.getTime())) {
          await prisma.metaConnection.update({ where: { id: conn.id }, data: { expiresAt: debug.expiresAt } });
          conn.expiresAt = debug.expiresAt;
        }
      } catch (err) {
        // debug_token çağrısı başarısızsa (ağ/rate limit) sessiz geç; işlem devam eder.
        console.warn(`[meta-sync] debug_token başarısız (bağlantı ${conn.id}): ${errorSummary(err)}`);
      }
    }

    // 3) Süre dolmadan proaktif yenileme; başarısızsa TOKEN_EXPIRING uyarısı.
    if (conn.expiresAt && conn.expiresAt.getTime() - now < META_REFRESH_WINDOW_MS) {
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
          const reason = err instanceof Error ? err.message : String(err);
          if (err instanceof MetaGraphError && err.detail.code === 190) {
            // Geçersiz/iptal edilmiş token → REVOKED + lastError.
            await markConnectionBroken(conn.id, "REVOKED", `Meta token'ı geçersiz: ${reason}`.slice(0, 500));
            await notify("REVOKED");
            continue;
          }
          await prisma.metaConnection.update({
            where: { id: conn.id },
            data: { lastError: `Token yenileme başarısız: ${reason}`.slice(0, 500) },
          });
          alerts += await ensureExpiringAlert(workspace.id, conn, accountIds, reason);
        }
      } else {
        alerts += await ensureExpiringAlert(
          workspace.id,
          conn,
          accountIds,
          "META_APP_ID/META_APP_SECRET ayarlanmamış; proaktif yenileme yapılamadı.",
        );
      }
    }
  }
  return { alerts, webhooks };
}

/**
 * Aynı bağlantı için OPEN uyarı varken yeni uyarı üretilmez; ACK/RESOLVED uyarıdan
 * sonra 24 saat boyunca da tekrar üretilmez (bildirim gürültüsü/webhook tekrarı önlenir).
 */
async function alertSuppressed(workspaceId: string, type: AlertType, entityId: string): Promise<boolean> {
  const latest = await prisma.alert.findFirst({
    where: { workspaceId, type, entityId },
    orderBy: { createdAt: "desc" },
    select: { status: true, createdAt: true, resolvedAt: true },
  });
  if (!latest) return false;
  if (latest.status === "OPEN") return true;
  const since = (latest.resolvedAt ?? latest.createdAt).getTime();
  return Date.now() - since < ALERT_DEDUP_MS;
}

async function ensureDisconnectAlert(
  workspaceId: string,
  conn: any,
  accountIds: string[],
  status: string,
): Promise<number> {
  if (await alertSuppressed(workspaceId, AlertType.META_DISCONNECTED, conn.id)) return 0;
  const label = conn.name ?? conn.metaAccountId ?? conn.id;
  const accountsText = accountIds.length > 0 ? ` Reklam hesapları duraklatıldı (${accountIds.length}): ${accountIds.join(", ")}.` : "";
  await prisma.alert.create({
    data: {
      workspaceId,
      type: AlertType.META_DISCONNECTED,
      severity: AlertSeverity.CRITICAL,
      title: `Meta bağlantısı ${status}: ${label}`,
      message: `${conn.type} bağlantısı (${label}) ${status} durumunda${conn.lastError ? `: ${conn.lastError}` : "."}${accountsText} Kampanya işlemleri durduruldu; Meta Bağlantıları sayfasından yeniden bağlanın.`,
      entityType: "META_CONNECTION",
      entityId: conn.id,
    },
  });
  return 1;
}

async function ensureExpiringAlert(
  workspaceId: string,
  conn: any,
  accountIds: string[],
  reason: string,
): Promise<number> {
  if (await alertSuppressed(workspaceId, AlertType.TOKEN_EXPIRING, conn.id)) return 0;
  const label = conn.name ?? conn.metaAccountId ?? conn.id;
  await prisma.alert.create({
    data: {
      workspaceId,
      type: AlertType.TOKEN_EXPIRING,
      severity: AlertSeverity.WARNING,
      title: `Meta token'ı süresi dolmak üzere: ${label}`,
      message: `Bağlantı ${label} token'ı ${conn.expiresAt?.toISOString() ?? "kısa süre içinde"} sona eriyor${accountIds.length > 0 ? ` (reklam hesapları: ${accountIds.join(", ")})` : ""}. Yenilenemedi: ${reason}`,
      entityType: "META_CONNECTION",
      entityId: conn.id,
    },
  });
  return 1;
}

async function deliverDisconnectWebhook(
  workspaceId: string,
  conn: any,
  accountIds: string[],
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
        adAccountIds: accountIds,
        adAccountId: accountIds[0] ?? null,
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

/**
 * Kampanya insight'larını günlük satırlar olarak `InsightSnapshot`'a yazar. Tutarlar
 * hesabın para birimine göre minor unit'e çevrilir (ADR-0011; `AdAccount.currency`).
 * Meta throttle/rate-limit hatasında (613/80004 vb.) ilgili hesap atlanır, diğer hesaplar
 * devam eder.
 */
export async function syncInsights(meta: MetaClientLike, workspace: any): Promise<number> {
  let synced = 0;
  const accounts = workspace.adAccounts?.filter((a: any) => a.connectionId) ?? [];
  for (const account of accounts) {
    const connection = await prisma.metaConnection.findFirst({ where: { id: account.connectionId, orgId: workspace.orgId } });
    if (!connection || connection.status !== "CONNECTED" ||
        (connection.expiresAt && connection.expiresAt <= new Date()) || !account.metaAccountId) continue;
    const mock = loadEnv().META_MOCK_MODE;
    if (!mock && !connection.tokenCiphertext) continue;
    const token = mock ? "mock-token" : decryptToken(connection.tokenCiphertext!);
    if (!token) continue;
    const currency: string = account.currency ?? "EUR";
    try {
      const campaigns = await meta.listCampaigns(account.metaAccountId.replace(/^act_/, ""), token);
      for (const camp of campaigns) {
        const localCampaign = await prisma.campaign.upsert({
          where: { adAccountId_metaCampaignId: { adAccountId: account.id, metaCampaignId: camp.id } },
          create: {
            adAccountId: account.id, workspaceId: workspace.id, metaCampaignId: camp.id,
            name: camp.name, objective: camp.objective,
            status: camp.status === "ACTIVE" ? "ACTIVE" : "PAUSED",
            workflowStatus: camp.status === "ACTIVE" ? "ACTIVE" : "PUBLISHED_PAUSED",
            syncedAt: new Date(),
          },
          update: { name: camp.name, syncedAt: new Date() },
        });
        const rows = await meta
          .getInsights({ type: "campaign", id: camp.id }, token, { datePreset: "last_7d", level: "campaign", timeIncrement: 1 });
        for (const row of rows) {
          const date = new Date(String(row.dateStart ?? new Date().toISOString()).slice(0, 10));
          const existing = await prisma.insightSnapshot.findFirst({
            where: { workspaceId: workspace.id, adAccountId: account.id, campaignId: localCampaign.id, date },
          });
          const data = {
            workspaceId: workspace.id,
            adAccountId: account.id,
            campaignId: localCampaign.id,
            date,
            granularity: "DAILY" as const,
            source: "META",
            spend: toMinorUnits(row.spendMajor, currency),
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
            conversionValue: toMinorUnits(row.purchaseValueMajor, currency),
            frequency: row.frequency ?? null,
            // ctr oran (0-1) olarak Float sütunda kalır; cpc/cpm Int sütunlar → minor unit.
            ctr: row.ctr ?? null,
            cpc: row.cpc !== undefined ? toMinorUnits(row.cpc, currency) : null,
            cpm: row.cpm !== undefined ? toMinorUnits(row.cpm, currency) : null,
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
    } catch (err) {
      if (isMetaThrottleError(err)) {
        console.warn(`[meta-sync] Meta rate limit (hesap ${account.id}); bu turda atlandı: ${errorSummary(err)}`);
        continue;
      }
      if (err instanceof MetaGraphError) {
        console.warn(`[meta-sync] Meta insights alınamadı (hesap ${account.id}); atlandı: ${errorSummary(err)}`);
        continue;
      }
      throw err;
    }
  }
  return synced;
}

/**
 * Her senkron sonrası anomali uyarıları (spec 3.10): kampanya bazında son 7 gün vs önceki
 * 7 gün. Aynı workspace+type+entityId için OPEN uyarı varsa yenisi oluşturulmaz.
 */
export async function runAnomalyAlerts(workspaceId: string, now = new Date()): Promise<number> {
  const since = new Date(now);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - ANOMALY_LOOKBACK_DAYS);
  const snapshots = await prisma.insightSnapshot.findMany({
    where: { workspaceId, campaignId: { not: null }, granularity: "DAILY", date: { gte: since } },
    select: {
      campaignId: true, date: true, spend: true, impressions: true, clicks: true, leads: true, conversionValue: true,
      campaign: { select: { name: true } },
      adAccount: { select: { currency: true } },
    },
  });
  const rows: DailyCampaignRow[] = snapshots.map((s) => ({
    campaignId: s.campaignId!,
    campaignName: s.campaign?.name ?? null,
    date: s.date,
    spend: s.spend,
    impressions: s.impressions,
    clicks: s.clicks,
    leads: s.leads,
    conversionValue: s.conversionValue,
    currency: s.adAccount?.currency ?? null,
  }));
  let created = 0;
  for (const anomaly of detectAnomalies(rows)) {
    const open = await prisma.alert.findFirst({
      where: { workspaceId, type: anomaly.type, entityId: anomaly.entityId, status: "OPEN" },
      select: { id: true },
    });
    if (open) continue;
    await prisma.alert.create({
      data: {
        workspaceId,
        type: anomaly.type,
        severity: anomaly.severity,
        title: anomaly.title,
        message: anomaly.message,
        entityType: anomaly.entityType,
        entityId: anomaly.entityId,
      },
    });
    created++;
  }
  return created;
}

/** Studio experiments are manual until each variant has an explicit remote binding.
 * Never attribute the whole ad account to every variant or advance time per poll.
 */
export async function syncExperiment(
  _meta: MetaClientLike,
  _experiment: unknown,
): Promise<{
  variantMetrics: Array<{ variantId: string; pointsCreated: number }>;
  alerts: Alert[];
  completed: boolean;
}> {
  return { variantMetrics: [], alerts: [], completed: false };
}
