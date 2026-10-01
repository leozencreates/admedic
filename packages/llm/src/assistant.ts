import { anthropicMessages, type AnthropicMessage, type LlmConfigLike, type LlmUsage } from "./anthropic";
import { BRIEF_LANGUAGES, normalizeLanguageCode, type BriefLanguage } from "./languages";
import {
  LEAD_ASSISTANT_EXAMPLES_PROMPT_VERSION,
  LEAD_ASSISTANT_PROMPT_VERSION,
  leadAssistantPromptVersion,
  leadAssistantSystemPrompt,
  type LeadAssistantContext,
} from "../prompts/lead-assistant-v1";

export { LEAD_ASSISTANT_EXAMPLES_PROMPT_VERSION, LEAD_ASSISTANT_PROMPT_VERSION, leadAssistantPromptVersion };
export type { LeadAssistantContext };

// ------------------------------------------------ Devir (handoff) tespiti ------------------------------------------------

export type HandoffReason = "emergency" | "human" | "out_of_scope";
export interface HandoffDetection {
  reason: HandoffReason | null;
  /** Eşleşen anahtar ifade (loglanmaz; test/teşhis için). */
  matched: string | null;
}

/**
 * Anahtar ifade sözlüğü. Sondaki `*` sözcük ekine izin verir ("acil*" → acilen, acildir);
 * eşleşme daima sözcük sınırında başlar ("send it" → "end it" DEĞİL, "bölüm" → "ölüm" DEĞİL).
 */
type Dictionary = Record<BriefLanguage, string[]>;

const EMERGENCY: Dictionary = {
  TR: ["acil*", "nefes alamıyorum", "kanama*", "kanıyor", "bayıl*", "ölüyorum", "intihar*", "kalp krizi"],
  EN: ["urgent*", "emergency", "can't breathe", "cannot breathe", "bleeding", "dying", "suicide", "kill myself", "want to die", "chest pain", "unconscious"],
  DE: ["dringend*", "notfall*", "blutung*", "ich sterbe", "kann nicht atmen", "selbstmord*", "bewusstlos"],
  RU: ["срочно", "срочн*", "скорая", "скорую", "кровотечени*", "не могу дышать", "умираю", "суицид*", "самоубийств*"],
  AR: ["عاجل*", "طوارئ", "الطوارئ", "نزيف*", "لا أستطيع التنفس", "أموت", "انتحار*", "اسعاف", "إسعاف", "الإسعاف"],
  FR: ["urgent*", "urgence*", "saignement*", "je ne peux pas respirer", "je meurs", "suicide*"],
  NL: ["dringend*", "spoed*", "noodgeval*", "bloeding*", "kan niet ademen", "zelfmoord*"],
  PL: ["pilne", "piln*", "nagły wypadek", "nagly wypadek", "krwawieni*", "nie mogę oddychać", "umieram", "samobójstw*"],
};

const HUMAN: Dictionary = {
  TR: ["insan*", "koordinatör*", "koordinator*", "gerçek kişi*", "gerçek biri*", "temsilci*", "yetkili*", "operatör*", "biriyle konuş*", "birisiyle konuş*"],
  EN: ["human*", "real person", "coordinator*", "representative*", "operator*", "speak to someone", "talk to someone", "talk to a person", "speak with someone"],
  DE: ["mensch*", "echte person", "echten menschen", "mitarbeiter*", "berater*", "koordinator*"],
  RU: ["человек*", "живой человек", "живым человеком", "оператор*", "сотрудник*", "координатор*", "менеджер*"],
  AR: ["إنسان", "شخص حقيقي", "موظف*", "منسق*", "مندوب*", "بشري"],
  FR: ["humain*", "vraie personne", "conseiller*", "conseillère*", "coordinateur*", "coordinatrice*", "opérateur*"],
  NL: ["mens", "echt persoon", "echte persoon", "medewerker*", "coördinator*", "coordinator*"],
  PL: ["człowiek*", "prawdziwa osoba", "prawdziwą osobą", "konsultant*", "koordynator*", "pracownik*"],
};

const OUT_OF_SCOPE: Dictionary = {
  TR: ["fiyat*", "ücret*", "kaç para", "kaça", "ne kadar tutar", "maliyet*", "uygun muyum", "bana uygun mu", "teşhis*", "tanı koy*"],
  EN: ["price*", "pricing", "cost", "costs", "how much does it cost", "how much is", "how much would", "how much for", "fee", "fees", "am i suitable", "am i a candidate", "am i eligible", "diagnos*"],
  DE: ["preis*", "kosten", "kostet", "wie teuer", "gebühr*", "geeignet", "diagnose*", "diagnostiz*"],
  RU: ["цена", "цены", "стоимость", "сколько стоит", "стоит ли", "подхожу ли", "подойдет ли", "подойдёт ли", "диагноз*"],
  AR: ["سعر*", "السعر", "أسعار", "الأسعار", "تكلفة", "التكلفة", "كم يكلف", "بكم", "هل أنا مناسب", "تشخيص*", "التشخيص"],
  FR: ["prix", "coût*", "cout*", "combien ça coûte", "combien coûte", "tarif*", "suis-je éligible", "suis-je un bon candidat", "diagnostic*"],
  NL: ["prijs", "prijzen", "kosten", "kost het", "hoeveel kost", "tarief*", "geschikt", "diagnose*"],
  PL: ["cena", "ceny", "cennik", "koszt*", "ile kosztuje", "ile to kosztuje", "czy się nadaję", "czy sie nadaje", "diagnoz*"],
};

function foldText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("tr").replace(/ı/g, "i").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(entry: string): RegExp {
  const suffix = entry.endsWith("*");
  const phrase = foldText(suffix ? entry.slice(0, -1) : entry);
  const body = phrase.split(" ").map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${suffix ? "\\p{L}*" : ""}(?![\\p{L}\\p{N}])`, "u");
}

const COMPILED: Record<HandoffReason, Record<BriefLanguage, Array<{ entry: string; pattern: RegExp }>>> = {
  emergency: compileDictionary(EMERGENCY),
  human: compileDictionary(HUMAN),
  out_of_scope: compileDictionary(OUT_OF_SCOPE),
};

function compileDictionary(dictionary: Dictionary) {
  const out = {} as Record<BriefLanguage, Array<{ entry: string; pattern: RegExp }>>;
  for (const language of BRIEF_LANGUAGES)
    out[language] = dictionary[language].map((entry) => ({ entry, pattern: compile(entry) }));
  return out;
}

/**
 * Lead metninde devir gerektiren durumu bulur (spec 3.8): acil durum > insan isteği >
 * kapsam dışı (fiyat, tıbbi uygunluk/teşhis). Tüm dil listeleri taranır; `lang`
 * yalnızca o dilin listesini öne alır (eşleşen ifade lead dilinden raporlanır).
 */
export function detectHandoff(text: string, lang?: string | null): HandoffDetection {
  const folded = foldText(text ?? "");
  if (!folded) return { reason: null, matched: null };
  const primary = normalizeLanguageCode(lang, "TR");
  const languages: BriefLanguage[] = [primary, ...BRIEF_LANGUAGES.filter((l) => l !== primary)];
  for (const reason of ["emergency", "human", "out_of_scope"] as const) {
    for (const language of languages) {
      for (const { entry, pattern } of COMPILED[reason][language]) {
        if (pattern.test(folded)) return { reason, matched: entry };
      }
    }
  }
  return { reason: null, matched: null };
}

/** Lead'e kendi dilinde gönderilen kısa devir bilgilendirmesi (otomatik asistan susar). */
export const HANDOFF_NOTICE: Record<BriefLanguage, { human: string; emergency: string }> = {
  TR: {
    human: "Bu konuda size bir hasta koordinatörü yardımcı olacak; kısa süre içinde sizinle iletişime geçecektir. Otomatik asistan bu konuşmada susuyor.",
    emergency: "Mesajınız bir hasta koordinatörüne iletildi. Acil bir sağlık durumu yaşıyorsanız lütfen hemen bulunduğunuz yerdeki acil yardım hizmetine başvurun.",
  },
  EN: {
    human: "A patient coordinator will help you with this and get back to you shortly. The automated assistant is now paused in this conversation.",
    emergency: "Your message has been forwarded to a patient coordinator. If this is a medical emergency, please contact your local emergency services immediately.",
  },
  DE: {
    human: "Ein Patientenkoordinator hilft Ihnen dabei und meldet sich in Kürze bei Ihnen. Der automatische Assistent ist in diesem Gespräch nun pausiert.",
    emergency: "Ihre Nachricht wurde an einen Patientenkoordinator weitergeleitet. Bei einem medizinischen Notfall wenden Sie sich bitte sofort an den örtlichen Notdienst.",
  },
  RU: {
    human: "Координатор пациентов поможет вам с этим и свяжется с вами в ближайшее время. Автоматический ассистент в этом разговоре приостановлен.",
    emergency: "Ваше сообщение передано координатору пациентов. Если это неотложная медицинская ситуация, немедленно обратитесь в местную службу экстренной помощи.",
  },
  AR: {
    human: "سيساعدك منسق المرضى في هذا الأمر وسيتواصل معك قريباً. تم إيقاف المساعد الآلي في هذه المحادثة.",
    emergency: "تم تحويل رسالتك إلى منسق المرضى. إذا كانت حالتك طارئة، يرجى الاتصال فوراً بخدمة الطوارئ المحلية.",
  },
  FR: {
    human: "Un coordinateur patient va vous aider et vous recontactera sous peu. L'assistant automatique est maintenant en pause dans cette conversation.",
    emergency: "Votre message a été transmis à un coordinateur patient. En cas d'urgence médicale, contactez immédiatement les services d'urgence locaux.",
  },
  NL: {
    human: "Een patiëntcoördinator helpt u hiermee en neemt binnenkort contact met u op. De automatische assistent is in dit gesprek nu gepauzeerd.",
    emergency: "Uw bericht is doorgestuurd naar een patiëntcoördinator. Bij een medisch noodgeval neemt u onmiddellijk contact op met de lokale hulpdiensten.",
  },
  PL: {
    human: "Koordynator pacjenta pomoże Panu/Pani w tej sprawie i wkrótce się skontaktuje. Automatyczny asystent został wstrzymany w tej rozmowie.",
    emergency: "Pana/Pani wiadomość została przekazana koordynatorowi pacjenta. W nagłym przypadku medycznym proszę natychmiast skontaktować się z lokalnymi służbami ratunkowymi.",
  },
};

export function handoffNotice(language: string | null | undefined, reason: HandoffReason): string {
  const notice = HANDOFF_NOTICE[normalizeLanguageCode(language, "TR")];
  return reason === "emergency" ? notice.emergency : notice.human;
}

// ------------------------------------------------ Gizlilik yardımcıları ------------------------------------------------

const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
/** 7+ haneli, ayraçlı/ayraçsız telefon benzeri diziler (+90 532 123 45 67, 0049-151-1234567 …). */
const PHONE_PATTERN = /(?<![\p{L}\p{N}])\+?\d[\d\s().-]{5,}\d(?![\p{L}\p{N}])/gu;

/** Lead serbest metnindeki e-posta/telefonu maskeler; LLM promptuna PII girmez (spec 3.11). */
export function maskContact(text: string): string {
  return text
    .replace(EMAIL_PATTERN, "[e-posta]")
    .replace(PHONE_PATTERN, (match) => (match.replace(/\D/g, "").length >= 7 ? "[telefon]" : match));
}

/** Üslup örneği sınırları (ADR-0027): istem kısa kalsın, tek bir konuşma baskın olmasın. */
export const STYLE_EXAMPLE_LIMITS = { conversations: 3, repliesPerConversation: 4, charsPerReply: 400 } as const;

/** Ekibin bir konuşmada yazdığı yanıtlar ve o konuşmadaki hastanın adı/soyadı (maskelemek için). */
export interface RawTeamExample {
  replies: string[];
  names: string[];
}

function maskNames(text: string, names: string[]): string {
  let out = text;
  for (const name of names.flatMap((n) => n.split(/\s+/))) {
    const token = name.trim();
    // Çok kısa ya da yer tutucu adlar atlanır (yanlış eşleşme metni bozmasın).
    if (token.length < 3 || token.startsWith("[")) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?![\\p{L}\\p{N}])`, "giu"), "[ad]");
  }
  return out;
}

/**
 * Ham ekip yanıtlarını isteme girecek üslup örneklerine çevirir: hastanın adı `[ad]`, e-posta ve telefon
 * maskelenir; boş yanıtlar atılır, uzun yanıt kısaltılır, sınırlar uygulanır.
 */
export function toStyleExamples(raw: RawTeamExample[]): string[][] {
  return raw
    .slice(0, STYLE_EXAMPLE_LIMITS.conversations)
    .map((example) =>
      example.replies
        .map((reply) => maskContact(maskNames(reply, example.names)).replace(/\s+/g, " ").trim())
        .filter((reply) => reply.length > 0)
        .slice(0, STYLE_EXAMPLE_LIMITS.repliesPerConversation)
        .map((reply) =>
          reply.length > STYLE_EXAMPLE_LIMITS.charsPerReply ? `${reply.slice(0, STYLE_EXAMPLE_LIMITS.charsPerReply)}…` : reply,
        ),
    )
    .filter((replies) => replies.length > 0);
}

/** Takma kimlik: `sha256(orgId:leadId)` ilk 8 hex karakteri — DB anahtarı prompta girmez. */
export async function leadAlias(orgId: string, leadId: string): Promise<string> {
  const data = new TextEncoder().encode(`${orgId}:${leadId}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

// ------------------------------------------------ Yanıt üretimi ------------------------------------------------

export interface AssistantHistoryItem {
  role: "lead" | "assistant" | "team";
  text: string;
}

export interface AssistantReplyInput extends LeadAssistantContext {
  /** Kronolojik son mesajlar (en fazla 10; son öğe lead'in yanıtlanacak mesajı). */
  history: AssistantHistoryItem[];
}

export interface AssistantReply {
  text: string;
  usage: LlmUsage;
}

/** Yanıt uzunluğu WhatsApp (4096) ve Messenger (2000) sınırlarının altında tutulur. */
export const ASSISTANT_REPLY_LIMIT = 1800;
export const ASSISTANT_HISTORY_LIMIT = 10;

/** Geçmişi Anthropic mesaj dizisine çevirir: user/assistant sırayla, aynı roller birleştirilir, ilk mesaj user olur. */
export function toChatMessages(history: AssistantHistoryItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  for (const item of history.slice(-ASSISTANT_HISTORY_LIMIT)) {
    const role: AnthropicMessage["role"] = item.role === "lead" ? "user" : "assistant";
    const content = (role === "user" ? maskContact(item.text) : item.text).trim();
    if (!content) continue;
    if (messages.length === 0 && role === "assistant") continue;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n${content}`;
    else messages.push({ role, content });
  }
  return messages;
}

export interface ChatTextInput extends LlmConfigLike {
  system: string;
  messages: AnthropicMessage[];
  maxTokens?: number;
  transport?: typeof fetch;
}

/** Ham sohbet üretimi: metin + token kullanımı (LlmCallLog için). */
export async function generateChatText(input: ChatTextInput): Promise<AssistantReply> {
  const { text, usage } = await anthropicMessages({
    apiKey: input.apiKey,
    model: input.model,
    system: input.system,
    messages: input.messages,
    maxTokens: input.maxTokens ?? 800,
    transport: input.transport,
    errorMessage: "AI yanıtı verilemedi.",
  });
  return { text: text.replace(/^[\s"']+|[\s"']+$/g, ""), usage };
}

/**
 * Saf yanıt üretimi (web ve worker ortak): geçmiş + dil + klinik bağlamı + rıza metni →
 * lead'in dilinde kısa yanıt. Ad/telefon/e-posta prompta girmez (`alias`, `maskContact`).
 */
export async function buildAssistantReply(
  input: AssistantReplyInput,
  config: LlmConfigLike,
  transport?: typeof fetch,
): Promise<AssistantReply> {
  const messages = toChatMessages(input.history);
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") throw new Error("Yanıtlanacak gelen mesaj yok.");
  const reply = await generateChatText({
    ...config,
    system: leadAssistantSystemPrompt(input),
    messages,
    transport,
  });
  const text = reply.text.trim().slice(0, ASSISTANT_REPLY_LIMIT);
  if (!text) throw new Error("AI boş yanıt üretti.");
  return { text, usage: reply.usage };
}
