import type { WhatsappConfig } from "@prisma/client";

export interface SendTextInput {
  to: string;
  body: string;
}

export interface SendMediaInput {
  to: string;
  type: "IMAGE" | "VIDEO";
  url: string;
  caption?: string;
}

export interface SendResult {
  providerMessageId?: string;
  mock: boolean;
}

export interface WhatsappMessenger {
  provider: string;
  sendText(input: SendTextInput): Promise<SendResult>;
  sendMedia(input: SendMediaInput): Promise<SendResult>;
}

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN ?? "";

function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9+]/g, "");
}

function createMetaMessenger(config: WhatsappConfig): WhatsappMessenger {
  const phoneNumberId = config.phoneNumberId;
  return {
    provider: "META",
    async sendText({ to, body }) {
      if (!phoneNumberId || !WHATSAPP_TOKEN) {
        throw new Error(
          "WhatsApp Cloud API için WHATSAPP_TOKEN ve phoneNumberId gerekli."
        );
      }
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: normalizePhone(to),
            type: "text",
            text: { body, preview_url: false },
          }),
        }
      );
      const json = (await res.json()) as {
        messages?: { id?: string }[];
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(`WhatsApp hatası: ${json.error?.message ?? res.status}`);
      }
      return { providerMessageId: json.messages?.[0]?.id, mock: false };
    },
    async sendMedia({ to, type, url, caption }) {
      if (!phoneNumberId || !WHATSAPP_TOKEN) {
        throw new Error(
          "WhatsApp Cloud API için WHATSAPP_TOKEN ve phoneNumberId gerekli."
        );
      }
      const payload: Record<string, unknown> = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizePhone(to),
        type: type === "VIDEO" ? "video" : "image",
      };
      if (type === "VIDEO") {
        payload.video = { link: url, caption };
      } else {
        payload.image = { link: url, caption };
      }
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );
      const json = (await res.json()) as {
        messages?: { id?: string }[];
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(`WhatsApp hatası: ${json.error?.message ?? res.status}`);
      }
      return { providerMessageId: json.messages?.[0]?.id, mock: false };
    },
  };
}

function createMockMessenger(): WhatsappMessenger {
  return {
    provider: "MOCK",
    async sendText({ to, body }) {
      console.log(`[MOCK WhatsApp → ${to}] ${body}`);
      return { providerMessageId: `MOCK_${Date.now()}`, mock: true };
    },
    async sendMedia({ to, type, url, caption }) {
      console.log(`[MOCK WhatsApp medya → ${to}] ${type} ${url} (${caption ?? ""})`);
      return { providerMessageId: `MOCK_${Date.now()}`, mock: true };
    },
  };
}

export function createMessenger(config: WhatsappConfig): WhatsappMessenger {
  if (config.provider === "META" && config.phoneNumberId) {
    return createMetaMessenger(config);
  }
  return createMockMessenger();
}

export const PROVIDER_LABEL: Record<string, string> = {
  MOCK: "Simülasyon (Mock)",
  META: "WhatsApp Cloud API (Meta)",
};