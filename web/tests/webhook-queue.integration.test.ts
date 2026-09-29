import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@admedic/database";
import {
  MAX_ATTEMPTS,
  acceptMetaWebhook,
  pruneDeliveries,
  retryDueDeliveries,
  type Ingest,
} from "../app/_lib/webhook-queue";
import { GET as health } from "../app/api/health/route";

/**
 * Webhook teslim kuyruğu (ADR-0023): gövde işlenmeden önce şifreli yazılır; işleme hatası teslimi kaybettirmez,
 * süpürücü artan aralıklarla yeniden dener, son denemede FAILED olur; işlenen gövde silinir.
 */
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("webhook teslim kuyruğu", () => {
  const marker = `queue-test-${Date.now()}`;
  const ids: string[] = [];
  const later = (min: number) => new Date(Date.now() + min * 60_000);
  const summary = { received: true as const, processed: 1, duplicates: 0, ignored: 0, ignoredPages: 0 };
  const ok: Ingest = async () => summary;
  const failing = (message: string): Ingest => async () => {
    throw new Error(message);
  };
  const latest = () => prisma.webhookDelivery.findFirstOrThrow({ orderBy: { createdAt: "desc" } });

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("başarılı teslim işlenir, gövde silinir", async () => {
    expect(await acceptMetaWebhook(JSON.stringify({ marker, ok: true }), ok)).toMatchObject({ processed: 1 });
    const row = await latest();
    ids.push(row.id);
    expect(row).toMatchObject({ status: "DONE", attempts: 1, payload: null, lastError: null });
  });

  it("işleme hatası teslimi kaybettirmez: şifreli saklanır, süpürücü yeniden dener", async () => {
    const raw = JSON.stringify({ marker, retry: true, text: "Tedavi geçmişim" });
    expect(await acceptMetaWebhook(raw, failing("veritabanı geçici olarak yanıt vermiyor"))).toEqual({ received: true, queued: true });
    const row = await latest();
    ids.push(row.id);
    expect(row).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(row.payload).not.toBeNull();
    expect(row.payload).not.toContain("Tedavi");
    expect(row.lastError).toContain("geçici");
    // İlk deneme istekte yapıldığı için satır birkaç dakika kilitli; zamanı gelmeden alınmaz.
    expect((await retryDueDeliveries({ now: new Date(), ingest: ok })).processed).toBe(0);
    const seen: string[] = [];
    const recording: Ingest = async (body) => {
      seen.push(body);
      return summary;
    };
    await retryDueDeliveries({ now: later(10), ingest: recording });
    expect(seen).toContain(raw);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "DONE",
      attempts: 2,
      payload: null,
    });
  });

  it("son denemede FAILED olur; sağlık ucu 'degraded' der; saklama süresi dolunca silinir", async () => {
    const fail = failing("kalıcı hata");
    await acceptMetaWebhook(JSON.stringify({ marker, fail: true }), fail);
    const row = await latest();
    ids.push(row.id);
    let minutes = 0;
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      minutes += 400;
      await retryDueDeliveries({ now: later(minutes), ingest: fail });
    }
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "FAILED",
      attempts: MAX_ATTEMPTS,
    });
    const body = await (await health()).json();
    expect(body.status).toBe("degraded");
    expect(body.checks.webhooks.failed).toBeGreaterThanOrEqual(1);
    expect(await pruneDeliveries(later(31 * 24 * 60))).toBeGreaterThanOrEqual(1);
    expect(await prisma.webhookDelivery.findUnique({ where: { id: row.id } })).toBeNull();
  });
});
