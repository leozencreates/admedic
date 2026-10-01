/**
 * Sesli asistan araç kaydı (ADR-0028 §1 "Tek kaynak"). Saf, izomorfik modül: tarayıcıdaki araç dağıtıcısı
 * (`runtime.ts`) ve ajan yapılandırmasını üreten eşitleme betiği aynı listeyi kullanır. Araç adları ElevenLabs'te
 * büyük/küçük harfe duyarlıdır ve ajan yapılandırmasıyla birebir aynı olmalıdır (`docs/elevenlabs-constraints.md`).
 *
 * Faz 2: yalnızca R0 (gezinme ve okuma). R1–R3 araçları Faz 3–4'te eklenir; R4 işlemleri (onay, silme, gizlilik,
 * harcama yetkisi, tavan, faturalama, OAuth, hasta mesajı) hiçbir zaman araç olmaz.
 *
 * Kural: hiçbir araç `workspaceId`/`orgId` almaz; kayıt kimliği yalnızca daha önceki bir okuma sonucundan gelen
 * kısa ref'tir (`ref-map.ts`). Rol listesi yalnızca araç listesini sadeleştirir; yetki her API ucunda yeniden denetlenir.
 */
import type { Role } from "@admedic/database";
import { z } from "zod";
import { NAV_ITEMS } from "../nav-tree";
import { riskAllowedFor, type AssistantRisk } from "./events";

export type { AssistantRisk } from "./events";

const ALL: readonly Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST", "VIEWER"];
const MANAGE: readonly Role[] = ["OWNER", "ADMIN"];
const EDIT: readonly Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER"];
/** `auth.ts` LEAD_READ_ROLES ile aynı (sunucu modülü içe aktarılmaz). */
const LEAD_READ: readonly Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST"];
/** Menüde Kampanyalar'ı görenler (`nav-tree.ts` READ_ADS). */
const READ_ADS: readonly Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "ANALYST", "VIEWER"];
/** `alert-scope.ts`: izleyici uyarı görmez (uç 403 döner). */
const ALERT_READ: readonly Role[] = ALL.filter((r) => r !== "VIEWER");

/** Menü yolu → sayfa anahtarı (`/` → `overview`, `/campaign-planner` → `campaign-planner`). */
export function pageKeyForHref(href: string): string {
  return href === "/" ? "overview" : href.replace(/^\//, "");
}

/** Gezinilebilir sayfa anahtarları (menü ağacının tamamı; rol süzgeci çalışma anında `navTreeFor` ile). */
export const PAGE_KEYS = NAV_ITEMS.map((item) => pageKeyForHref(item.href)) as [string, ...string[]];

export const CAMPAIGN_TABS = ["overview", "content", "publish", "performance", "decisions"] as const;
export const CAMPAIGN_WORKFLOW_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "PUBLISHED_PAUSED",
  "ACTIVE",
  "ARCHIVED",
] as const;
export const ALERT_STATUSES = ["OPEN", "ACKED", "RESOLVED"] as const;
export const RECOMMENDATION_STATUSES = ["DRAFT", "PENDING", "APPROVED", "REJECTED", "APPLIED", "EXPIRED"] as const;

const Ref = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^[a-z][0-9]{1,5}$/)
    .describe(`${what} referansı (ör. "c1"); yalnızca daha önce bir okuma aracının döndürdüğü listeden.`);

const NoParams = z.object({}).strict();

export interface ToolDef<P extends z.AnyZodObject = z.AnyZodObject> {
  /** snake_case; ajan yapılandırmasıyla birebir aynı. */
  name: string;
  risk: AssistantRisk;
  /** `"auth"`: oturum açmış her rol. */
  requiredRoles: readonly Role[] | "auth";
  /** Ajan için Türkçe açıklama: ne zaman çağrılır, ne döner. */
  description: string;
  /** Sıkı (strict) Zod nesnesi; her alanın `.describe()` açıklaması olmalı (ElevenLabs parametre açıklaması). */
  parameters: P;
  /** `true`: konuşma aracın sonucunu bekler, sonuç LLM'e gider. */
  expectsResponse: boolean;
  /** ElevenLabs `response_timeout_secs` (1–120, varsayılan 20). */
  responseTimeoutSecs?: number;
  /**
   * Aracın çağırabileceği API uçları (`"GET /api/campaigns/:id"`). Denetim testi (assistant-approval) bu listeyi ve
   * gerçek çağrıları yasak uçlarla karşılaştırır. Gezinme araçlarında boştur.
   */
  endpoints: readonly string[];
}

function tool<P extends z.AnyZodObject>(def: ToolDef<P>): ToolDef<P> {
  return def;
}

export const ASSISTANT_TOOLS = [
  // ---------------------------------------------------------------- Gezinme (R0)
  tool({
    name: "navigate_to",
    risk: "R0",
    requiredRoles: "auth",
    description:
      "Paneldeki bir sayfayı açar. Yalnızca kullanıcının menüsünde görünen sayfalar açılabilir; menüde olmayan sayfa için kullanıcıya erişimi olmadığını söyle.",
    parameters: z
      .object({ pageKey: z.enum(PAGE_KEYS).describe("Açılacak sayfanın anahtarı (menüdeki sayfalardan biri).") })
      .strict(),
    expectsResponse: true,
    endpoints: [],
  }),
  tool({
    name: "open_campaign",
    risk: "R0",
    requiredRoles: READ_ADS,
    description:
      "Bir kampanyanın sayfasını açar; isteğe bağlı olarak bir sekmesini (genel, içerik, yükleme, performans, kararlar). Ref'i list_campaigns sonucundan al.",
    parameters: z
      .object({
        ref: Ref("Kampanya"),
        tab: z.enum(CAMPAIGN_TABS).optional().describe("Açılacak sekme; verilmezse genel bakış."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: [],
  }),
  tool({
    name: "open_lead",
    risk: "R0",
    requiredRoles: LEAD_READ,
    description:
      "Bir lead'in kayıt sayfasını açar. Ref'i get_lead_stats sonucundan al. Lead'i adıyla arama; ad bilinmiyorsa open_lead_search kullan.",
    parameters: z.object({ ref: Ref("Lead") }).strict(),
    expectsResponse: true,
    endpoints: [],
  }),
  tool({
    name: "open_new_campaign_planner",
    risk: "R0",
    requiredRoles: EDIT,
    description: "Yeni kampanya planlayıcısını açar. Kampanya oluşturmaz; kullanıcı formu kendisi doldurur.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: [],
  }),
  tool({
    name: "open_lead_search",
    risk: "R0",
    requiredRoles: LEAD_READ,
    description:
      "Lead arama kutusunu açar. Aranacak metni kullanıcı kendisi yazar; sen ad, telefon ya da e-posta ile arama yapma.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: [],
  }),
  tool({
    name: "open_approvals",
    risk: "R0",
    requiredRoles: EDIT,
    description:
      "Onaylar sayfasını açar. Onay ve ret sesle yapılmaz; kullanıcı onayı bu sayfada kendisi verir.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: [],
  }),
  tool({
    name: "stop_assistant",
    risk: "R0",
    requiredRoles: "auth",
    description: "Kullanıcı konuşmayı bitirmek istediğinde (\"kapat\", \"teşekkürler, bu kadar\") oturumu kapatır.",
    parameters: NoParams,
    expectsResponse: false,
    endpoints: [],
  }),
  // ---------------------------------------------------------------- Okuma (R0)
  tool({
    name: "get_today_summary",
    risk: "R0",
    requiredRoles: "auth",
    description:
      "Bugünün özeti: bekleyen onay sayısı, yanıt bekleyen lead sayısı, açık uyarı sayısı ve son bildirim başlıkları.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: ["GET /api/shell"],
  }),
  tool({
    name: "list_campaigns",
    risk: "R0",
    requiredRoles: "auth",
    description:
      "Kampanyaları listeler (en yeni 10) ve iş akışı durumuna göre toplamları verir. Her kampanyanın ref'i sonraki araçlarda kullanılır.",
    parameters: z
      .object({
        workflowStatus: z
          .enum(CAMPAIGN_WORKFLOW_STATUSES)
          .optional()
          .describe("İsteğe bağlı süzgeç: DRAFT, IN_REVIEW, APPROVED, REJECTED, PUBLISHED_PAUSED, ACTIVE, ARCHIVED."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: ["GET /api/campaigns"],
  }),
  tool({
    name: "get_campaign",
    risk: "R0",
    requiredRoles: "auth",
    description:
      "Tek kampanyanın ayrıntısı: durum, günlük bütçe, 7 ve 30 günlük performans, hazırlık ve Meta incelemesi, son ajan kararları.",
    parameters: z.object({ ref: Ref("Kampanya") }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/campaigns/:id"],
  }),
  tool({
    name: "get_insights",
    risk: "R0",
    requiredRoles: "auth",
    description:
      "Son 30 günün performans özeti: harcama, gösterim, tıklama, CTR, CPM, lead, CPL, nitelikli lead oranı, kampanya, ülke ve dil kırılımı.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: ["GET /api/insights"],
  }),
  tool({
    name: "get_weekly_report_summary",
    risk: "R0",
    requiredRoles: "auth",
    description: "Son tamamlanan haftanın rapor özeti: harcama, tıklama, CTR, CPL, yeni ve nitelikli lead, uyarılar.",
    parameters: NoParams,
    expectsResponse: true,
    responseTimeoutSecs: 30,
    endpoints: ["GET /api/reports/weekly"],
  }),
  tool({
    name: "list_alerts",
    risk: "R0",
    requiredRoles: ALERT_READ,
    description: "Uyarıları listeler (en yeni 10) ve önem derecesine göre toplamları verir. Varsayılan: açık uyarılar.",
    parameters: z
      .object({
        status: z.enum(ALERT_STATUSES).optional().describe("OPEN (açık, varsayılan), ACKED (görüldü) ya da RESOLVED (çözüldü)."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: ["GET /api/alerts"],
  }),
  tool({
    name: "list_recommendations",
    risk: "R0",
    requiredRoles: "auth",
    description:
      "A/B testlerinden üretilen önerileri listeler (en yeni 10). Onaylama ve uygulama sesle yapılmaz; kullanıcıyı Onaylar ya da Öneriler sayfasına yönlendir.",
    parameters: z
      .object({
        status: z
          .enum(RECOMMENDATION_STATUSES)
          .optional()
          .describe("İsteğe bağlı süzgeç: DRAFT, PENDING, APPROVED, REJECTED, APPLIED, EXPIRED."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: ["GET /api/recommendations"],
  }),
  tool({
    name: "list_decisions",
    risk: "R0",
    requiredRoles: "auth",
    description: "Optimizasyon ajanının son kararlarını listeler (en yeni 10): eylem, onay durumu, bütçe değişimi, gerekçe.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: ["GET /api/decisions"],
  }),
  tool({
    name: "get_policy_status",
    risk: "R0",
    requiredRoles: "auth",
    description:
      "Optimizasyon politikası ve bütçe sınırları: ajan modu, hedef, artış/azalış sınırları, hesap tavanları, etkin kural sayısı.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: ["GET /api/policies"],
  }),
  tool({
    name: "get_lead_stats",
    risk: "R0",
    requiredRoles: LEAD_READ,
    description:
      "Lead sayıları: duruma, kanala, ülkeye ve dile göre dağılım, yanıt bekleyen sayısı ve en yeni 10 lead'in ref'i ile durumu. İsim, iletişim bilgisi ve mesaj içeriği dönmez.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: ["GET /api/leads"],
  }),
  tool({
    name: "pending_leads_count",
    risk: "R0",
    requiredRoles: "auth",
    description: "Alanları Meta'dan henüz çekilemeyen (bekleyen) Lead Ads lead'lerinin sayısı.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: ["GET /api/leads/refetch"],
  }),
  tool({
    name: "get_subscription",
    risk: "R0",
    requiredRoles: MANAGE,
    description:
      "Abonelik planı ve durumu (dönem sonu, iptal planı). Plan değişikliği ve ödeme sesle yapılmaz; Faturalar sayfasına yönlendir.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: ["GET /api/billing/subscription"],
  }),
] as const satisfies readonly ToolDef[];

export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number]["name"];

export function findTool(name: string): ToolDef | undefined {
  return (ASSISTANT_TOOLS as readonly ToolDef[]).find((t) => t.name === name);
}

/** Rolün (ve harcama yetkisinin) kullanabileceği araçlar. Yalnızca arayüz katmanıdır; sunucu yine denetler. */
export function toolsFor(role: Role, canApproveSpend: boolean): ToolDef[] {
  return (ASSISTANT_TOOLS as readonly ToolDef[]).filter(
    (t) => (t.requiredRoles === "auth" || t.requiredRoles.includes(role)) && riskAllowedFor(t.risk, role, canApproveSpend),
  );
}

// ---------------------------------------------------------------- ElevenLabs istemci aracı yapılandırması

/** ElevenLabs `LiteralJsonSchemaProperty` (OpenAPI, 2026-10-01). */
export interface ElevenLabsLiteralProperty {
  type: "string" | "number" | "integer" | "boolean";
  description: string;
  enum?: string[];
}

/** ElevenLabs `ObjectJsonSchemaProperty`. */
export interface ElevenLabsObjectSchema {
  type: "object";
  description?: string;
  properties: Record<string, ElevenLabsLiteralProperty>;
  required: string[];
}

/** ElevenLabs `ClientToolConfig` (`POST /v1/convai/tools` → `tool_config`). */
export interface ElevenLabsClientToolConfig {
  type: "client";
  name: string;
  description: string;
  parameters?: ElevenLabsObjectSchema;
  expects_response: boolean;
  response_timeout_secs: number;
}

function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; description?: string } {
  let current = schema;
  let optional = false;
  let description = schema.description;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      optional = true;
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      optional = true;
      current = current.removeDefault();
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType();
    } else break;
    description ??= current.description;
  }
  return { inner: current, optional, description: description ?? current.description };
}

function literalProperty(toolName: string, key: string, schema: z.ZodTypeAny): { prop: ElevenLabsLiteralProperty; optional: boolean } {
  const { inner, optional, description } = unwrap(schema);
  if (!description) throw new Error(`${toolName}.${key}: parametre açıklaması (.describe) eksik.`);
  if (inner instanceof z.ZodString) return { prop: { type: "string", description }, optional };
  if (inner instanceof z.ZodEnum) return { prop: { type: "string", description, enum: [...inner.options] as string[] }, optional };
  if (inner instanceof z.ZodNumber)
    return { prop: { type: inner.isInt ? "integer" : "number", description }, optional };
  if (inner instanceof z.ZodBoolean) return { prop: { type: "boolean", description }, optional };
  throw new Error(`${toolName}.${key}: desteklenmeyen parametre türü.`);
}

/** Zod parametre şemasını ElevenLabs JSON şemasına çevirir; parametresiz araçta `undefined`. */
export function toElevenLabsParameters(def: ToolDef): ElevenLabsObjectSchema | undefined {
  const shape = def.parameters.shape as Record<string, z.ZodTypeAny>;
  const keys = Object.keys(shape);
  if (!keys.length) return undefined;
  const properties: Record<string, ElevenLabsLiteralProperty> = {};
  const required: string[] = [];
  for (const key of keys) {
    const { prop, optional } = literalProperty(def.name, key, shape[key]);
    properties[key] = prop;
    if (!optional) required.push(key);
  }
  return { type: "object", properties, required };
}

/** Kayıttaki araçlar → ElevenLabs istemci aracı yapılandırmaları (eşitleme betiği için). */
export function toElevenLabsToolConfigs(tools: readonly ToolDef[] = ASSISTANT_TOOLS): ElevenLabsClientToolConfig[] {
  return tools.map((def) => {
    const parameters = toElevenLabsParameters(def);
    return {
      type: "client",
      name: def.name,
      description: def.description,
      ...(parameters ? { parameters } : {}),
      expects_response: def.expectsResponse,
      response_timeout_secs: def.responseTimeoutSecs ?? 20,
    };
  });
}
