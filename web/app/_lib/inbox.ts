/**
 * Lead gelen kutusu (ADR-0019 · K4-A): her lead için konuşma durumu, son mesaj ve "yanıt bekliyor" kuralı.
 * Sunucu modülüdür (Prisma). Sekmeleme ve sıralama istemcide `inbox-view.ts` ile yapılır.
 *
 * "Yanıt bekliyor" = hasta bir insandan yanıt bekliyor:
 * - Asistan konuşmayı devretti ve kimse devralmadı (ESCALATED, sahipsiz), ya da
 * - Konuşmayı ekipten biri devraldı ve son mesaj hastadan (ESCALATED, sahipli, son mesaj gelen), ya da
 * - Lead yeni (NEW), açık konuşması yok ve kendisine hiç mesaj gönderilmedi (ör. Anında Form lead'i).
 * Asistanın yürüttüğü (ACTIVE) konuşma bir insan beklemez. Tedavi edilen ve kaybedilen lead yanıt beklemez.
 */
import { prisma, type Prisma } from "@admedic/database";
import type { Actor } from "./auth";
import { CARE_ROLES } from "./auth";
import { memberDisplayNames } from "./conversation-claim";

import { messageParty, type MessageParty } from "./message-party";

export { messageParty, type MessageParty };

export interface InboxState {
  conversationStatus: "ACTIVE" | "ESCALATED" | "CLOSED" | null;
  /** Asistan devretti, kimse devralmadı. */
  handedOff: boolean;
  /** Devralan ekip üyesinin adı (sahipli devirde). */
  claimedBy: string | null;
  claimedByMe: boolean;
  lastMessage: {
    at: string;
    direction: "INCOMING" | "OUTGOING";
    party: MessageParty;
    /** Son mesajın ilk 140 karakteri; yalnızca bakım rolleri görür (diğerlerine null). */
    preview: string | null;
  } | null;
  needsReply: boolean;
  /** Yanıt beklemenin başladığı an (ISO); yanıt beklemiyorsa null. */
  waitingSince: string | null;
}

const CLOSED_STATUSES = ["TREATED", "LOST"];
const PREVIEW_CHARS = 140;

const conversationSelect = {
  status: true,
  escalatedTo: true,
  escalatedAt: true,
  createdAt: true,
  messages: {
    // Sistem notları (devralma notu vb.) son mesaj sayılmaz.
    // (Prisma'da `NOT sender = system` NULL gönderenli satırları da dışlar; NULL = asistan, ayrıca eklenir.)
    where: { OR: [{ sender: null }, { sender: { not: "system" } }] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { content: true, direction: true, sender: true, createdAt: true },
  },
  _count: { select: { messages: { where: { direction: "OUTGOING" } } } },
} satisfies Prisma.ConversationSelect;

type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof conversationSelect }>;

/** Tek lead'in gelen kutusu durumu (saf; test edilebilir). */
export function inboxState(
  lead: { status: string; createdAt: Date },
  conversations: ConversationRow[],
  options: { actorId: string; canReadContent: boolean; names: Map<string, string> },
): InboxState {
  // Açık konuşma öncelikli (ESCALATED, sonra ACTIVE), yoksa en yenisi.
  const open =
    conversations.find((c) => c.status === "ESCALATED") ??
    conversations.find((c) => c.status === "ACTIVE") ??
    conversations[0] ??
    null;
  const last = open?.messages[0] ?? null;
  const outgoingEver = conversations.some((c) => c._count.messages > 0);
  const handedOff = open?.status === "ESCALATED" && !open.escalatedTo;
  const claimed = open?.status === "ESCALATED" && Boolean(open.escalatedTo);

  let waitingSince: Date | null = null;
  if (!CLOSED_STATUSES.includes(lead.status)) {
    if (handedOff) waitingSince = open!.escalatedAt ?? last?.createdAt ?? open!.createdAt;
    else if (claimed && last?.direction === "INCOMING") waitingSince = last.createdAt;
    else if ((!open || open.status === "CLOSED") && lead.status === "NEW" && !outgoingEver) waitingSince = lead.createdAt;
  }

  return {
    conversationStatus: (open?.status as InboxState["conversationStatus"]) ?? null,
    handedOff,
    claimedBy: claimed ? (options.names.get(open!.escalatedTo!) ?? "Bir ekip üyesi") : null,
    claimedByMe: claimed && open!.escalatedTo === options.actorId,
    lastMessage: last
      ? {
          at: last.createdAt.toISOString(),
          direction: last.direction as "INCOMING" | "OUTGOING",
          party: messageParty(last),
          preview: options.canReadContent
            ? last.content.length > PREVIEW_CHARS
              ? `${last.content.slice(0, PREVIEW_CHARS - 1)}…`
              : last.content
            : null,
        }
      : null,
    needsReply: waitingSince !== null,
    waitingSince: waitingSince?.toISOString() ?? null,
  };
}

/** Lead kimliği → gelen kutusu durumu (en çok `leadIds` kadar lead). */
export async function inboxStates(actor: Actor, leads: { id: string; status: string; createdAt: Date }[]) {
  if (!leads.length) return new Map<string, InboxState>();
  const conversations = await prisma.conversation.findMany({
    where: { workspaceId: actor.workspaceId, leadId: { in: leads.map((l) => l.id) } },
    orderBy: { createdAt: "desc" },
    select: { leadId: true, ...conversationSelect },
  });
  const names = await memberDisplayNames(actor.orgId, conversations.map((c) => c.escalatedTo));
  const byLead = new Map<string, ConversationRow[]>();
  for (const c of conversations) byLead.set(c.leadId, [...(byLead.get(c.leadId) ?? []), c]);
  const canReadContent = CARE_ROLES.includes(actor.role);
  return new Map(
    leads.map((l) => [l.id, inboxState(l, byLead.get(l.id) ?? [], { actorId: actor.userId, canReadContent, names })]),
  );
}

/**
 * Yanıt bekleyen lead sayısı, en uzun bekleyenin başlangıcı ve kimlikleri (menü rozeti, "Bugün" satırı ve
 * gelen kutusu listesi aynı kümeyi kullanır). Kapanmamış lead'lerin en yeni `NEEDS_REPLY_SCAN`'i üzerinden hesaplanır.
 */
export const NEEDS_REPLY_SCAN = 500;

export async function needsReplySummary(actor: Actor): Promise<{ count: number; oldest: Date | null; leadIds: string[] }> {
  const leads = await prisma.lead.findMany({
    where: { workspaceId: actor.workspaceId, status: { notIn: CLOSED_STATUSES as Prisma.EnumLeadStatusFilter["notIn"] } },
    orderBy: { createdAt: "desc" },
    take: NEEDS_REPLY_SCAN,
    select: { id: true, status: true, createdAt: true },
  });
  const states = await inboxStates(actor, leads);
  let oldest: Date | null = null;
  const leadIds: string[] = [];
  for (const [id, state] of states) {
    if (!state.needsReply || !state.waitingSince) continue;
    leadIds.push(id);
    const since = new Date(state.waitingSince);
    if (!oldest || since < oldest) oldest = since;
  }
  return { count: leadIds.length, oldest, leadIds };
}
