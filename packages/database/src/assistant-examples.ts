import type { Prisma } from "@prisma/client";

/**
 * Asistan için üslup örnekleri (ADR-0027): randevuya dönüşen Instagram konuşmalarında ekibin (insan) yazdığı
 * yanıtlar. Web ve işçi asistanı aynı sorguyu kullanır.
 *
 * - Yalnızca kuruluş ayarı açıkken (`Organization.assistantExamplesEnabled`) ve yalnızca aynı çalışma alanından.
 * - Hastanın yazdıkları DÖNMEZ; yalnızca ekibin giden mesajları. Asistan ve sistem mesajları örnek olmaz.
 * - Yanıtlanan lead'in kendi konuşması ve anonimleştirilmiş lead'ler dışarıda kalır.
 * - Ad maskeleme çağıran tarafta yapılır (`@admedic/llm` `toStyleExamples`); bunun için hastanın adı döner.
 */

/** Randevu alınmış ya da daha ileri aşamalar. */
const CONVERTED_STATUSES = ["CONSULTATION_BOOKED", "TRAVEL_PLANNED", "TREATED"] as const;
const NON_HUMAN_SENDERS = ["ai", "bot", "system", "simulated"];
const MAX_CONVERSATIONS = 3;
const MAX_REPLIES = 4;

export interface TeamReplyExample {
  replies: string[];
  /** Konuşmadaki hastanın adı ve soyadı; örnek metinden maskelenmesi için. */
  names: string[];
}

export async function loadTeamReplyExamples(
  db: Prisma.TransactionClient,
  scope: { workspaceId: string; language: string; excludeLeadId: string },
): Promise<TeamReplyExample[]> {
  const workspace = await db.workspace.findUnique({
    where: { id: scope.workspaceId },
    select: { org: { select: { assistantExamplesEnabled: true } } },
  });
  if (!workspace?.org.assistantExamplesEnabled) return [];
  const conversations = await db.conversation.findMany({
    where: {
      workspaceId: scope.workspaceId,
      channel: "INSTAGRAM",
      lead: {
        id: { not: scope.excludeLeadId },
        status: { in: [...CONVERTED_STATUSES] },
        language: { equals: scope.language, mode: "insensitive" },
        // Anonimleştirilen lead'in adı yer tutucudur (dili de "und" olur; privacy.ts).
        firstName: { not: "[anonymized]" },
      },
      messages: { some: { direction: "OUTGOING", sender: { notIn: NON_HUMAN_SENDERS } } },
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_CONVERSATIONS,
    select: {
      lead: { select: { firstName: true, lastName: true } },
      messages: {
        // `notIn` null göndereni de dışarıda bırakır (SQL NULL karşılaştırması): göndereni bilinmeyen mesaj örnek olmaz.
        where: { direction: "OUTGOING", sender: { notIn: NON_HUMAN_SENDERS } },
        orderBy: { createdAt: "asc" },
        take: MAX_REPLIES,
        select: { content: true },
      },
    },
  });
  return conversations
    .map((conversation) => ({
      replies: conversation.messages.map((message) => message.content),
      names: [conversation.lead.firstName, conversation.lead.lastName],
    }))
    .filter((example) => example.replies.length > 0);
}
