/**
 * Mesajlaşma penceresi (spec 3.8; ADR-0019): hastanın son gerçek mesajından sonraki 24 saat.
 * WhatsApp'ta pencere dışında yalnızca onaylı şablon gönderilebilir; Messenger/Instagram'da pencere dışı
 * gönderim HUMAN_AGENT etiketiyle yapılır. Sunucu modülüdür; istemci yalnızca `ReplyWindow` sonucunu görür.
 */
import { prisma, type Prisma } from "@admedic/database";
import { WINDOW_MS } from "./whatsapp";

/**
 * Pencereyi yalnızca gerçekten dış kanaldan gelen mesajlar açar:
 * INCOMING + (externalId ya da metadata.mid/wamid dolu ya da sender="external").
 * Panelden simüle edilen (sender = kullanıcı kimliği) gelen mesajlar sayılmaz.
 */
export const REAL_INBOUND: Prisma.MessageWhereInput = {
  direction: "INCOMING",
  OR: [
    { externalId: { not: null } },
    { sender: "external" },
    { metadata: { path: ["mid"], string_starts_with: "" } },
    { metadata: { path: ["wamid"], string_starts_with: "" } },
  ],
};

export async function lastRealInboundAt(conversationId: string): Promise<Date | null> {
  const row = await prisma.message.findFirst({
    where: { conversationId, ...REAL_INBOUND },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

export interface ReplyWindow {
  /** Hastanın son gerçek mesajı (ISO); hiç yoksa null. */
  lastInboundAt: string | null;
  /** Pencerenin kapandığı an (ISO); hiç gelen mesaj yoksa null. */
  endsAt: string | null;
  open: boolean;
}

export function replyWindow(lastInbound: Date | null, now: Date = new Date()): ReplyWindow {
  if (!lastInbound) return { lastInboundAt: null, endsAt: null, open: false };
  const ends = new Date(lastInbound.getTime() + WINDOW_MS);
  return { lastInboundAt: lastInbound.toISOString(), endsAt: ends.toISOString(), open: now.getTime() <= ends.getTime() };
}
