import { respond, HttpError } from "../../../_lib/http";
import { verifyWebhookSignature } from "../../../_lib/verify";
import {
  handleWebhookVerification,
  ingestMetaWebhook,
  resolveWebhookSecret,
} from "../../../_lib/webhook-ingest";
import { runAfterResponse } from "../../../_lib/after-response";
import { refetchPendingLeads } from "../../../_lib/lead-refetch";

/**
 * Meta webhook ucu (kanonik): Lead Ads, Messenger, Instagram DM ve WhatsApp Cloud API.
 * - GET: abonelik doğrulaması (hub.mode / hub.verify_token / hub.challenge).
 * - POST: X-Hub-Signature-256 ham gövde üzerinden doğrulanır (secret yoksa fail-closed 401),
 *   ardından olaylar idempotent olarak işlenir. Bilinmeyen biçim 200 `{ ignored: true }` döner
 *   ki Meta 36 saat boyunca yeniden denemesin; yalnızca imza hatası 401'dir.
 * - Lead alanları sorunsuz çekilen kuruluşta, alanları daha önce çekilemeyen (`pendingFetch`) lead'ler
 *   yanıttan sonra yeniden denenir (token düzelmiş demektir; ADR-0015).
 * Eski yol `api/leads/[id]/webhook` bu handler'ları yeniden dışa aktarır.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleWebhookVerification(new URL(request.url).searchParams);
}

export async function POST(request: Request) {
  return respond(async () => {
    const raw = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifyWebhookSignature(raw, signature, resolveWebhookSecret()))
      throw new HttpError(401, "Webhook imzası doğrulanamadı.");
    const healthyLeadOrgs = new Set<string>();
    const summary = await ingestMetaWebhook(raw, { healthyLeadOrgs });
    for (const orgId of healthyLeadOrgs)
      await runAfterResponse("lead-refetch", () => refetchPendingLeads({ orgId, limit: 10, budgetMs: 10_000 }));
    return summary;
  });
}
