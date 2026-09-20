import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { PROMPT_VERSION } from "@admedic/llm";
import { requireActor } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { z } from "zod";
import type { MessageChannel } from "@admedic/database";

export const maxDuration = 60;

const ChatSchema = z
  .object({
    leadId: z.string().min(1),
    message: z.string().trim().min(1).max(4000),
    conversationId: z.string().optional(),
  })
  .strict();

const LOCALIZATION: Record<string, string> = {
  TR: "Yerli dilinizde karşılama yapın. Mesaj doğal Türkçe olsun.",
  EN: "Greet in the lead's own language. Use professional, clear tone.",
  DE: "Begrüßen Sie in der Sprache des Leads. Verwenden Sie eine formelle, klare Sprache.",
  RU: "Поздравьте на языке лида. Используйте вежливый, профессиональный тон.",
  AR: "صافح باللغة الخاصة بالعميل. استخدم لغة احترافية واضحة.",
};

const SYSTEM_PROMPT = `You are a health tourism lead qualification assistant bot. Your tasks:
1. Greet the lead in their own language.
2. Collect their name, contact information (email/phone), interested health service, and preferred language.
3. Do NOT give medical advice, diagnoses, or pricing.
4. Only collect information and direct to a human coordinator.
5. Be clear from the first message that you are a bot.

Rules:
- Never provide medical advice, treatment recommendations, or diagnosis.
- Never promise outcomes or compare results.
- Never give pricing or package details.
- If the lead mentions an urgent medical issue, escalate immediately.
- Always state you are an automated assistant at the beginning of the conversation.`;

const URGENT_KEYWORDS = [
  "acil", "yardım", "içinden", "ölüm", "kaybetmek", "son",
  "emergency", "help", "dying", "suicide", "kill myself",
  "hurt myself", "want to die", "end it", "kriz", "krize",
  "son durumda",
];

function detectUrgent(text: string): boolean {
  const lower = text.toLowerCase();
  return URGENT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function getLeadLanguage(lead: { language: string }): string {
  const map: Record<string, string> = {
    tr: "TR", en: "EN", de: "DE", ru: "RU", ar: "AR",
  };
  return map[lead.language?.toLowerCase() ?? "tr"] ?? "TR";
}

function mapChannel(channel: string | null | undefined): string {
  const valid = ["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"];
  if (channel && valid.includes(channel)) return channel;
  return "WHATSAPP";
}

async function generateChatText(systemPrompt: string, userMessage: string, key: string, model: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!response.ok) throw new Error("AI yanıtı verilemedi.");
  const data = await response.json();
  const content = data.content.filter((c: { type: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("");
  return content;
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, ChatSchema);
    const { leadId, message, conversationId } = input;

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");

    const language = getLeadLanguage(lead);
    const localization = LOCALIZATION[language as keyof typeof LOCALIZATION] ?? LOCALIZATION.TR;
    const isUrgent = detectUrgent(message);

    let conversation = null;
    if (conversationId) {
      conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, leadId },
      });
    }
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          leadId,
          workspaceId: actor.workspaceId,
          channel: mapChannel(lead.channel) as MessageChannel,
          initiatedBy: "bot",
        },
      });
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "INCOMING",
        channel: conversation.channel,
        content: message,
        sender: actor.userId,
      },
    });

    if (isUrgent) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "ESCALATED", escalatedTo: actor.userId, escalatedAt: new Date() },
      });
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: "OUTGOING",
          channel: conversation.channel,
          content: "Durum acil görünüyor. Bir koordinatöre devredilmektedir. Lütfen bekleyiniz.",
          sender: "bot",
        },
      });
      return { messages: [message], escalated: true };
    }

    const started = Date.now();
    loadEnv();
    const key = process.env.ANTHROPIC_API_KEY;
    const model = process.env.LLM_MODEL;
    if (!key || !model)
      throw new HttpError(
        503,
        "AI için ANTHROPIC_API_KEY ve LLM_MODEL sunucuda ayarlanmalı.",
      );

    const chatSystemPrompt = `${SYSTEM_PROMPT}\n\n${localization}\n\nMevcut durum:\n- Lead adı: ${lead.firstName} ${lead.lastName}\n- Dil: ${lead.language}\n- Kanal: ${lead.channel}`;

    const botResponse = await generateChatText(chatSystemPrompt, message, key, model);

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTGOING",
        channel: conversation.channel,
        content: botResponse,
        sender: "bot",
      },
    });

    await prisma.llmCallLog.create({
      data: {
        workspaceId: actor.workspaceId,
        agent: "lead-assistant",
        model,
        promptVersion: PROMPT_VERSION,
        status: "SUCCESS",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - started,
      },
    });

    return { messages: [message, botResponse], escalated: false };
  });
}
