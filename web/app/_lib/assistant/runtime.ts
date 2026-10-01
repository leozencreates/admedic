/**
 * Sesli asistan araç dağıtıcısı (ADR-0028 §2). ElevenLabs `clientTools` nesnesini üretir:
 * - Yalnızca rolün kullanabileceği araçlar bağlanır (`toolsFor`); diğerleri istemcide hiç yoktur.
 * - Parametreler kayıttaki sıkı Zod şemasıyla doğrulanır (bilinmeyen alan, ör. `workspaceId`, reddedilir).
 * - Hatalar ajana ham hâliyle gitmez; kısa Türkçe iletiye çevrilir (400/401/403/404/409/422/429 …) ve araç hiçbir
 *   zaman fırlatmaz. Asistan "Bu işlem için yetkiniz yok." der ve yeniden denemez. 400/409/422'de sunucunun serbest
 *   metni yerine yalnızca sabit bir neden kodu döner (sunucu metni kişisel veri taşıyabilir).
 * - R1 araçları (Faz 3) işlemi hemen yapmaz: bekleyen eylem oluşturur (`pending.ts`) ve ajana özet + `pendingId`
 *   döner. İşlem `confirm_pending_action` (yalnızca R1) ya da ekrandaki onay (`runtime.pending.confirm`) ile bir kez
 *   çalışır; `onPendingChange` onay kartını besler. Ajan yolu ayrıca kullanıcının, eylem oluştuktan sonra konuşup açıkça
 *   onay vermiş olmasını ister (`noteUserTurn`); ajan kullanıcı konuşmadan aynı turda onaylayamaz (istem enjeksiyonu).
 * - R2/R3 araçları (Faz 4) da bekleyen eylem oluşturur ve ajana `awaiting_screen_confirmation` döner; işlem **yalnızca**
 *   ekrandaki modal onay penceresinde gerçek bir tıklamayla (`pending.confirmOnScreen`) çalışır. `confirm_pending_action`
 *   (sesli "evet") ve R1 onay kartı (`pending.confirm`) bunları reddeder (`not_confirmable`). R3 araçları
 *   `canApproveSpend` false iken hiç bağlanmaz; sunucu yine de harcama yetkisini ve aylık tavanı denetler.
 * - Her araç sonucu `POST /api/assistant/events` ile denetim kaydına bildirilir (bekletmeden, hatası yutulur); konuşma
 *   metni ve parametreler gönderilmez. R1'de yalnızca **son** sonuç bildirilir: onaylanınca ok/denied/error, iptal,
 *   süre dolumu ya da yerine yenisinin gelmesi `cancelled`. Bekleyen eylemin oluşması ayrıca kaydedilmez.
 * - Oturum başına dakikada en çok 30 araç çağrısı (ADR-0028 §9).
 */
import type { Role } from "@admedic/database";
import type { ZodIssue } from "zod";
import { api as clientApi, UNREACHABLE_MESSAGE } from "../client-api";
import { t, type Language } from "../i18n";
import type { AssistantEvent } from "./events";
import {
  isAffirmativeReply,
  PendingActionError,
  PendingActionStore,
  type ConfirmSource,
  type PendingEndReason,
  type PendingStoreOptions,
  type PendingView,
} from "./pending";
import { RefError, RefMap } from "./ref-map";
import { ASSISTANT_TOOLS, findTool, toolsFor, type ToolDef } from "./registry";
import { actionHandlers, type ActionHandler } from "./tools/actions";
import { json, ToolInputError, type ApiFn, type ToolContext, type ToolHandler, type ToolOutput } from "./tools/context";
import { NavigationDenied, navigationHandlers } from "./tools/navigation";
import { readHandlers } from "./tools/read";
import { screenActionHandlers } from "./tools/screen-actions";

/** R0 araçlarının uygulaması (ad → işleyici). R1–R3 araçları `ACTION_HANDLERS`, onay araçları `PENDING_TOOLS`. */
export const TOOL_HANDLERS: Record<string, ToolHandler> = { ...navigationHandlers, ...readHandlers };

/** R1–R3 araçları: hazırla (yazmadan) → onay → çalıştır. R2/R3 yalnızca ekrandaki pencereden onaylanır. */
export const ACTION_HANDLERS: Record<string, ActionHandler> = { ...actionHandlers, ...screenActionHandlers };

/** Bekleyen eylemi onaylayan/iptal eden araçlar (dağıtıcının kendisinde uygulanır). */
export const PENDING_TOOLS = ["confirm_pending_action", "cancel_pending_action"] as const;

export const TOOL_MESSAGES = {
  unauthorized: "Oturumunuz kapanmış. Panelde yeniden giriş yapın.",
  forbidden: "Bu işlem için yetkiniz yok.",
  /** 403 harcama yetkisi (`requireSpendAuthority`): ACTIVATE, bütçe artışı, artış önerisi. */
  spendForbidden: "Bu işlem için harcama yetkiniz yok (spend_authority). Yetkiyi yalnızca kuruluş sahibi verebilir.",
  notFound: "Kayıt bulunamadı; silinmiş olabilir.",
  rateLimited: "Çok fazla istek gönderildi. Biraz sonra tekrar deneyin.",
  invalidParams: "Geçersiz parametre.",
  /** 400/409/422: ardından `: <neden kodu>` gelir. */
  notApplicable: "Bu işlem şu an uygulanamıyor",
  failed: "İşlem tamamlanamadı. Birkaç dakika sonra tekrar deneyin.",
  unreachable: UNREACHABLE_MESSAGE,
} as const;

/** Ajanın R1 aracından sonra yapacağı (araç sonucu içinde döner). */
export const PENDING_INSTRUCTION =
  "İşlem henüz yapılmadı. Özeti kullanıcıya aynen oku ve \"Onaylıyor musunuz?\" diye sor. Kullanıcı açıkça \"evet\" " +
  "derse confirm_pending_action, \"hayır\" ya da \"iptal\" derse cancel_pending_action çağır; başka bir şey derse onaylama. " +
  "Kullanıcının yanıtını beklemeden confirm_pending_action çağırma; çağrı reddedilir.";

/** R2/R3 aracından sonra ajanın yapacağı (araç sonucu içinde döner). */
export const SCREEN_CONFIRMATION_INSTRUCTION = "Kullanıcı ekrandaki onay penceresinden onaylamalı; sesle onaylanamaz.";

/** Ajana R2/R3 sonucu: işlem yapılmadı, ekranda onay bekliyor. */
export const SCREEN_CONFIRMATION_HINT =
  "İşlem henüz yapılmadı. Özeti kullanıcıya oku ve ekrandaki onay penceresinden onaylamasını söyle. confirm_pending_action " +
  "bu işlemi onaylayamaz; kullanıcı \"evet\" dese de çağırma. Kullanıcı vazgeçerse cancel_pending_action çağır. Sonuç sana " +
  "bağlam iletisiyle bildirilir.";

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
  /** Açık sayfa (`get_current_context`); varsayılan `window.location`. */
  location?: () => { pathname: string; search: string } | null;
  now?: () => number;
  /** Bekleyen eylem deposu ayarları (süre, zamanlayıcı, rastgelelik); saat varsayılan olarak `now`. */
  pending?: PendingStoreOptions;
}

export interface PendingControls {
  /** Bekleyen eylem (süresi dolmamışsa). */
  current(): PendingView | null;
  /**
   * R1 onay kartındaki "Onayla": sesli onayla aynı yol; yalnızca R1 çalıştırır (R2/R3 `not_confirmable`). Ajana
   * iletilecek sonucu (JSON) döner, fırlatmaz.
   */
  confirm(pendingId: string): Promise<string>;
  /**
   * Ekrandaki modal onay penceresindeki "Onayla" (R2/R3'ü çalıştırabilen **tek** yol; R1'i de çalıştırır). Yalnızca
   * kullanıcının gerçek tıklamasının işleyicisinden çağrılmalı; ajan, ses ya da klavye kısayolu bunu çağırmaz.
   */
  confirmOnScreen(pendingId: string): Promise<string>;
  /** Ekrandaki "İptal". */
  cancel(pendingId: string): string;
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
  pending: PendingControls;
  /**
   * Onay kartı: bekleyen eylem oluşunca görünümü, bitince `null`, bitiş nedeni (onay, iptal, süre dolumu, yerine
   * yenisi) ve biten eylemin görünümüyle çağrılır. Dinlemeyi bırakan fonksiyon döner.
   */
  onPendingChange(listener: (pending: PendingView | null, reason?: PendingEndReason, ended?: PendingView) => void): () => void;
  /**
   * Kullanıcı turu (sesli döküm ya da yazılan ileti). Ajan yolundaki onay yalnızca bekleyen eylem oluştuktan sonra
   * gelen bir kullanıcı turu açık bir onaysa geçer. Metin saklanmaz; yalnızca tur sayısı ve "onay mı" bilgisi tutulur.
   */
  noteUserTurn(text: string): void;
  /** Oturum kapanırken: bekleyen eylem iptal edilir (`cancelled` bildirilir). */
  dispose(): void;
}

type Outcome = NonNullable<AssistantEvent["outcome"]>;

function failure(message: string, retryable = false): string {
  return json({ ok: false, error: message, retryable });
}

/**
 * Sunucunun (statik, Türkçe) hata metninden sabit neden kodu. Yalnızca kod döner; metin hiçbir zaman ajana gitmez.
 * Sıra önemlidir (özel kalıp önce).
 */
const REASON_CODES: readonly [RegExp, string][] = [
  [/orta risk/i, "policy_warning"],
  [/yüksek riskli/i, "policy_high_risk"],
  [/aylık bütçe üst sınırı|tavan/i, "monthly_cap"],
  [/onaya göndermeden önce tamamlayın/i, "not_ready"],
  [/kayıp nedeni/i, "lost_reason_required"],
  [/geçirilemez/i, "invalid_transition"],
  [/yeniden açılamaz/i, "already_resolved"],
  [/yalnızca taslak öneri/i, "not_draft"],
  [/zaten/i, "already_done"],
  [/eşzamanlı|bu sırada değişti|değişmiş/i, "changed_meanwhile"],
  // Faz 4 (R2/R3): yayın, bütçe ve öneri uçlarının durum hataları.
  [/yalnızca yayındaki/i, "invalid_state"],
  [/henüz onaylanmadı/i, "not_approved"],
  [/önce kampanyayı yayınlayın|meta'da yayınlanmamış|meta kimliği bulunamadı/i, "not_published"],
  [/şu anda sürüyor/i, "publish_in_progress"],
  [/yarım kaldı/i, "publish_incomplete"],
  [/kayıtla uyuşmuyor/i, "meta_mismatch"],
  [/reklamı yok/i, "no_ads"],
  [/arşivlenmiş/i, "archived"],
  [/yalnızca günlük bütçeli/i, "lifetime_budget"],
  [/meta bağlantısı kurulmamış/i, "no_meta_connection"],
  [/otomatik uygulanamaz/i, "not_applicable"],
  [/hedef kampanya/i, "no_target_campaign"],
  [/yaş/i, "age_range"],
  [/reklam hesabı bulunamadı/i, "no_ad_account"],
];

export function reasonCode(status: number, message: string): string {
  for (const [pattern, code] of REASON_CODES) if (pattern.test(message)) return code;
  return status === 409 ? "state_conflict" : status === 422 ? "validation_failed" : "bad_request";
}

/** Hata → ajana gidecek kısa ileti ve denetim sonucu. Sunucu iletisi hiçbir durumda olduğu gibi aktarılmaz. */
export function describeToolError(error: unknown): { message: string; outcome: Outcome; retryable: boolean } {
  if (error instanceof RefError || error instanceof NavigationDenied || error instanceof ToolInputError || error instanceof PendingActionError)
    return { message: error.message, outcome: error instanceof NavigationDenied ? "denied" : "error", retryable: false };
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  if (typeof status === "number") {
    if (status === 401) return { message: TOOL_MESSAGES.unauthorized, outcome: "denied", retryable: false };
    if (status === 403) {
      const raw = error instanceof Error ? error.message : "";
      return { message: /harcama yetki/i.test(raw) ? TOOL_MESSAGES.spendForbidden : TOOL_MESSAGES.forbidden, outcome: "denied", retryable: false };
    }
    if (status === 404) return { message: TOOL_MESSAGES.notFound, outcome: "error", retryable: false };
    if (status === 429) return { message: TOOL_MESSAGES.rateLimited, outcome: "error", retryable: false };
    if (status === 400 || status === 409 || status === 422) {
      const raw = error instanceof Error ? error.message : "";
      return { message: `${TOOL_MESSAGES.notApplicable}: ${reasonCode(status, raw)}`, outcome: "error", retryable: false };
    }
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

function invalidParamsMessage(issues: readonly ZodIssue[]): string {
  const fields = [...new Set(issues.map((i) => i.path.join(".") || (i.code === "unrecognized_keys" ? i.keys.join(", ") : "")))]
    .filter(Boolean)
    .join(", ");
  return fields ? `${TOOL_MESSAGES.invalidParams} (${fields})` : TOOL_MESSAGES.invalidParams;
}

export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  const api = options.api ?? clientApi;
  const refs = options.refs ?? new RefMap();
  const report = options.reportEvent ?? defaultReporter(api);
  const now = options.now ?? Date.now;
  const lang = options.lang ?? "tr";
  const tools = toolsFor(options.role, options.canApproveSpend);
  const calls: number[] = [];
  const ctx: ToolContext = {
    role: options.role,
    canApproveSpend: options.canApproveSpend,
    lang,
    router: options.router,
    api,
    refs,
    openLeadSearch: options.openLeadSearch,
    stop: options.stop,
    location: options.location,
    memory: { generatedCopy: null },
  };
  const store = new PendingActionStore<ToolOutput>({ now, ...options.pending });
  // Kullanıcı turu sayacı: ajan yolu onayı, eylem oluştuktan sonra gelen açık bir kullanıcı onayı ister.
  let userTurns = 0;
  let lastTurnAffirmative = false;
  let pendingTurn: { pendingId: string; turn: number } | null = null;

  /** Bekleyen eylem oluştuktan sonra kullanıcı konuştu ve son sözü açık bir onay mı? */
  function userConfirmed(pendingId: string): boolean {
    return pendingTurn?.pendingId === pendingId && userTurns > pendingTurn.turn && lastTurnAffirmative;
  }

  function emit(def: ToolDef, outcome: Outcome, entityId?: string) {
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

  // Onaysız biten bekleyen eylem (iptal, süre dolumu, yerine yenisi): son sonuç `cancelled`. Onaylanan eylemin sonucu
  // çalıştıktan sonra `runConfirm` içinde bildirilir.
  store.onChange((change) => {
    if (change.type !== "ended" || change.reason === "confirmed") return;
    const def = findTool(change.pending.tool);
    if (def) emit(def, "cancelled", change.entityId);
  });

  function underLimit(): boolean {
    const t0 = now();
    while (calls.length && t0 - calls[0] >= TOOL_RATE_LIMIT.windowMs) calls.shift();
    if (calls.length >= TOOL_RATE_LIMIT.max) return false;
    calls.push(t0);
    return true;
  }

  /**
   * Ajan, R1 kartı ve ekran penceresi onayının ortak yolu. Fırlatmaz. R2/R3 yalnızca `ui` kaynağıyla çalışır; ajan
   * yolunda bu, kullanıcı turu denetiminden önce reddedilir (kullanıcı "evet" demiş olsa da).
   */
  async function runConfirm(pendingId: unknown, source: ConfirmSource): Promise<string> {
    const peeked = store.peek(pendingId);
    const def = peeked ? findTool(peeked.view.tool) : undefined;
    try {
      if (source !== "ui" && peeked && peeked.view.risk !== "R1") throw new PendingActionError("not_confirmable");
      if (source === "agent" && peeked && !userConfirmed(peeked.view.pendingId)) throw new PendingActionError("no_user_reply");
      const { result, entityId } = await store.confirm(pendingId, { source });
      if (def) emit(def, "ok", result.entityId ?? entityId);
      return result.result;
    } catch (error) {
      const described = describeToolError(error);
      if (error instanceof PendingActionError) {
        // Onaylanamadı (bilinmeyen/süresi dolmuş/kullanılmış kimlik ya da sesle onaylanamayan risk): işlem çalışmadı.
        const confirmDef = findTool("confirm_pending_action");
        if (source === "agent" && confirmDef) emit(confirmDef, error.code === "not_confirmable" || error.code === "no_user_reply" ? "denied" : "error");
      } else if (def) {
        emit(def, described.outcome, peeked?.entityId);
      }
      return failure(described.message, described.retryable);
    }
  }

  function runCancel(pendingId: unknown): string {
    try {
      store.cancel(pendingId);
      return json({ ok: true, status: "cancelled", message: t("assistant.pending.cancelled", lang) });
    } catch (error) {
      return failure(describeToolError(error).message);
    }
  }

  const clientTools: Record<string, ClientToolFn> = {};
  for (const def of tools) {
    const handler = TOOL_HANDLERS[def.name];
    const action = ACTION_HANDLERS[def.name];
    const isPendingTool = (PENDING_TOOLS as readonly string[]).includes(def.name);
    // R1–R3 aracı yalnızca hazırla → onay yolundan çalışır; R0 doğrudan işleyiciyle.
    if (def.risk !== "R0" ? !action : !handler && !isPendingTool) continue;
    clientTools[def.name] = async (params: unknown) => {
      if (!underLimit()) {
        emit(def, "denied");
        return failure(TOOL_MESSAGES.rateLimited);
      }
      const parsed = def.parameters.safeParse(params ?? {});
      if (!parsed.success) {
        emit(def, "error");
        return failure(invalidParamsMessage(parsed.error.issues));
      }
      const data = parsed.data as Record<string, unknown>;
      if (def.name === "confirm_pending_action") return runConfirm(data.pendingId, "agent");
      if (def.name === "cancel_pending_action") return runCancel(data.pendingId);
      try {
        if (def.risk !== "R0" && action) {
          const prepared = await action.prepare(data, ctx);
          const screen = def.risk !== "R1";
          // Savunma: R2/R3 ekran görünümü olmadan bekleyen eyleme dönüşmez (depo da reddeder).
          if (screen && (!def.screenOnly || prepared.confirmation?.risk !== def.risk)) throw new Error("screen confirmation missing");
          const replaced = store.get() !== null;
          const { pendingId, expiresAt } = store.create({
            tool: def.name,
            risk: def.risk,
            params: prepared.payload,
            summary: prepared.summary,
            entityId: prepared.entityId,
            ...(screen ? { confirmation: prepared.confirmation } : {}),
            run: (payload) => action.execute(payload, ctx),
          });
          const expiresInSeconds = Math.max(1, Math.round((expiresAt - now()) / 1000));
          if (screen)
            return json({
              status: "awaiting_screen_confirmation",
              pendingId,
              summary: prepared.summary,
              expiresInSeconds,
              ...(replaced ? { previousPendingCancelled: true } : {}),
              next: SCREEN_CONFIRMATION_INSTRUCTION,
              instruction: SCREEN_CONFIRMATION_HINT,
            });
          pendingTurn = { pendingId, turn: userTurns };
          return json({
            status: "awaiting_confirmation",
            pendingId,
            summary: prepared.summary,
            question: t("assistant.pending.question", lang),
            expiresInSeconds,
            ...(replaced ? { previousPendingCancelled: true } : {}),
            next: PENDING_INSTRUCTION,
          });
        }
        const output = await handler!(data, ctx);
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
  return {
    clientTools,
    tools: tools.filter((t) => t.name in clientTools),
    deniedTools,
    refs,
    pending: {
      current: () => store.get(),
      confirm: (pendingId) => runConfirm(pendingId, "card"),
      confirmOnScreen: (pendingId) => runConfirm(pendingId, "ui"),
      cancel: (pendingId) => runCancel(pendingId),
    },
    onPendingChange(listener) {
      return store.onChange((change) =>
        change.type === "created" ? listener(change.pending) : listener(null, change.reason, change.pending),
      );
    },
    noteUserTurn(text) {
      userTurns += 1;
      lastTurnAffirmative = typeof text === "string" && isAffirmativeReply(text);
    },
    dispose() {
      store.dispose();
    },
  };
}
