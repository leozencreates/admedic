import { loadEnv } from "@admedic/config";

export interface DisconnectWebhookPayload {
  workspaceId: string;
  connectionId: string;
  adAccountIds: string[];
  connectionType: string;
  status: string;
  connectionName: string | null;
  metaAccountId: string | null;
  occurredAt: string;
}

/**
 * Bağlantı koptuğunda dış webhook'a `POST /` ile JSON bildirim gönderir
 * (spec 3.1: META_DISCONNECTED_WEBHOOK_URL). Sessizce çalışır; başarısızlık
 * yutulur, scheduler bir sonraki döngüde tekrar dener.
 */
export async function deliverDisconnectWebhook(
  payload: Omit<DisconnectWebhookPayload, "occurredAt">,
): Promise<boolean> {
  const env = loadEnv();
  if (!env.META_DISCONNECTED_WEBHOOK_URL) return false;
  try {
    const res = await fetch(env.META_DISCONNECTED_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "meta.connection.disconnected",
        ...payload,
        occurredAt: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.warn(`[meta-webhook] teslim ${res.status}: ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[meta-webhook] teslim başarısız: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}