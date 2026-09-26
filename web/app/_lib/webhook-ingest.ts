import { prisma, Prisma } from "@admedic/database";
import { getLlmConfig, loadEnv } from "@admedic/config";
import {
  MetaGraphError,
  getLeadgenData,
  getLeadgenDataMock,
  normalizeLeadgenFields,
  type MetaLeadgenData,
  type NormalizedLeadFields,
} from "@admedic/meta-api";
import { generateGreeting, type GreetingLanguageCode } from "@admedic/llm";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { encrypt, tryDecryptField } from "./encrypt";
import { leadLookupHash, normalizePhone } from "./lead-hash";
import { sendWhatsAppMessage, normalizeTemplateName } from "./whatsapp";
import { resolveWhatsAppTransport } from "./whatsapp-tenant";
import { sendMessengerMessage } from "./messenger";

/**
 * Meta webhook alımı (Lead Ads, Messenger, Instagram DM, WhatsApp Cloud API).
 *
 * Payload biçimleri (2026-09-26, bkz. docs/meta-constraints.md):
 * - Lead Ads:   { object:"page", entry:[{ id:<page_id>, changes:[{ field:"leadgen", value:{ leadgen_id, page_id, form_id, ad_id, adgroup_id, created_time } }] }] }
 * - Messenger:  { object:"page", entry:[{ id:<page_id>, messaging:[{ sender:{id}, recipient:{id}, timestamp, message:{ mid, text, attachments?, referral? } }] }] }
 * - Instagram:  { object:"instagram", entry:[{ id:<ig_id>, messaging:[…] }] }
 * - WhatsApp:   { object:"whatsapp_business_account", entry:[{ id:<waba_id>, changes:[{ field:"messages", value:{ metadata:{ phone_number_id }, contacts:[…], messages:[…] | statuses:[…] } }] }] }
 *
 * İlkeler: imza doğrulaması route'ta (fail-closed); burada tenant çözümü,
 * idempotent yazım (Message.externalId / Lead.leadgenId), PII yalnızca şifreli
 * sütunlarda ve kaynağa göre ilk karşılama (spec 3.8).
 */

export const WEBHOOK_LLM_TIMEOUT_MS = 20_000;
/** Toplu teslimatlarda LLM çağrılarının webhook'u 60 sn üzerine taşımaması için istek bütçesi. */
const REQUEST_LLM_BUDGET_MS = 40_000;
const GUEST_NAME = "Konuk";

// ------------------------------------------------ Env yardımcıları ------------------------------------------------

/**
 * Webhook imza gizli anahtarı: META_WEBHOOK_SECRET ?? META_APP_SECRET.
 * `loadEnv()` önbelleklidir; süreç ortamı önce okunur ki çalışma zamanında
 * (ve testlerde `vi.stubEnv` ile) değişen değer görülsün — `getLlmConfig` ile aynı yaklaşım.
 */
export function resolveWebhookSecret(): string | undefined {
  const direct = process.env.META_WEBHOOK_SECRET?.trim();
  if (direct) return direct;
  return loadEnv().metaWebhookSecret;
}

/** Abonelik doğrulama belirteci (hub.verify_token karşılığı). */
export function resolveVerifyToken(): string | undefined {
  // process.env'de açıkça tanımlıysa (boş dahil) o geçerlidir; boş → ayarlanmamış (503).
  // Yalnızca hiç tanımlı değilse .env üzerinden yüklenir.
  const direct = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (direct !== undefined) return direct.trim() || undefined;
  return loadEnv().META_WEBHOOK_VERIFY_TOKEN;
}

function resolveGreetingTemplate(): string | null {
  const raw = process.env.WHATSAPP_GREETING_TEMPLATE ?? loadEnv().WHATSAPP_GREETING_TEMPLATE ?? "";
  return normalizeTemplateName(raw);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Meta abonelik doğrulaması (GET): hub.mode=subscribe ve hub.verify_token eşleşirse
 * hub.challenge düz metin olarak döner; token env'de yoksa 503, eşleşmezse 403.
 */
export function handleWebhookVerification(params: URLSearchParams): Response {
  const expected = resolveVerifyToken();
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (!expected)
    return new Response("Webhook doğrulama belirteci (META_WEBHOOK_VERIFY_TOKEN) ayarlanmamış.", {
      status: 503,
      headers,
    });
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode === "subscribe" && token && constantTimeEquals(token, expected) && challenge !== null)
    return new Response(challenge, { status: 200, headers });
  return new Response("Webhook doğrulaması başarısız.", { status: 403, headers });
}

// ------------------------------------------------ Zod şemaları (esnek) ------------------------------------------------

/** Meta kimlikleri örneklerde sayı, gerçek teslimatlarda string gelebilir; ikisi de string'e çevrilir. */
const IdSchema = z.union([z.string(), z.number()]).transform((v) => String(v));
const StringishSchema = z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v));

const ReferralSchema = z
  .object({
    ref: z.string().optional(),
    ad_id: IdSchema.optional(),
    source: z.string().optional(),
    type: z.string().optional(),
    ads_context_data: z
      .object({
        ad_title: z.string().optional(),
        post_id: IdSchema.optional(),
        product_id: IdSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const MessengerEventSchema = z
  .object({
    sender: z.object({ id: IdSchema.optional() }).passthrough().optional(),
    recipient: z.object({ id: IdSchema.optional() }).passthrough().optional(),
    timestamp: z.number().optional(),
    message: z
      .object({
        mid: z.string().optional(),
        text: z.string().optional(),
        is_echo: z.boolean().optional(),
        attachments: z
          .array(z.object({ type: z.string().optional() }).passthrough())
          .optional(),
        referral: ReferralSchema.optional(),
      })
      .passthrough()
      .optional(),
    referral: ReferralSchema.optional(),
  })
  .passthrough();

const FieldDataSchema = z.array(
  z
    .object({
      name: z.string(),
      values: z.array(StringishSchema).optional().default([]),
    })
    .passthrough(),
);

const LeadgenValueSchema = z
  .object({
    leadgen_id: IdSchema,
    page_id: IdSchema.optional(),
    form_id: IdSchema.optional(),
    ad_id: IdSchema.optional(),
    adgroup_id: IdSchema.optional(),
    adset_id: IdSchema.optional(),
    campaign_id: IdSchema.optional(),
    created_time: z.union([z.number(), z.string()]).optional(),
    /** Test/geliştirme kolaylığı: alanlar webhook içinde gelirse Graph çağrısı yapılmaz. */
    field_data: FieldDataSchema.optional(),
    form_name: z.string().optional(),
  })
  .passthrough();

const PageEntrySchema = z
  .object({
    id: IdSchema,
    time: z.number().optional(),
    changes: z
      .array(z.object({ field: z.string().optional(), value: z.unknown().optional() }).passthrough())
      .optional(),
    messaging: z.array(z.unknown()).optional(),
  })
  .passthrough();

const PagePayloadSchema = z
  .object({
    object: z.enum(["page", "instagram"]),
    entry: z.array(PageEntrySchema),
  })
  .passthrough();

const WhatsAppReferralSchema = z
  .object({
    source_url: z.string().optional(),
    source_id: IdSchema.optional(),
    source_type: z.string().optional(),
    headline: z.string().optional(),
    body: z.string().optional(),
    media_type: z.string().optional(),
    ctwa_clid: z.string().optional(),
  })
  .passthrough();

const WhatsAppMessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(),
    text: z.object({ body: z.string().optional() }).passthrough().optional(),
    interactive: z
      .object({
        type: z.string().optional(),
        button_reply: z.object({ id: z.string().optional(), title: z.string().optional() }).passthrough().optional(),
        list_reply: z.object({ id: z.string().optional(), title: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    button: z.object({ text: z.string().optional(), payload: z.string().optional() }).passthrough().optional(),
    referral: WhatsAppReferralSchema.optional(),
  })
  .passthrough();

const WhatsAppValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z
      .object({
        display_phone_number: z.string().optional(),
        phone_number_id: IdSchema.optional(),
      })
      .passthrough()
      .optional(),
    contacts: z
      .array(
        z
          .object({
            profile: z.object({ name: z.string().optional() }).passthrough().optional(),
            wa_id: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    messages: z.array(z.unknown()).optional(),
    statuses: z.array(z.unknown()).optional(),
  })
  .passthrough();

const WhatsAppPayloadSchema = z
  .object({
    object: z.literal("whatsapp_business_account"),
    entry: z.array(
      z
        .object({
          id: IdSchema,
          changes: z
            .array(z.object({ field: z.string().optional(), value: z.unknown().optional() }).passthrough())
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

// ------------------------------------------------ Dil / ülke türetme ------------------------------------------------

type GreetingLang = "tr" | "en" | "de" | "ru" | "ar" | "fr" | "nl" | "pl";
const SUPPORTED_LANGS: GreetingLang[] = ["tr", "en", "de", "ru", "ar", "fr", "nl", "pl"];

/** Telefon ülke kodu → (ülke, dil). Uzun önekler önce denenir. */
const PHONE_PREFIXES: Array<{ prefix: string; country: string; language: GreetingLang }> = [
  { prefix: "966", country: "SA", language: "ar" },
  { prefix: "971", country: "AE", language: "ar" },
  { prefix: "90", country: "TR", language: "tr" },
  { prefix: "49", country: "DE", language: "de" },
  { prefix: "44", country: "GB", language: "en" },
  { prefix: "43", country: "AT", language: "de" },
  { prefix: "41", country: "CH", language: "de" },
  { prefix: "33", country: "FR", language: "fr" },
  { prefix: "31", country: "NL", language: "nl" },
  { prefix: "48", country: "PL", language: "pl" },
  { prefix: "76", country: "KZ", language: "ru" },
  { prefix: "77", country: "KZ", language: "ru" },
  { prefix: "7", country: "RU", language: "ru" },
  { prefix: "1", country: "US", language: "en" },
];

const COUNTRY_LANGUAGE: Record<string, GreetingLang> = {
  TR: "tr", DE: "de", AT: "de", CH: "de", GB: "en", UK: "en", US: "en", IE: "en",
  RU: "ru", KZ: "ru", BY: "ru", SA: "ar", AE: "ar", QA: "ar", KW: "ar", IQ: "ar", EG: "ar",
  FR: "fr", BE: "fr", NL: "nl", PL: "pl",
};

const COUNTRY_NAMES: Record<string, string> = {
  turkey: "TR", "türkiye": "TR", turkiye: "TR", germany: "DE", deutschland: "DE", almanya: "DE",
  "united kingdom": "GB", uk: "GB", england: "GB", "great britain": "GB", "birleşik krallık": "GB",
  russia: "RU", "russian federation": "RU", rusya: "RU", "россия": "RU", kazakhstan: "KZ", "казахстан": "KZ",
  "saudi arabia": "SA", "suudi arabistan": "SA", "united arab emirates": "AE", uae: "AE", bae: "AE",
  france: "FR", fransa: "FR", netherlands: "NL", "the netherlands": "NL", holland: "NL", hollanda: "NL",
  poland: "PL", polonya: "PL", "united states": "US", usa: "US", austria: "AT", avusturya: "AT",
  switzerland: "CH", "isviçre": "CH", isvicre: "CH",
};

/** Telefondan (E.164/serbest biçim) ülke kodu ve dili türetir; tanınmazsa null. */
export function inferFromPhone(phone: string | null | undefined): { country: string; language: GreetingLang } | null {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  for (const row of PHONE_PREFIXES) {
    if (digits.startsWith(row.prefix) && digits.length > row.prefix.length + 4)
      return { country: row.country, language: row.language };
  }
  return null;
}

/** Form "country" yanıtını ISO-2 koda indirger; bilinmeyen değerler null. */
export function normalizeCountry(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase() === "UK" ? "GB" : raw.toUpperCase();
  return COUNTRY_NAMES[raw.toLowerCase()] ?? null;
}

function languageForCountry(country: string | null): GreetingLang | null {
  return country ? (COUNTRY_LANGUAGE[country] ?? null) : null;
}

function asGreetingLang(value: string | null | undefined): GreetingLang | null {
  const code = (value ?? "").trim().toLowerCase().slice(0, 2);
  return (SUPPORTED_LANGS as string[]).includes(code) ? (code as GreetingLang) : null;
}

// ------------------------------------------------ Karşılama metinleri ------------------------------------------------

const DEFAULT_GREETING: Record<GreetingLang, string> = {
  tr: "Merhaba! Mesajınız için teşekkür ederiz. Size yardımcı olmak için buradayız; hangi tedaviyle ilgilendiğinizi ve size ulaşabileceğimiz uygun saati yazabilir misiniz?",
  en: "Hello! Thank you for your message. We're here to help — could you tell us which treatment you're interested in and when we can reach you?",
  de: "Hallo! Vielen Dank für Ihre Nachricht. Wir helfen Ihnen gern – für welche Behandlung interessieren Sie sich und wann können wir Sie erreichen?",
  ru: "Здравствуйте! Спасибо за ваше сообщение. Мы рады помочь — подскажите, какая процедура вас интересует и когда с вами удобно связаться?",
  ar: "مرحباً! شكراً لرسالتك. يسعدنا مساعدتك — ما هو العلاج الذي تهتم به ومتى يمكننا التواصل معك؟",
  fr: "Bonjour ! Merci pour votre message. Nous sommes là pour vous aider : quel traitement vous intéresse et quand pouvons-nous vous joindre ?",
  nl: "Hallo! Bedankt voor uw bericht. We helpen u graag: in welke behandeling bent u geïnteresseerd en wanneer kunnen we u bereiken?",
  pl: "Dzień dobry! Dziękujemy za wiadomość. Chętnie pomożemy — jakim zabiegiem jest Pan/Pani zainteresowany(a) i kiedy możemy się skontaktować?",
};

/** Spec 3.8: ilk mesajda bot olduğu MUTLAKA belirtilir (LLM üretse de sabit satır eklenir). */
export const BOT_DISCLOSURE: Record<GreetingLang, string> = {
  tr: "Bu mesaj otomatik bir asistan tarafından gönderilmiştir; bir hasta koordinatörü kısa süre içinde sizinle iletişime geçecektir.",
  en: "This message was sent by an automated assistant; a patient coordinator will get back to you shortly.",
  de: "Diese Nachricht wurde von einem automatischen Assistenten gesendet; ein Patientenkoordinator meldet sich in Kürze bei Ihnen.",
  ru: "Это сообщение отправлено автоматическим ассистентом; координатор пациентов свяжется с вами в ближайшее время.",
  ar: "تم إرسال هذه الرسالة بواسطة مساعد آلي؛ سيتواصل معك منسق المرضى قريباً.",
  fr: "Ce message a été envoyé par un assistant automatique ; un coordinateur patient vous recontactera sous peu.",
  nl: "Dit bericht is verzonden door een automatische assistent; een patiëntcoördinator neemt binnenkort contact met u op.",
  pl: "Ta wiadomość została wysłana przez automatycznego asystenta; koordynator pacjenta skontaktuje się z Panem/Panią wkrótce.",
};

export function composeGreeting(language: string, aiText: string | null): string {
  const lang = asGreetingLang(language) ?? "tr";
  const body = (aiText ?? "").trim() || DEFAULT_GREETING[lang];
  return `${body}\n\n${BOT_DISCLOSURE[lang]}`;
}

/** LLM karşılaması; anahtar yoksa, hata olursa ya da 20 sn'yi aşarsa null (sabit metne düşülür). */
async function generateAIGreeting(language: string, ctx: IngestContext): Promise<string | null> {
  const llm = getLlmConfig();
  if (!llm) return null;
  if (Date.now() + WEBHOOK_LLM_TIMEOUT_MS > ctx.llmDeadline) return null;
  const code = (asGreetingLang(language) ?? "tr").toUpperCase() as GreetingLanguageCode;
  const transport: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(WEBHOOK_LLM_TIMEOUT_MS) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), WEBHOOK_LLM_TIMEOUT_MS + 250);
  });
  const generation = generateGreeting(llm.apiKey, llm.model, code, transport);
  // Yarış zaman aşımıyla bitse bile geç gelen red "unhandled rejection" olmasın.
  generation.catch(() => undefined);
  try {
    return await Promise.race([generation, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ------------------------------------------------ Tenant çözümü ------------------------------------------------

type Platform = "messenger" | "instagram" | "whatsapp" | "lead_ads";

interface TenantContext {
  connectionId: string;
  orgId: string;
  workspaceId: string;
  tokenCiphertext: string | null;
  /** Webhook'un geldiği Meta kaynağı: page_id, ig_id ya da phone_number_id. */
  sourceId: string;
}

interface IngestContext {
  llmDeadline: number;
  tenants: Map<string, TenantContext | null>;
  languages: Map<string, string>;
}

const ROUTABLE_STATUSES: Prisma.MetaConnectionWhereInput["status"] = { in: ["CONNECTED", "DEGRADED"] };

async function resolveTenant(
  ctx: IngestContext,
  where: Prisma.MetaConnectionWhereInput,
  cacheKey: string,
  sourceId: string,
): Promise<TenantContext | null> {
  if (ctx.tenants.has(cacheKey)) return ctx.tenants.get(cacheKey) ?? null;
  // Aynı kimlik birden fazla organizasyonda kayıtlıysa (elle eşleme çakışması / ele geçirme
  // girişimi) hiçbir tenant'a yazılmaz: fail-closed. OAuth ile keşfedilen PAGE kayıtları önceliklidir.
  const candidates = await prisma.metaConnection.findMany({
    where: { ...where, status: ROUTABLE_STATUSES },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    select: { id: true, orgId: true, tokenCiphertext: true, type: true },
    take: 10,
  });
  const orgIds = new Set(candidates.map((c) => c.orgId));
  let connection: (typeof candidates)[number] | null = candidates.find((c) => c.type === "PAGE") ?? candidates[0] ?? null;
  if (orgIds.size > 1) {
    console.warn(`[webhook] kaynak kimliği ${orgIds.size} farklı organizasyonda kayıtlı; olay yok sayıldı.`);
    connection = null;
  }
  let tenant: TenantContext | null = null;
  if (connection) {
    const workspaceId = await resolveWorkspaceForConnection(connection);
    if (workspaceId)
      tenant = {
        connectionId: connection.id,
        orgId: connection.orgId,
        workspaceId,
        tokenCiphertext: connection.tokenCiphertext,
        sourceId,
      };
  }
  ctx.tenants.set(cacheKey, tenant);
  return tenant;
}

/**
 * Bağlantı bir AdAccount üzerinden workspace'e bağlıysa o workspace; değilse
 * org'un ilk (en eski) workspace'i.
 */
export async function resolveWorkspaceForConnection(connection: {
  id: string;
  orgId: string;
}): Promise<string | null> {
  const viaAccount = await prisma.adAccount.findFirst({
    where: { connectionId: connection.id, orgId: connection.orgId, workspaceId: { not: null } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { workspaceId: true },
  });
  if (viaAccount?.workspaceId) return viaAccount.workspaceId;
  const workspace = await prisma.workspace.findFirst({
    where: { orgId: connection.orgId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return workspace?.id ?? null;
}

/** Tenant'ın klinik dili (ClinicProfile.languages ilk elemanı); yoksa "tr". */
async function tenantDefaultLanguage(ctx: IngestContext, workspaceId: string): Promise<string> {
  const cached = ctx.languages.get(workspaceId);
  if (cached) return cached;
  const clinic = await prisma.clinicProfile.findFirst({
    where: { workspaceId, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { languages: true },
  });
  const first = clinic?.languages[0];
  const language = first ? first.toLowerCase() : "tr";
  ctx.languages.set(workspaceId, language);
  return language;
}

// ------------------------------------------------ Ortak yardımcılar ------------------------------------------------

type Outcome = "processed" | "duplicate" | "ignored";

/** Transaction içinde tekrar teslimat tespiti için kullanılan sinyal (rollback tetikler). */
class DuplicateEventError extends Error {
  constructor() {
    super("duplicate");
  }
}

function isUniqueViolation(error: unknown, column?: string): boolean {
  const e = error as { code?: unknown; meta?: { target?: unknown } } | null;
  if (!e || e.code !== "P2002") return false;
  if (!column) return true;
  const target = e.meta?.target;
  if (target === undefined || target === null) return true;
  const text = Array.isArray(target) ? target.join(",") : String(target);
  return text.includes(column);
}

/** Transaction ömürlü danışma kilidi: `$queryRaw` void döndüremediği için `$executeRaw` kullanılır. */
async function lockLeadIdentity(tx: Prisma.TransactionClient, orgId: string, hash: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${hash}))`;
}

function safeEncrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return encrypt(value);
  } catch {
    return null;
  }
}

function splitName(full: string | null | undefined): { first: string; last: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: GUEST_NAME, last: "" };
  return { first: parts[0]!.slice(0, 80), last: parts.slice(1).join(" ").slice(0, 120) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(value: Record<string, unknown>): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

const SERVICE_KEYS = ["interested_service", "service", "hizmet", "treatment", "treatment_name", "tedavi", "islem", "işlem"];

function inferInterestedService(answers: Record<string, string>): string | null {
  for (const key of SERVICE_KEYS) {
    const value = answers[key];
    if (value) return value.slice(0, 200);
  }
  for (const [key, value] of Object.entries(answers)) {
    if (/treatment|service|hizmet|tedavi|i[sş]lem|behandlung|procedure|процедур|لاج/i.test(key) && value)
      return value.slice(0, 200);
  }
  return null;
}

/** Gönderimi yarım kalmış (süreç çökmüş) yer tutucu bu süreden sonra yeniden denenebilir sayılır. */
const STALE_CLAIM_MS = 2 * 60_000;

/**
 * Karşılamayı "en fazla bir kez" kılan claim: konuşma başına danışma kilidi altında
 * karşılanmamış olduğu doğrulanır ve OUTGOING yer tutucu mesaj yazılır; eşzamanlı
 * teslimatlar bu yer tutucuyu görüp karşılama üretmez. Gönderim sonucu `finalizeOutgoing`
 * ile aynı satıra işlenir. Karşılanmışsa / bot devrede değilse null döner.
 */
async function claimGreeting(
  conversationId: string,
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM",
): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conversationId}), hashtext('greeting'))`;
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: { status: true, firstResponseAt: true },
    });
    if (!conversation || conversation.status !== "ACTIVE" || conversation.firstResponseAt) return null;
    const outgoing = await tx.message.findMany({
      where: { conversationId, direction: "OUTGOING" },
      select: { metadata: true, createdAt: true },
      take: 10,
    });
    const alreadyGreeted = outgoing.some((m) => {
      const meta = asRecord(m.metadata);
      if (meta.deliveryError) return false;
      if (meta.pendingSend === true && Date.now() - m.createdAt.getTime() > STALE_CLAIM_MS) return false;
      return true;
    });
    if (alreadyGreeted) return null;
    const placeholder = await tx.message.create({
      data: {
        conversationId,
        direction: "OUTGOING",
        channel,
        content: "(karşılama gönderiliyor…)",
        sender: "bot",
        metadata: json({ autoGreet: true, pendingSend: true }),
      },
      select: { id: true },
    });
    return placeholder.id;
  });
}

async function finalizeOutgoing(
  input: {
    messageId: string;
    conversationId: string;
    channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM";
    content: string;
    metadata: Record<string, unknown>;
    delivered: boolean;
    leadId: string;
    orgId: string;
    workspaceId: string;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const message = await tx.message.update({
      where: { id: input.messageId },
      data: { content: input.content, metadata: json(input.metadata) },
      select: { id: true },
    });
    if (input.delivered) {
      await tx.conversation.updateMany({
        where: { id: input.conversationId, firstResponseAt: null },
        data: { firstResponseAt: new Date() },
      });
    }
    const lead = await tx.lead.findUnique({ where: { id: input.leadId }, select: { metadata: true } });
    if (lead) {
      await tx.lead.update({
        where: { id: input.leadId },
        data: { metadata: json({ ...asRecord(lead.metadata), pendingGreeting: !input.delivered }) },
      });
    }
    await tx.auditLog.create({
      data: {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        userId: null,
        action: "AUTO_GREETING_SENT",
        entityType: "CONVERSATION",
        entityId: input.conversationId,
        after: json({
          channel: input.channel,
          messageId: message.id,
          delivered: input.delivered,
          template: (input.metadata.whatsappTemplate as string | null | undefined) ?? null,
        }),
      },
    });
  });
}

// ------------------------------------------------ Karşılama gönderimi ------------------------------------------------

interface GreetingTarget {
  tenant: TenantContext;
  leadId: string;
  conversationId: string;
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM";
  language: string;
  phone: string | null;
  psid: string | null;
}

/**
 * Gelen mesaja karşılık (24 saat penceresi içinde) serbest metin karşılama.
 * Konuşma zaten karşılanmışsa ya da bot devrede değilse (ESCALATED) hiçbir şey yapılmaz.
 */
async function sendConversationGreeting(ctx: IngestContext, target: GreetingTarget): Promise<void> {
  const messageId = await claimGreeting(target.conversationId, target.channel);
  if (!messageId) return;
  const aiText = await generateAIGreeting(target.language, ctx);
  const content = composeGreeting(target.language, aiText);
  const base: Record<string, unknown> = { autoGreet: true, source: aiText ? "ai" : "static" };
  const result =
    target.channel === "WHATSAPP"
      ? await sendWhatsAppMessage(
          { phone: target.phone, language: target.language, transport: await resolveWhatsAppTransport(target.tenant.orgId) },
          content,
        )
      : await sendMessengerMessage({
          orgId: target.tenant.orgId,
          channel: target.channel,
          psid: target.psid,
          pageId: target.tenant.sourceId,
          text: content,
        });
  const providerResult = { id: result.id ?? null, error: result.error ?? null };
  await finalizeOutgoing({
    messageId,
    conversationId: target.conversationId,
    channel: target.channel,
    content,
    delivered: !result.error,
    leadId: target.leadId,
    orgId: target.tenant.orgId,
    workspaceId: target.tenant.workspaceId,
    metadata: {
      ...base,
      ...(target.channel === "WHATSAPP" ? { whatsappResult: providerResult } : { messengerResult: providerResult }),
      ...(result.error ? { deliveryError: result.error } : {}),
    },
  });
}

/** Lead Ads: pencere dışı olduğumuz için yalnızca onaylı şablonla karşılama; şablon yoksa bekletilir. */
async function sendLeadAdGreeting(target: GreetingTarget): Promise<void> {
  const template = resolveGreetingTemplate();
  if (!template || !target.phone) return; // pendingGreeting lead metadata'sında zaten true
  const messageId = await claimGreeting(target.conversationId, "WHATSAPP");
  if (!messageId) return;
  const result = await sendWhatsAppMessage(
    { phone: target.phone, language: target.language, transport: await resolveWhatsAppTransport(target.tenant.orgId) },
    "",
    template,
    {},
  );
  await finalizeOutgoing({
    messageId,
    conversationId: target.conversationId,
    channel: "WHATSAPP",
    content: `(şablon karşılama: ${template})`,
    delivered: !result.error,
    leadId: target.leadId,
    orgId: target.tenant.orgId,
    workspaceId: target.tenant.workspaceId,
    metadata: {
      autoGreet: true,
      source: "template",
      whatsappTemplate: template,
      whatsappResult: { id: result.id ?? null, error: result.error ?? null },
      ...(result.error ? { deliveryError: result.error } : {}),
    },
  });
}

// ------------------------------------------------ Lead Ads ------------------------------------------------

type LeadgenValue = z.infer<typeof LeadgenValueSchema>;

const PERMANENT_GRAPH_ERRORS = new Set([100, 102, 104, 190, 200, 10]);

/** Lead verisini çözer: webhook içi field_data > mock > Graph. Kalıcı token hatası → null (stub lead). */
async function resolveLeadgenData(
  tenant: TenantContext,
  value: LeadgenValue,
): Promise<{ data: MetaLeadgenData | null; dataSource: "webhook" | "mock" | "graph"; fetchError: string | null }> {
  if (value.field_data && value.field_data.length > 0) {
    const fieldData = value.field_data.map((f) => ({ name: f.name, values: f.values }));
    return {
      dataSource: "webhook",
      fetchError: null,
      data: {
        id: value.leadgen_id,
        createdTime: value.created_time !== undefined ? String(value.created_time) : null,
        adId: value.ad_id ?? value.adgroup_id ?? null,
        adsetId: value.adset_id ?? null,
        campaignId: value.campaign_id ?? null,
        formId: value.form_id ?? null,
        isOrganic: null,
        platform: null,
        fieldData,
        normalized: normalizeLeadgenFields(fieldData),
      },
    };
  }
  if (loadEnv().META_MOCK_MODE) {
    return { data: getLeadgenDataMock(value.leadgen_id), dataSource: "mock", fetchError: null };
  }
  const token = tryDecryptField(tenant.tokenCiphertext);
  if (!token)
    return {
      data: null,
      dataSource: "graph",
      fetchError: "Sayfa erişim token'ı yok ya da çözülemedi; lead alanları Graph'tan çekilemedi.",
    };
  try {
    return { data: await getLeadgenData(value.leadgen_id, token), dataSource: "graph", fetchError: null };
  } catch (error) {
    if (error instanceof MetaGraphError && error.detail.code !== undefined && PERMANENT_GRAPH_ERRORS.has(error.detail.code)) {
      return { data: null, dataSource: "graph", fetchError: error.message.slice(0, 300) };
    }
    // Geçici hata (ağ, rate limit, 5xx): 5xx dönülür, Meta yeniden dener.
    throw error;
  }
}

async function ingestLeadgen(ctx: IngestContext, tenant: TenantContext, value: LeadgenValue): Promise<Outcome> {
  const leadgenId = value.leadgen_id;
  const already = await prisma.lead.findUnique({
    where: { organizationId_leadgenId: { organizationId: tenant.orgId, leadgenId } },
    select: { id: true },
  });
  if (already) return "duplicate";

  const resolved = await resolveLeadgenData(tenant, value);
  const normalized: NormalizedLeadFields = resolved.data?.normalized ?? {
    email: null,
    phone: null,
    fullName: null,
    firstName: null,
    lastName: null,
    country: null,
    city: null,
    answers: {},
  };
  const phone = normalized.phone;
  const email = normalized.email;
  const hash = leadLookupHash({ orgId: tenant.orgId, phone, email });
  const fromPhone = inferFromPhone(phone);
  const country = normalizeCountry(normalized.country) ?? fromPhone?.country ?? null;
  const language =
    asGreetingLang(normalized.answers.language) ??
    fromPhone?.language ??
    languageForCountry(country) ??
    (await tenantDefaultLanguage(ctx, tenant.workspaceId));
  const answers = { ...normalized.answers };
  delete answers.language;
  const name = normalized.firstName
    ? { first: normalized.firstName.slice(0, 80), last: (normalized.lastName ?? "").slice(0, 120) }
    : splitName(normalized.fullName);
  const adId = resolved.data?.adId ?? value.ad_id ?? value.adgroup_id ?? null;
  const adSetId = resolved.data?.adsetId ?? value.adset_id ?? null;
  const campaignId = resolved.data?.campaignId ?? value.campaign_id ?? null;

  const created = await prisma
    .$transaction(async (tx) => {
      // Aynı kişiden eşzamanlı teslimatlar (org, hash) kilidiyle sıralanır; ikincisi birinciyi görür.
      if (hash) await lockLeadIdentity(tx, tenant.orgId, hash);
      const primary = hash
        ? await tx.lead.findFirst({
            where: { organizationId: tenant.orgId, lookupHash: hash },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          })
        : null;
      let lead: { id: string };
      try {
        lead = await tx.lead.create({
          data: {
            workspaceId: tenant.workspaceId,
            organizationId: tenant.orgId,
            firstName: name.first || GUEST_NAME,
            lastName: name.last,
            email: safeEncrypt(email),
            phone: safeEncrypt(phone),
            country,
            language,
            channel: "LEAD_AD",
            interestedService: inferInterestedService(answers),
            campaignId,
            adSetId,
            adId,
            status: "NEW",
            lookupHash: primary ? null : hash,
            duplicateOf: primary?.id ?? null,
            leadgenId,
            metadata: json({
              source: "lead_ads",
              leadgen_id: leadgenId,
              page_id: value.page_id ?? tenant.sourceId,
              form_id: resolved.data?.formId ?? value.form_id ?? null,
              form_name: value.form_name ?? null,
              ad_id: adId,
              adgroup_id: value.adgroup_id ?? null,
              adset_id: adSetId,
              campaign_id: campaignId,
              created_time: resolved.data?.createdTime ?? (value.created_time !== undefined ? String(value.created_time) : null),
              platform: resolved.data?.platform ?? null,
              is_organic: resolved.data?.isOrganic ?? null,
              city: normalized.city,
              answers,
              data_source: resolved.dataSource,
              ...(resolved.fetchError ? { pendingFetch: true, fetchError: resolved.fetchError } : {}),
              pendingGreeting: true,
            }),
          },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueViolation(error, "leadgenId")) throw new DuplicateEventError();
        throw error;
      }
      await tx.auditLog.create({
        data: {
          orgId: tenant.orgId,
          workspaceId: tenant.workspaceId,
          userId: null,
          action: "LEAD_INGESTED",
          entityType: "LEAD",
          entityId: lead.id,
          after: json({ source: "lead_ads", leadgen_id: leadgenId, data_source: resolved.dataSource }),
        },
      });
      if (primary) {
        await tx.auditLog.create({
          data: {
            orgId: tenant.orgId,
            workspaceId: tenant.workspaceId,
            userId: null,
            action: "LEAD_DUPLICATE_MARKED",
            entityType: "LEAD",
            entityId: lead.id,
            after: json({ duplicateOf: primary.id, source: "lead_ads", leadgen_id: leadgenId }),
          },
        });
      }
      let conversationId: string | null = null;
      if (phone) {
        const conversation = await tx.conversation.create({
          data: {
            leadId: lead.id,
            workspaceId: tenant.workspaceId,
            channel: "WHATSAPP",
            status: "ACTIVE",
            initiatedBy: "bot",
          },
          select: { id: true },
        });
        conversationId = conversation.id;
      }
      return { leadId: lead.id, conversationId };
    })
    .catch((error: unknown) => {
      if (error instanceof DuplicateEventError) return null;
      throw error;
    });
  if (!created) return "duplicate";

  if (created.conversationId && phone) {
    await sendLeadAdGreeting({
      tenant,
      leadId: created.leadId,
      conversationId: created.conversationId,
      channel: "WHATSAPP",
      language,
      phone,
      psid: null,
    });
  }
  return "processed";
}

// ------------------------------------------------ Gelen mesajlar ------------------------------------------------

interface InboundMessage {
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM";
  platform: Platform;
  externalId: string;
  text: string | null;
  attachmentTypes: string[];
  /** Messenger/Instagram: sayfa kapsamlı kimlik. */
  psid: string | null;
  /** WhatsApp: gönderenin numarası (wa_id) — yalnızca şifreli sütuna yazılır. */
  phone: string | null;
  profileName: string | null;
  timestamp: number | null;
  adId: string | null;
  referral: Record<string, unknown> | null;
}

async function ingestInboundMessage(ctx: IngestContext, tenant: TenantContext, msg: InboundMessage): Promise<Outcome> {
  const already = await prisma.message.findUnique({
    where: { externalId: msg.externalId },
    select: { id: true },
  });
  if (already) return "duplicate";

  const hash = leadLookupHash({
    orgId: tenant.orgId,
    phone: msg.phone,
    psid: msg.psid,
    igId: msg.channel === "INSTAGRAM" ? msg.psid : undefined,
  });
  if (!hash) return "ignored";

  const fromPhone = inferFromPhone(msg.phone);
  const defaultLanguage = fromPhone?.language ?? (await tenantDefaultLanguage(ctx, tenant.workspaceId));
  const content =
    (msg.text ?? "").trim() ||
    (msg.attachmentTypes.length > 0 ? `(ek içerik: ${msg.attachmentTypes.join(", ")})` : "(ek içerik)");

  const result = await prisma
    .$transaction(async (tx) => {
      // Aynı gönderenden eşzamanlı mesajlar tek lead/konuşma üretsin diye (org, hash) kilidi.
      await lockLeadIdentity(tx, tenant.orgId, hash);
      let lead = await tx.lead.findFirst({
        where: { organizationId: tenant.orgId, lookupHash: hash },
        orderBy: { createdAt: "asc" },
        select: { id: true, language: true, phone: true, metadata: true, adId: true },
      });
      if (!lead) {
        const name = splitName(msg.profileName);
        lead = await tx.lead.create({
          data: {
            workspaceId: tenant.workspaceId,
            organizationId: tenant.orgId,
            firstName: name.first,
            lastName: name.last,
            phone: safeEncrypt(msg.phone),
            country: fromPhone?.country ?? null,
            language: defaultLanguage,
            channel: msg.channel,
            adId: msg.adId,
            status: "NEW",
            lookupHash: hash,
            metadata: json({
              source: "messaging",
              platform: msg.platform,
              ...(msg.psid ? { psid: msg.psid } : {}),
              ...(msg.channel === "WHATSAPP"
                ? { phone_number_id: tenant.sourceId }
                : { page_id: tenant.sourceId }),
              ...(msg.referral ? { referral: msg.referral } : {}),
            }),
          },
          select: { id: true, language: true, phone: true, metadata: true, adId: true },
        });
        await tx.auditLog.create({
          data: {
            orgId: tenant.orgId,
            workspaceId: tenant.workspaceId,
            userId: null,
            action: "LEAD_INGESTED",
            entityType: "LEAD",
            entityId: lead.id,
            after: json({ source: "messaging", platform: msg.platform, mid: msg.externalId }),
          },
        });
      }

      let conversation = await tx.conversation.findFirst({
        where: { leadId: lead.id, channel: msg.channel, status: { in: ["ACTIVE", "ESCALATED"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true },
      });
      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            leadId: lead.id,
            workspaceId: tenant.workspaceId,
            channel: msg.channel,
            status: "ACTIVE",
            initiatedBy: "bot",
          },
          select: { id: true, status: true },
        });
      }

      try {
        await tx.message.create({
          data: {
            conversationId: conversation.id,
            direction: "INCOMING",
            channel: msg.channel,
            content,
            sender: msg.psid ?? "external",
            externalId: msg.externalId,
            metadata: json({
              mid: msg.externalId,
              ...(msg.channel === "WHATSAPP" ? { wamid: msg.externalId } : {}),
              ...(msg.attachmentTypes.length > 0 ? { attachments: msg.attachmentTypes } : {}),
              ...(msg.referral ? { referral: msg.referral } : {}),
              ...(msg.timestamp !== null ? { timestamp: msg.timestamp } : {}),
            }),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error, "externalId")) throw new DuplicateEventError();
        throw error;
      }

      // Uyumluluk: son mesaj kimliği ve reklam ilişkisi lead üzerinde de tutulur.
      const leadMeta = asRecord(lead.metadata);
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          metadata: json({ ...leadMeta, mid: msg.externalId }),
          ...(!lead.adId && msg.adId ? { adId: msg.adId } : {}),
        },
      });
      return {
        leadId: lead.id,
        language: lead.language,
        phoneCiphertext: lead.phone,
        conversationId: conversation.id,
        conversationStatus: conversation.status,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof DuplicateEventError) return null;
      throw error;
    });
  if (!result) return "duplicate";

  // Karşılama yalnızca henüz karşılanmamış ACTIVE konuşmada (claim kontrol eder);
  // sonraki mesajlarda bot yanıtı üretilmez — o iş AI worker'ının (W7).
  if (result.conversationStatus === "ACTIVE") {
    await sendConversationGreeting(ctx, {
      tenant,
      leadId: result.leadId,
      conversationId: result.conversationId,
      channel: msg.channel,
      language: result.language,
      phone: msg.phone ?? tryDecryptField(result.phoneCiphertext),
      psid: msg.psid,
    });
  }
  return "processed";
}

// ------------------------------------------------ Payload işleme ------------------------------------------------

export interface WebhookIngestSummary {
  received: true;
  processed: number;
  duplicates: number;
  ignored: number;
  ignoredPages: number;
  duplicate?: true;
}

export interface WebhookIgnoredSummary {
  received: true;
  ignored: true;
  reason: "invalid_json" | "unknown_format";
}

function tally(summary: WebhookIngestSummary, outcome: Outcome) {
  if (outcome === "processed") summary.processed++;
  else if (outcome === "duplicate") summary.duplicates++;
  else summary.ignored++;
}

function referralAdId(referral: z.infer<typeof ReferralSchema> | undefined): string | null {
  return referral?.ad_id ?? null;
}

async function processPageEntry(
  ctx: IngestContext,
  summary: WebhookIngestSummary,
  entry: z.infer<typeof PageEntrySchema>,
  isInstagram: boolean,
): Promise<void> {
  const tenant = await resolveTenant(
    ctx,
    isInstagram ? { instaId: entry.id } : { pageId: entry.id },
    `${isInstagram ? "ig" : "page"}:${entry.id}`,
    entry.id,
  );
  if (!tenant) {
    summary.ignoredPages++;
    return;
  }

  for (const change of entry.changes ?? []) {
    const value = asRecord(change.value);
    const isLeadgen = change.field === "leadgen" || value.leadgen_id !== undefined;
    if (!isLeadgen || isInstagram) {
      summary.ignored++;
      continue;
    }
    const parsed = LeadgenValueSchema.safeParse(value);
    if (!parsed.success) {
      summary.ignored++;
      continue;
    }
    tally(summary, await ingestLeadgen(ctx, tenant, parsed.data));
  }

  for (const raw of entry.messaging ?? []) {
    const parsed = MessengerEventSchema.safeParse(raw);
    if (!parsed.success) {
      summary.ignored++;
      continue;
    }
    const event = parsed.data;
    const mid = event.message?.mid;
    // read / delivery / postback / referral-only olayları ve kendi mesajlarımızın yankısı (is_echo) yok sayılır.
    if (!event.message || !mid || event.message.is_echo) {
      summary.ignored++;
      continue;
    }
    const psid = event.sender?.id ?? null;
    if (!psid) {
      summary.ignored++;
      continue;
    }
    const referral = event.referral ?? event.message.referral;
    tally(
      summary,
      await ingestInboundMessage(ctx, tenant, {
        channel: isInstagram ? "INSTAGRAM" : "MESSENGER",
        platform: isInstagram ? "instagram" : "messenger",
        externalId: mid,
        text: event.message.text ?? null,
        attachmentTypes: (event.message.attachments ?? []).map((a) => a.type ?? "unknown"),
        psid,
        phone: null,
        profileName: null,
        timestamp: event.timestamp ?? null,
        adId: referralAdId(referral),
        referral: referral ? (referral as Record<string, unknown>) : null,
      }),
    );
  }
}

function whatsAppText(message: z.infer<typeof WhatsAppMessageSchema>): string | null {
  if (message.text?.body) return message.text.body;
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message.interactive?.list_reply?.title) return message.interactive.list_reply.title;
  if (message.button?.text) return message.button.text;
  return null;
}

const WHATSAPP_IGNORED_TYPES = new Set(["reaction", "system"]);

async function processWhatsAppEntry(
  ctx: IngestContext,
  summary: WebhookIngestSummary,
  entry: z.infer<typeof WhatsAppPayloadSchema>["entry"][number],
): Promise<void> {
  for (const change of entry.changes ?? []) {
    const parsed = WhatsAppValueSchema.safeParse(change.value);
    if (!parsed.success || (change.field !== undefined && change.field !== "messages")) {
      summary.ignored++;
      continue;
    }
    const value = parsed.data;
    const messages = value.messages ?? [];
    if (messages.length === 0) {
      // statuses (sent/delivered/read), errors vb. → kayıt yok, 200.
      summary.ignored++;
      continue;
    }
    const phoneNumberId = value.metadata?.phone_number_id ?? null;
    const tenant = phoneNumberId
      ? await resolveTenant(ctx, { whatsappPhoneNumberId: phoneNumberId }, `wa:${phoneNumberId}`, phoneNumberId)
      : null;
    const fallback =
      tenant ?? (await resolveTenant(ctx, { whatsappBusinessId: entry.id }, `waba:${entry.id}`, phoneNumberId ?? entry.id));
    if (!fallback) {
      summary.ignoredPages++;
      continue;
    }
    for (const raw of messages) {
      const message = WhatsAppMessageSchema.safeParse(raw);
      if (!message.success) {
        summary.ignored++;
        continue;
      }
      const m = message.data;
      if (m.type && WHATSAPP_IGNORED_TYPES.has(m.type)) {
        summary.ignored++;
        continue;
      }
      const contact = (value.contacts ?? []).find((c) => c.wa_id === m.from) ?? value.contacts?.[0];
      const text = whatsAppText(m);
      const attachmentTypes = !text && m.type && m.type !== "text" ? [m.type] : [];
      const ts = m.timestamp !== undefined ? Number(m.timestamp) : NaN;
      const referral = m.referral ? (m.referral as Record<string, unknown>) : null;
      tally(
        summary,
        await ingestInboundMessage(ctx, fallback, {
          channel: "WHATSAPP",
          platform: "whatsapp",
          externalId: m.id,
          text,
          attachmentTypes,
          psid: null,
          phone: m.from,
          profileName: contact?.profile?.name ?? null,
          timestamp: Number.isFinite(ts) ? ts : null,
          // Click-to-WhatsApp reklamı: referral.source_type "ad" ise source_id reklam kimliğidir.
          adId: m.referral?.source_type === "ad" ? (m.referral.source_id ?? null) : null,
          referral,
        }),
      );
    }
  }
}

/**
 * Doğrulanmış (imzası geçerli) ham gövdeyi işler. Bilinmeyen biçim ve geçersiz
 * JSON 200 `{ ignored: true }` ile karşılanır ki Meta gereksiz yeniden deneme yapmasın.
 */
export async function ingestMetaWebhook(rawBody: string): Promise<WebhookIngestSummary | WebhookIgnoredSummary> {
  let input: unknown;
  try {
    input = JSON.parse(rawBody);
  } catch {
    return { received: true, ignored: true, reason: "invalid_json" };
  }
  const ctx: IngestContext = {
    llmDeadline: Date.now() + REQUEST_LLM_BUDGET_MS,
    tenants: new Map(),
    languages: new Map(),
  };
  const summary: WebhookIngestSummary = { received: true, processed: 0, duplicates: 0, ignored: 0, ignoredPages: 0 };

  const page = PagePayloadSchema.safeParse(input);
  if (page.success) {
    const isInstagram = page.data.object === "instagram";
    for (const entry of page.data.entry) await processPageEntry(ctx, summary, entry, isInstagram);
  } else {
    const wa = WhatsAppPayloadSchema.safeParse(input);
    if (!wa.success) return { received: true, ignored: true, reason: "unknown_format" };
    for (const entry of wa.data.entry) await processWhatsAppEntry(ctx, summary, entry);
  }
  if (summary.duplicates > 0 && summary.processed === 0) summary.duplicate = true;
  return summary;
}
