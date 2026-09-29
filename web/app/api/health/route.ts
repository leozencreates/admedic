import { prisma } from "@admedic/database";
import { deliveryBacklog } from "../../_lib/webhook-queue";

/**
 * Sağlık ucu (ADR-0023): kapsayıcı sağlık denetimi ve dış izleme için oturumsuz, salt okunur.
 * - 200 `ok`: veritabanı yanıt veriyor, bekleyen webhook birikmesi yok.
 * - 200 `degraded`: veritabanı ayakta ama 15 dakikadan eski bekleyen ya da kalıcı başarısız teslim var.
 * - 503 `down`: veritabanına ulaşılamıyor.
 * Kişisel veri ya da yapılandırma değeri döndürmez; yalnızca sayılar.
 */
export const dynamic = "force-dynamic";

const STALE_MS = 15 * 60_000;

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return Response.json({ status: "down", checks: { database: "down" } }, { status: 503, headers });
  }
  const backlog = await deliveryBacklog();
  const stale = backlog.oldestPendingAt !== null && Date.now() - backlog.oldestPendingAt.getTime() > STALE_MS;
  return Response.json(
    {
      status: stale || backlog.failed > 0 ? "degraded" : "ok",
      checks: {
        database: "up",
        webhooks: { pending: backlog.pending, failed: backlog.failed, stale },
      },
      version: process.env.APP_VERSION ?? null,
    },
    { headers },
  );
}
