/**
 * Sesli asistan araç dağıtıcısı (ADR-0028 §2). ElevenLabs `clientTools` nesnesini üretir:
 * - Yalnızca rolün kullanabileceği araçlar bağlanır (`toolsFor`); diğerleri istemcide hiç yoktur.
 * - Parametreler kayıttaki sıkı Zod şemasıyla doğrulanır (bilinmeyen alan, ör. `workspaceId`, reddedilir).
 * - Hatalar ajana ham hâliyle gitmez; kısa Türkçe iletiye çevrilir (401/403/404/429 …) ve araç hiçbir zaman
 *   fırlatmaz. Asistan "Bu işlem için yetkiniz yok." der ve yeniden denemez.
 * - Her çağrı `POST /api/assistant/events` ile denetim kaydına bildirilir (bekletmeden, hatası yutulur); konuşma
 *   metni ve parametreler gönderilmez.
 * - Oturum başına dakikada en çok 30 araç çağrısı (ADR-0028 §9).
 */
import type { Role } from "@admedic/database";
import { api as clientApi, UNREACHABLE_MESSAGE } from "../client-api";
import type { Language } from "../i18n";
import type { AssistantEvent } from "./events";
import { RefError, RefMap } from "./ref-map";
import { ASSISTANT_TOOLS, toolsFor, type ToolDef } from "./registry";
import { json, type ApiFn, type ToolContext, type ToolHandler } from "./tools/context";
import { NavigationDenied, navigationHandlers } from "./tools/navigation";
import { readHandlers } from "./tools/read";

/** Kayıttaki her aracın uygulaması (ad → işleyici). */
export const TOOL_HANDLERS: Record<string, ToolHandler> = { ...navigationHandlers, ...readHandlers };

export const TOOL_MESSAGES = {
  unauthorized: "Oturumunuz kapanmış. Panelde yeniden giriş yapın.",
  forbidden: "Bu işlem için yetkiniz yok.",
  notFound: "Kayıt bulunamadı; silinmiş olabilir.",
  rateLimited: "Çok fazla istek gönderildi. Biraz sonra tekrar deneyin.",
  invalidParams: "Geçersiz parametre.",
  failed: "İşlem tamamlanamadı. Birkaç dakika sonra tekrar deneyin.",
  unreachable: UNREACHABLE_MESSAGE,
} as const;

export const TOOL_RATE_LIMIT = { max: 30, windowMs: 60_000 } as const;

export type ClientToolFn = (params: unknown) => Promise<string>;

export interface ToolRuntimeOptions {
  role: Role;
  canApproveSpend: boolean;
  lang?: Language;
  router: { push(href: string): void };
  /** Varsayılan: `client-api.ts` `api()` (kullanıcının oturum çereziyle). */
  api?: ApiFn;
  /** Varsayılan: `POST /api/assistant/events`, bekletmeden. */
  reportEvent?: (event: AssistantEvent) => void | Promise<void>;
  /** Konuşma kimliği (ElevenLabs `onConnect`); denetim kaydına eklenir. */
  getConversationId?: () => string | null | undefined;
  refs?: RefMap;
  openLeadSearch?: () => void;
  stop?: () => void;
  now?: () => number;
}

export interface ToolRuntime {
  /** `useConversation({ clientTools })` / `startSession({ clientTools })` için. */
  clientTools: Record<string, ClientToolFn>;
  /** Bağlanan araçlar (ajan istemine dinamik değişken olarak verilebilir). */
  tools: ToolDef[];
  /**
   * Kayıtta olup bu role bağlanmayan her araç için "yetkiniz yok" yanıtı veren saplama. Ajan tüm kayıt araçlarını
   * bilir (eşitleme betiği); tarayıcıda tanımsız bir araç çağrılırsa SDK `onError` yayınlar. Bu saplamalar yalnızca
   * ElevenLabs oturumuna `clientTools` ile birlikte verilir; işleyici çalıştırmaz, denetime "denied" yazar.
   */
  deniedTools: Record<string, ClientToolFn>;
  refs: RefMap;
}

type Outcome = AssistantEvent["outcome"];

function failure(message: string, retryable = false): string {
  return json({ ok: false, error: message, retryable });
}

/** Hata → ajana gidecek kısa ileti ve denetim sonucu. Sunucu iletileri yalnızca bilinen durumlarda kullanılmaz. */
export function describeToolError(error: unknown): { message: string; outcome: NonNullable<Outcome>; retryable: boolean } {
  if (error instanceof RefError || error instanceof NavigationDenied)
    return { message: error.message, outcome: error instanceof NavigationDenied ? "denied" : "error", retryable: false };
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  if (typeof status === "number") {
    if (status === 401) return { message: TOOL_MESSAGES.unauthorized, outcome: "denied", retryable: false };
    if (status === 403) return { message: TOOL_MESSAGES.forbidden, outcome: "denied", retryable: false };
    if (status === 404) return { message: TOOL_MESSAGES.notFound, outcome: "error", retryable: false };
    if (status === 429) return { message: TOOL_MESSAGES.rateLimited, outcome: "error", retryable: false };
    return { message: TOOL_MESSAGES.failed, outcome: "error", retryable: status >= 500 };
  }
  if (error instanceof Error && error.message === UNREACHABLE_MESSAGE)
    return { message: TOOL_MESSAGES.unreachable, outcome: "error", retryable: true };
  return { message: TOOL_MESSAGES.failed, outcome: "error", retryable: false };
}

function defaultReporter(api: ApiFn) {
  return (event: AssistantEvent) => api("/api/assistant/events", "POST", event).then(() => undefined);
}

/** Kısa ömürlü istemci kimliği kuralı (`events.ts` Ref): uymayan değer gönderilmez. */
function safeId(value: string | null | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  const api = options.api ?? clientApi;
  const refs = options.refs ?? new RefMap();
  const report = options.reportEvent ?? defaultReporter(api);
  const now = options.now ?? Date.now;
  const tools = toolsFor(options.role, options.canApproveSpend);
  const calls: number[] = [];
  const ctx: ToolContext = {
    role: options.role,
    canApproveSpend: options.canApproveSpend,
    lang: options.lang ?? "tr",
    router: options.router,
    api,
    refs,
    openLeadSearch: options.openLeadSearch,
    stop: options.stop,
  };

  function emit(def: ToolDef, outcome: NonNullable<Outcome>, entityId?: string) {
    const event: AssistantEvent = {
      type: "tool_call",
      tool: def.name,
      risk: def.risk,
      outcome,
      ...(safeId(entityId) ? { entityRef: safeId(entityId) } : {}),
      ...(safeId(options.getConversationId?.()) ? { conversationId: safeId(options.getConversationId?.()) } : {}),
    };
    try {
      void Promise.resolve(report(event)).catch(() => undefined);
    } catch {
      // Denetim bildirimi aracın sonucunu hiçbir zaman bozmaz.
    }
  }

  function underLimit(): boolean {
    const t = now();
    while (calls.length && t - calls[0] >= TOOL_RATE_LIMIT.windowMs) calls.shift();
    if (calls.length >= TOOL_RATE_LIMIT.max) return false;
    calls.push(t);
    return true;
  }

  const clientTools: Record<string, ClientToolFn> = {};
  for (const def of tools) {
    const handler = TOOL_HANDLERS[def.name];
    if (!handler) continue;
    clientTools[def.name] = async (params: unknown) => {
      if (!underLimit()) {
        emit(def, "denied");
        return failure(TOOL_MESSAGES.rateLimited);
      }
      const parsed = def.parameters.safeParse(params ?? {});
      if (!parsed.success) {
        emit(def, "error");
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || (i.code === "unrecognized_keys" ? i.keys.join(", ") : "")))]
          .filter(Boolean)
          .join(", ");
        return failure(fields ? `${TOOL_MESSAGES.invalidParams} (${fields})` : TOOL_MESSAGES.invalidParams);
      }
      try {
        const output = await handler(parsed.data as Record<string, unknown>, ctx);
        emit(def, "ok", output.entityId);
        return output.result;
      } catch (error) {
        const described = describeToolError(error);
        emit(def, described.outcome);
        return failure(described.message, described.retryable);
      }
    };
  }
  const deniedTools: Record<string, ClientToolFn> = {};
  for (const def of ASSISTANT_TOOLS as readonly ToolDef[]) {
    if (def.name in clientTools) continue;
    deniedTools[def.name] = async () => {
      emit(def, "denied");
      return failure(TOOL_MESSAGES.forbidden);
    };
  }
  return { clientTools, tools: tools.filter((t) => t.name in clientTools), deniedTools, refs };
}
