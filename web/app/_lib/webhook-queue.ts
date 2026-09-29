import { prisma } from "@admedic/database";
import { decrypt, encrypt } from "./encrypt";
import { ingestMetaWebhook, type WebhookIngestSummary } from "./webhook-ingest";
import { refetchPendingLeads } from "./lead-refetch";
import { runAfterResponse } from "./after-response";
import { errorSummary, logger } from "./log";

/**
 * Meta webhook teslim kuyruğu (ADR-0023). İmzası doğrulanmış gövde işlenmeden ÖNCE şifreli olarak kalıcı yazılır:
 * işleme (veritabanı, Meta çağrısı, WhatsApp karşılaması) hata verirse teslim kaybolmaz; arka plan süpürücüsü
 * artan aralıklarla yeniden dener. İşleme idempotenttir (mesaj ve leadgen kimliği benzersiz), aynı teslimin iki
 * kez işlenmesi çift kayıt üretmez. İşlenen gövde silinir; satırlar saklama süresi sonunda temizlenir.
 */

/** Yeniden deneme aralıkları (dk): 1, 5, 30, 120, 360. Son denemeden sonra FAILED. */
export const RETRY_DELAYS_MIN = [1, 5, 30, 120, 360] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;
/** İşlenmiş (DONE) satırlar bu kadar gün sonra silinir; FAILED satırlar incelenmek üzere daha uzun kalır. */
export const DONE_RETENTION_DAYS = 7;
export const FAILED_RETENTION_DAYS = 30;

type IngestResult = Awaited<ReturnType<typeof ingestMetaWebhook>>;
/** İşleyici; testler yerine sahte işleyici verebilir. */
export type Ingest = typeof ingestMetaWebhook;

function shortError(error: unknown): string {
  // Şifreli gövdenin içeriği hata metni üzerinden düz metin olarak saklanmamalı.
  return JSON.stringify(errorSummary(error));
}

function nextAttemptAt(attempts: number, now = new Date()): Date {
  const delay = RETRY_DELAYS_MIN[Math.min(attempts - 1, RETRY_DELAYS_MIN.length - 1)];
  return new Date(now.getTime() + delay * 60_000);
}

/** Tek teslimi işler ve sonucu satıra yazar. Hata fırlatmaz; sonuç `ok` ile döner. */
async function processDelivery(
  id: string,
  raw: string,
  attempts: number,
  ingest: Ingest,
): Promise<{ ok: true; result: IngestResult; healthyLeadOrgs: Set<string> } | { ok: false; error: string }> {
  const healthyLeadOrgs = new Set<string>();
  try {
    const result = await ingest(raw, { healthyLeadOrgs });
    await prisma.webhookDelivery.update({
      where: { id },
      data: { status: "DONE", payload: null, attempts, processedAt: new Date(), lastError: null },
    });
    return { ok: true, result, healthyLeadOrgs };
  } catch (error) {
    const message = shortError(error);
    const failed = attempts >= MAX_ATTEMPTS;
    await prisma.webhookDelivery.update({
      where: { id },
      data: failed
        ? { status: "FAILED", attempts, lastError: message }
        : { status: "PENDING", attempts, lastError: message, nextAttemptAt: nextAttemptAt(attempts) },
    });
    logger.error(
      { deliveryId: id, attempts, final: failed },
      failed ? "webhook teslimi kalıcı olarak başarısız" : "webhook teslimi işlenemedi; yeniden denenecek",
    );
    return { ok: false, error: message };
  }
}

/**
 * Webhook ucunun akışı: kaydet → hemen işle. İşleme başarısızsa teslim kuyrukta kalır ve 200 döner (Meta'nın
 * aynı olayı saatlerce yeniden göndermesine gerek yok; yeniden denemeyi biz yaparız).
 */
export async function acceptMetaWebhook(
  raw: string,
  ingest: Ingest = ingestMetaWebhook,
): Promise<WebhookIngestSummary | { received: true; ignored: true; reason: string } | { received: true; queued: true }> {
  const delivery = await prisma.webhookDelivery.create({
    // İlk deneme bu istekte yapılır; süpürücü satırı ancak bu süre dolunca (istek yarıda kaldıysa) alır.
    data: { source: "meta", payload: encrypt(raw), nextAttemptAt: new Date(Date.now() + 5 * 60_000) },
    select: { id: true },
  });
  const outcome = await processDelivery(delivery.id, raw, 1, ingest);
  if (!outcome.ok) return { received: true, queued: true };
  for (const orgId of outcome.healthyLeadOrgs)
    await runAfterResponse("lead-refetch", () => refetchPendingLeads({ orgId, limit: 10, budgetMs: 10_000 }));
  return outcome.result;
}

/**
 * Süresi gelen bekleyen teslimleri işler (arka plan süpürücüsü). Satırlar `FOR UPDATE SKIP LOCKED` ile
 * sahiplenilir ve deneme zamanı ileri alınır: birden çok sunucu örneği aynı teslimi aynı anda işlemez.
 */
export async function retryDueDeliveries(options: { limit?: number; now?: Date; ingest?: Ingest } = {}): Promise<{
  processed: number;
  failed: number;
}> {
  const limit = options.limit ?? 20;
  const now = options.now ?? new Date();
  const lease = new Date(now.getTime() + 5 * 60_000);
  const claimed = await prisma.$queryRaw<{ id: string; payload: string | null; attempts: number }[]>`
    UPDATE "WebhookDelivery" SET "nextAttemptAt" = ${lease}, "updatedAt" = ${now}
    WHERE "id" IN (
      SELECT "id" FROM "WebhookDelivery"
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
      ORDER BY "nextAttemptAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "payload", "attempts"`;
  let processed = 0;
  let failed = 0;
  for (const row of claimed) {
    if (!row.payload) {
      await prisma.webhookDelivery.update({ where: { id: row.id }, data: { status: "FAILED", lastError: "Gövde yok." } });
      failed += 1;
      continue;
    }
    let raw: string;
    try {
      raw = decrypt(row.payload);
    } catch (error) {
      // Anahtar değişmiş olabilir: yeniden denemek sonucu değiştirmez.
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: { status: "FAILED", attempts: row.attempts + 1, lastError: `Şifre çözülemedi: ${shortError(error)}` },
      });
      failed += 1;
      continue;
    }
    const outcome = await processDelivery(row.id, raw, row.attempts + 1, options.ingest ?? ingestMetaWebhook);
    if (outcome.ok) processed += 1;
    else failed += 1;
  }
  return { processed, failed };
}

/** Saklama süresi dolan satırları siler (DONE: 7 gün, FAILED: 30 gün). */
export async function pruneDeliveries(now = new Date()): Promise<number> {
  const day = 86_400_000;
  const result = await prisma.webhookDelivery.deleteMany({
    where: {
      OR: [
        { status: "DONE", createdAt: { lt: new Date(now.getTime() - DONE_RETENTION_DAYS * day) } },
        { status: "FAILED", createdAt: { lt: new Date(now.getTime() - FAILED_RETENTION_DAYS * day) } },
      ],
    },
  });
  return result.count;
}

/** Sağlık ucu için: bekleyen ve kalıcı başarısız teslim sayıları. */
export async function deliveryBacklog(): Promise<{ pending: number; failed: number; oldestPendingAt: Date | null }> {
  const [pending, failed, oldest] = await Promise.all([
    prisma.webhookDelivery.count({ where: { status: "PENDING" } }),
    prisma.webhookDelivery.count({ where: { status: "FAILED" } }),
    prisma.webhookDelivery.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  return { pending, failed, oldestPendingAt: oldest?.createdAt ?? null };
}
