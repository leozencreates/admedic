/**
 * Sesli asistan araç kaydı (ADR-0028 §1 "Tek kaynak"). Saf, izomorfik modül: tarayıcıdaki araç dağıtıcısı
 * (`runtime.ts`) ve ajan yapılandırmasını üreten eşitleme betiği aynı listeyi kullanır. Araç adları ElevenLabs'te
 * büyük/küçük harfe duyarlıdır ve ajan yapılandırmasıyla birebir aynı olmalıdır (`docs/elevenlabs-constraints.md`).
 *
 * Faz 2: R0 (gezinme ve okuma). Faz 3: R1 (iç yazma); her R1 aracı yalnızca bekleyen eylem oluşturur, işlem sözlü
 * "evet" (`confirm_pending_action`) ya da ekrandaki onayla bir kez çalışır (`pending.ts`). Faz 4: R2 (dış etki, harcama
 * yok) ve R3 (harcama başlatma/artırma) araçları da yalnızca bekleyen eylem oluşturur; bunlar **yalnızca** ekrandaki
 * modal onay penceresinde gerçek bir tıklamayla çalışır (`screenOnly`), sesle ya da ajan aracıyla onaylanamaz. Faz 5:
 * A/B testleri (`list_experiments` R0, `update_experiment_metrics` R1; klinik/hizmet düzenleme bilerek yok). R4
 * işlemleri (onay/ret, silme, gizlilik, harcama yetkisi, tavan, faturalama, OAuth, hasta mesajı) hiçbir zaman araç olmaz.
 *
 * Kural: hiçbir araç `workspaceId`/`orgId` almaz; kayıt kimliği yalnızca daha önceki bir okuma sonucundan gelen
 * kısa ref'tir (`ref-map.ts`). Rol listesi yalnızca araç listesini sadeleştirir; yetki her API ucunda yeniden denetlenir.
 */
import type { Role } from "@admedic/database";
import { z } from "zod";
import { BRIEF_LANGUAGES } from "@admedic/llm";
import { PLAN_OBJECTIVES } from "../campaign-plan";
import { LOST_REASONS } from "../labels";
import { NAV_ITEMS } from "../nav-tree";
import { riskAllowedFor, type AssistantRisk } from "./events";
import { PENDING_ID_PATTERN } from "./pending";

export type { AssistantRisk } from "./events";

const ALL: readonly Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST", "VIEWER"];
const MANAGE: readonly Role[] = ["OWNER", "ADMIN"];
const EDIT: readonly Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER"];
/** `auth.ts` CARE_ROLES ile aynı: lead durumu, Meta'dan yeniden çekme. */
const CARE: readonly Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR"];
/**
 * `alert-scope.ts` `canManageAlert`: devir uyarısını OWNER/ADMIN/PATIENT_COORDINATOR, diğerlerini OWNER/ADMIN/
 * MEDIA_BUYER kapatır; analist hiçbirini kapatamaz. Tür ayrımı sunucuda (403).
 */
const ALERT_MANAGE: readonly Role[] = CARE;
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
/** `ExperimentStatus` (Prisma). */
export const EXPERIMENT_STATUSES = ["DRAFT", "RUNNING", "COMPLETED"] as const;
/** `leads/[id]` PATCH geçiş hedefleri (NEW'e dönülmez; geçerli geçişi sunucu denetler). */
export const LEAD_TARGET_STATUSES = ["CONTACTED", "QUALIFIED", "CONSULTATION_BOOKED", "TRAVEL_PLANNED", "TREATED", "LOST"] as const;

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
   * `true`: bekleyen eylem yalnızca ekrandaki modal onay penceresinden (gerçek tıklama) onaylanır; sesli "evet" ve
   * `confirm_pending_action` reddedilir. R2/R3 araçlarında zorunlu (kayıt testi). Araç bekleyen eylemi oluşturup hemen
   * döner; onay ekranda ne kadar sürerse sürsün normal zaman aşımı yeter.
   */
  screenOnly?: boolean;
  /**
   * Aracın çağırabileceği API uçları (`"GET /api/campaigns/:id"`). Denetim testi (assistant-approval) bu listeyi ve
   * gerçek çağrıları yasak uçlarla karşılaştırır. Gezinme araçlarında boştur.
   */
  endpoints: readonly string[];
}

function tool<P extends z.AnyZodObject>(def: ToolDef<P>): ToolDef<P> {
  return def;
}

/** R2/R3 araç açıklamalarının ortak sonu (ajan için). */
const SCREEN_ONLY_HINT =
  "Hemen çalışmaz: ekranda bir onay penceresi açılır. Özeti kullanıcıya oku ve ekrandaki pencereden onaylamasını söyle; sesle onaylanamaz, confirm_pending_action çağırma.";

/** Yeni günlük bütçe parametresi (ana birim; sunucu minor unit'e çevirir, ADR-0011). */
const DailyBudget = (direction: string) =>
  z
    .number()
    .positive()
    .max(1_000_000)
    .describe(`Yeni günlük bütçe, reklam hesabının para biriminde ana birimle (ör. 500). Mevcut bütçeden ${direction} olmalı.`);

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
  tool({
    name: "list_experiments",
    risk: "R0",
    // Menüde A/B testleri (`nav-tree.ts` READ_ADS); uç oturum açmış herkese açık, menüyle aynı tutulur.
    requiredRoles: READ_ADS,
    description:
      "A/B testlerini listeler (en yeni 10): durum, geçen ve planlanan gün, A ve B varyantının harcama, tıklama ve lead sayısı. Reklam içeriği dönmez. Her testin ref'i update_experiment_metrics için kullanılır.",
    parameters: z
      .object({
        status: z.enum(EXPERIMENT_STATUSES).optional().describe("İsteğe bağlı süzgeç: DRAFT (taslak), RUNNING (sürüyor), COMPLETED (tamamlandı)."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: ["GET /api/experiments"],
  }),
  tool({
    name: "get_current_context",
    risk: "R0",
    requiredRoles: "auth",
    description:
      "Kullanıcının açık sayfasındaki kaydın ref'ini verir (kampanya, lead, reklam taslağı ya da A/B testi). Kullanıcı \"bu lead\", \"bu kampanya\", \"bu taslak\", \"bu test\" dediğinde önce bunu çağır. Ad ya da içerik dönmez.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: [],
  }),
  // ---------------------------------------------------------------- Onay (R0 düzeyinde erişim; yalnızca R1 onaylar)
  tool({
    name: "confirm_pending_action",
    risk: "R0",
    requiredRoles: "auth",
    description:
      "Bekleyen işlemi çalıştırır. YALNIZCA özeti kullanıcıya okuyup \"Onaylıyor musunuz?\" diye sorduktan ve kullanıcı açıkça \"evet\" ya da \"onaylıyorum\" dedikten sonra çağır. Kullanıcı onaylamadıysa asla çağırma. Ekranda onay gerektiren işlemler bununla onaylanamaz.",
    parameters: z
      .object({
        pendingId: z
          .string()
          .trim()
          .regex(PENDING_ID_PATTERN)
          .describe("İşlem aracının döndürdüğü pendingId; aynen kullan, uydurma."),
      })
      .strict(),
    expectsResponse: true,
    // Onaylanan işlem yapay zekâyla reklam metni üretimi olabilir (studio/generate en çok 60 sn).
    responseTimeoutSecs: 75,
    endpoints: [],
  }),
  tool({
    name: "cancel_pending_action",
    risk: "R0",
    requiredRoles: "auth",
    description: "Kullanıcı \"hayır\", \"iptal\" ya da \"vazgeç\" dediğinde bekleyen işlemi iptal eder; hiçbir değişiklik yapılmaz.",
    parameters: z
      .object({
        pendingId: z.string().trim().regex(PENDING_ID_PATTERN).describe("İptal edilecek işlemin pendingId değeri."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: [],
  }),
  // ---------------------------------------------------------------- İç yazma (R1): önce bekleyen eylem, sonra onay
  tool({
    name: "create_campaign_draft",
    risk: "R1",
    requiredRoles: EDIT,
    description:
      "Duraklatılmış taslak kampanya oluşturur (yayınlamaz, harcama başlatmaz). Hemen çalışmaz: özeti kullanıcıya oku, \"Onaylıyor musunuz?\" diye sor. Pazar, içerik ve hedefleme planlayıcıda ekrandan eklenir. Aylık tavanı sunucu denetler.",
    parameters: z
      .object({
        title: z.string().trim().min(1).max(100).describe("Kampanyanın adı (kullanıcının söylediği gibi; hasta adı içermemeli)."),
        dailyBudget: z.number().positive().max(1_000_000).describe("Günlük bütçe, reklam hesabının para biriminde (ör. 50)."),
        objective: z
          .enum(PLAN_OBJECTIVES)
          .optional()
          .describe("Hedef: MAX_ROAS (satış, varsayılan), MAX_CONVERSIONS (potansiyel müşteri), MAX_IMPRESSIONS (bilinirlik)."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: ["POST /api/campaigns"],
  }),
  tool({
    name: "submit_campaign_for_review",
    risk: "R1",
    requiredRoles: EDIT,
    description:
      "Taslak ya da düzeltme istenen kampanyayı onaya gönderir (onaylamaz, yayınlamaz). Hemen çalışmaz: özeti okuyup onay iste.",
    parameters: z.object({ ref: Ref("Kampanya") }).strict(),
    expectsResponse: true,
    endpoints: ["POST /api/campaigns/:id/submit"],
  }),
  tool({
    name: "update_alert",
    risk: "R1",
    requiredRoles: ALERT_MANAGE,
    description:
      "Uyarıyı \"Görüldü\" (ACKED) ya da \"Çözüldü\" (RESOLVED) yapar. Ref'i list_alerts sonucundan al. Hemen çalışmaz: özeti okuyup onay iste.",
    parameters: z
      .object({
        ref: Ref("Uyarı"),
        status: z.enum(["ACKED", "RESOLVED"]).describe("ACKED: görüldü; RESOLVED: çözüldü (\"uyarıyı kapat\")."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: ["PATCH /api/alerts/:id"],
  }),
  // Faz 4: R2'ye taşındı. Durum değişikliği, rıza denetiminden geçerse Meta'ya CAPI dönüşümü gönderir
  // (`sendLeadStatusConversion`); bu bir dış etkidir, ekranda tıklama ister.
  tool({
    name: "update_lead_status",
    risk: "R2",
    requiredRoles: CARE,
    screenOnly: true,
    description:
      `Lead'in aşamasını değiştirir (Meta'ya dönüşüm bildirimi gidebilir). Ref'i get_lead_stats ya da get_current_context sonucundan al. Kaybedildi (LOST) için kayıp nedeni listeden seçilir. ${SCREEN_ONLY_HINT}`,
    parameters: z
      .object({
        ref: Ref("Lead"),
        status: z
          .enum(LEAD_TARGET_STATUSES)
          .describe("Yeni aşama: CONTACTED, QUALIFIED, CONSULTATION_BOOKED, TRAVEL_PLANNED, TREATED (tedavi tamamlandı) ya da LOST."),
        lostReason: z
          .enum(LOST_REASONS)
          .optional()
          .describe("Yalnızca LOST için zorunlu; listeden biri. Serbest metin ve hasta bilgisi yazma."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: ["PATCH /api/leads/:id"],
  }),
  tool({
    name: "generate_ad_copy",
    risk: "R1",
    requiredRoles: EDIT,
    description:
      "Reklam stüdyosunda yapay zekâ ile iki başlık varyantı üretir (kaydetmez; yapay zekâ kotasından düşer). Hemen çalışmaz: özeti okuyup onay iste. Sonuç okunduktan sonra kullanıcı isterse save_studio_draft.",
    parameters: z
      .object({
        clinic: z.string().trim().min(1).max(100).describe("Klinik adı."),
        service: z.string().trim().min(1).max(100).describe("Tanıtılacak hizmet (ör. saç ekimi)."),
        market: z.string().trim().min(1).max(80).describe("Hedef pazar (ör. Almanya)."),
        language: z.enum(BRIEF_LANGUAGES).describe("Reklam dili kodu (TR, EN, DE …)."),
        budget: z.number().positive().max(1_000_000).describe("Planlanan toplam bütçe (hesap para biriminde)."),
        duration: z.number().int().min(1).max(90).describe("Kampanya süresi, gün."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: ["POST /api/studio/generate"],
  }),
  tool({
    name: "save_studio_draft",
    risk: "R1",
    requiredRoles: EDIT,
    description:
      "Bu konuşmada son üretilen reklam metnini stüdyoya taslak olarak kaydeder. Hemen çalışmaz: özeti okuyup onay iste. Sonuçtaki ref ile submit_studio_draft çağrılabilir.",
    parameters: NoParams,
    expectsResponse: true,
    endpoints: ["POST /api/studio"],
  }),
  tool({
    name: "submit_studio_draft",
    risk: "R1",
    requiredRoles: EDIT,
    description:
      "Reklam taslağını onaya gönderir (onaylamaz). Ref'i save_studio_draft ya da get_current_context sonucundan al. Orta risk uyarısı varsa kullanıcı ekrandan göndermeli. Hemen çalışmaz: özeti okuyup onay iste.",
    parameters: z.object({ ref: Ref("Reklam taslağı") }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/studio/:id", "PATCH /api/studio/:id"],
  }),
  tool({
    name: "submit_recommendation_for_review",
    risk: "R1",
    requiredRoles: MANAGE,
    description:
      "Taslak (DRAFT) öneriyi onay kuyruğuna gönderir. Onaylama, reddetme ve uygulama sesle yapılmaz. Hemen çalışmaz: özeti okuyup onay iste.",
    parameters: z.object({ ref: Ref("Öneri") }).strict(),
    expectsResponse: true,
    endpoints: ["PATCH /api/recommendations/:id"],
  }),
  tool({
    name: "refetch_leads",
    risk: "R1",
    requiredRoles: CARE,
    description:
      "Alanları Meta'dan çekilemeyen bekleyen Lead Ads lead'lerini (ya da verilen tek lead'i) şimdi yeniden çeker. Yalnızca sayılar döner. Hemen çalışmaz: özeti okuyup onay iste.",
    parameters: z.object({ ref: Ref("Lead").optional() }).strict(),
    expectsResponse: true,
    responseTimeoutSecs: 40,
    endpoints: ["POST /api/leads/refetch"],
  }),
  // Faz 5: manuel A/B ölçümü iç veridir (Meta'ya, hastaya ya da harcamaya etkisi yok) → R1. Sunucu: EDIT_ROLES.
  tool({
    name: "update_experiment_metrics",
    risk: "R1",
    requiredRoles: EDIT,
    description:
      "A/B testinin bir varyantına (A ya da B) harcama, tıklama ve lead sayısını yazar; diğer varyant ve testin durumu değişmez. Ref'i list_experiments ya da get_current_context sonucundan al. Tamamlanan test değiştirilemez. Hemen çalışmaz: özeti okuyup onay iste.",
    parameters: z
      .object({
        ref: Ref("A/B testi"),
        variant: z.enum(["A", "B"]).describe("Güncellenecek varyant: A ya da B."),
        spend: z.number().nonnegative().max(1_000_000).describe("Varyantın toplam harcaması, reklam hesabının para biriminde ana birimle (ör. 120,5)."),
        clicks: z.number().int().nonnegative().max(1_000_000_000).describe("Varyantın toplam tıklama sayısı."),
        leads: z.number().int().nonnegative().max(1_000_000_000).describe("Varyantın toplam lead sayısı; tıklama sayısından büyük olamaz."),
        elapsedDays: z
          .number()
          .int()
          .min(0)
          .max(365)
          .optional()
          .describe("İsteğe bağlı: testin geçen gün sayısı; mevcut değerden küçük olamaz. Verilmezse değişmez."),
      })
      .strict(),
    expectsResponse: true,
    endpoints: ["GET /api/experiments/:id", "PATCH /api/experiments/:id"],
  }),
  // ---------------------------------------------------------------- Dış etki, harcama yok (R2): yalnızca ekranda onay
  tool({
    name: "publish_campaign_paused",
    risk: "R2",
    requiredRoles: EDIT,
    screenOnly: true,
    description:
      `Onaylanmış (APPROVED) kampanyayı Meta'ya duraklatılmış (PAUSED) olarak yükler; harcama başlatmaz. Ref'i list_campaigns ya da get_current_context sonucundan al. ${SCREEN_ONLY_HINT}`,
    parameters: z.object({ ref: Ref("Kampanya") }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/campaigns/:id", "POST /api/campaigns/:id/publish"],
  }),
  tool({
    name: "pause_campaign",
    risk: "R2",
    requiredRoles: EDIT,
    screenOnly: true,
    description: `Yayındaki (ACTIVE) kampanyayı Meta'da duraklatır; harcama durur. ${SCREEN_ONLY_HINT}`,
    parameters: z.object({ ref: Ref("Kampanya") }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/campaigns/:id", "POST /api/campaigns/:id/publish"],
  }),
  tool({
    name: "archive_campaign",
    risk: "R2",
    requiredRoles: EDIT,
    screenOnly: true,
    description: `Yayındaki ya da duraklatılmış kampanyayı Meta'da duraklatıp arşivler. ${SCREEN_ONLY_HINT}`,
    parameters: z.object({ ref: Ref("Kampanya") }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/campaigns/:id", "POST /api/campaigns/:id/publish"],
  }),
  tool({
    name: "decrease_budget",
    risk: "R2",
    requiredRoles: EDIT,
    screenOnly: true,
    description:
      `Kampanyanın günlük bütçesini düşürür. Yeni tutar mevcut bütçeden düşük olmalı; yüksekse increase_budget kullanılır. Önce get_campaign ile mevcut bütçeyi öğren. ${SCREEN_ONLY_HINT}`,
    parameters: z.object({ ref: Ref("Kampanya"), dailyBudget: DailyBudget("düşük") }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/campaigns/:id", "PATCH /api/campaigns/:id/budget"],
  }),
  tool({
    name: "sync_meta_review",
    risk: "R2",
    requiredRoles: EDIT,
    screenOnly: true,
    description:
      `Meta inceleme durumunu Meta'dan yeniler (tek kampanya ya da yayındaki tüm kampanyalar); reddedilen reklam uyarı üretir. ${SCREEN_ONLY_HINT}`,
    parameters: z.object({ ref: Ref("Kampanya").optional() }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/campaigns/:id", "POST /api/meta/review-sync"],
  }),
  // ---------------------------------------------------------------- Harcama (R3): harcama yetkisi + ekranda onay
  tool({
    name: "activate_campaign",
    risk: "R3",
    requiredRoles: EDIT,
    screenOnly: true,
    description:
      `Meta'da duraklatılmış (yüklenmiş) kampanyayı etkinleştirir; harcama başlar. Sunucu harcama yetkisini ve aylık bütçe üst sınırını denetler. ${SCREEN_ONLY_HINT}`,
    parameters: z.object({ ref: Ref("Kampanya") }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/campaigns/:id", "POST /api/campaigns/:id/publish"],
  }),
  tool({
    name: "increase_budget",
    risk: "R3",
    requiredRoles: EDIT,
    screenOnly: true,
    description:
      `Kampanyanın günlük bütçesini artırır. Yeni tutar mevcut bütçeden yüksek olmalı; düşükse decrease_budget kullanılır. Sunucu harcama yetkisini ve aylık bütçe üst sınırını denetler. ${SCREEN_ONLY_HINT}`,
    parameters: z.object({ ref: Ref("Kampanya"), dailyBudget: DailyBudget("yüksek") }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/campaigns/:id", "PATCH /api/campaigns/:id/budget"],
  }),
  tool({
    name: "apply_recommendation",
    risk: "R3",
    requiredRoles: EDIT,
    screenOnly: true,
    description:
      `Önceden onaylanmış (APPROVED) bütçe önerisini hedef kampanyaya uygular. Öneriyi onaylamaz; onaylanmamış öneri uygulanamaz. Bütçe artışı harcama yetkisi ister. ${SCREEN_ONLY_HINT}`,
    parameters: z.object({ ref: Ref("Öneri") }).strict(),
    expectsResponse: true,
    endpoints: ["GET /api/recommendations/:id", "GET /api/campaigns/:id", "POST /api/recommendations/:id/apply"],
  }),
] as const satisfies readonly ToolDef[];

export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number]["name"];

export function findTool(name: string): ToolDef | undefined {
  return (ASSISTANT_TOOLS as readonly ToolDef[]).find((t) => t.name === name);
}

/** Araç bu role (ve harcama yetkisine) bağlanır mı? Aracın rol listesi ve risk seviyesinin rol sınırı birlikte. */
export function toolAllowedFor(def: ToolDef, role: Role, canApproveSpend: boolean): boolean {
  return (def.requiredRoles === "auth" || def.requiredRoles.includes(role)) && riskAllowedFor(def.risk, role, canApproveSpend);
}

/**
 * Rolün (ve harcama yetkisinin) kullanabileceği araçlar. Yalnızca arayüz katmanıdır; sunucu yine denetler. R3
 * araçları `canApproveSpend` false iken hiç bağlanmaz (istemci ön süzgeci; asıl karar sunucuda).
 */
export function toolsFor(role: Role, canApproveSpend: boolean): ToolDef[] {
  return (ASSISTANT_TOOLS as readonly ToolDef[]).filter((t) => toolAllowedFor(t, role, canApproveSpend));
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
