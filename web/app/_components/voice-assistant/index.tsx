"use client";
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { Role } from "@admedic/database";
import { api, ApiError } from "../../_lib/client-api";
import { t, type Language, type TranslationKey } from "../../_lib/i18n";
import {
  MockAdapter,
  assistantDynamicVariables,
  type AdapterMode,
  type AdapterStatus,
  type AssistantSessionResponse,
  type ElevenLabsAdapter,
  type VoiceSessionAdapter,
} from "../../_lib/assistant/adapter";
import type { AssistantEvent } from "../../_lib/assistant/events";
import {
  reachedSessionLimit,
  sessionEndedEvent,
  sessionExpired,
  sessionMinutesLabel,
  sessionSecondsLeft,
  voiceLimitKind,
} from "../../_lib/assistant/limits";
import {
  PENDING_ERROR_CODES,
  PendingActionError,
  type PendingEndReason,
  type PendingView,
} from "../../_lib/assistant/pending";
import { TOOL_MESSAGES, createToolRuntime, type ClientToolFn, type ToolRuntime } from "../../_lib/assistant/runtime";
import { SCREEN_ACTION_MESSAGES } from "../../_lib/assistant/tools/screen-actions";
import { AssistantButton } from "./button";
import { ConsentDialog } from "./consent-dialog";
import { AssistantPanel } from "./panel";
import { ScreenConfirmDialog } from "./screen-confirm-dialog";
import {
  ASSISTANT_TOGGLE_EVENT,
  CONFIRM_ARM_MS,
  DISABLED_SESSION_KEY,
  INITIAL_LIVE,
  SCREEN_ANNOUNCE_DELAY_MS,
  STATE_LABEL_KEY,
  appendLine,
  countdownMilestone,
  deriveUiState,
  isActiveState,
  listeningAnnounceDelayMs,
  parsePendingResult,
  pendingContextUpdate,
  pendingSurface,
  pendingTotalSeconds,
  readConsent,
  reduceLive,
  remainingSeconds,
  safeStorage,
  screenConfirmTarget,
  shouldFocusCard,
  showsTextInput,
  writeConsent,
  type AssistantPhase,
  type PendingOutcome,
  type TranscriptLine,
} from "./state";

export { ASSISTANT_TOGGLE_EVENT } from "./state";

// SDK yalnızca gerçek oturumda yüklenir (deneme modunda ve özellik kapalıyken hiç indirilmez).
const ElevenLabsBridge = dynamic(() => import("./elevenlabs-bridge"), { ssr: false });

/** Mikrofon izni: alınırsa akış hemen kapatılır (SDK kendisi yeniden açar); alınamazsa metin kipine geçilir. */
async function microphoneAvailable(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

/** Ajana bağlam iletisinde aktarılabilecek sabit hata iletileri (araç iletileri ve bekleyen eylem hataları). */
const KNOWN_AGENT_ERRORS: readonly string[] = [
  ...Object.values(TOOL_MESSAGES),
  ...PENDING_ERROR_CODES.map((code) => new PendingActionError(code).message),
  // Ekran eylemlerinin ön koşul iletileri (ör. "bütçe bu sırada değişti"); yer tutuculu olanlar eşleşmez, atılır.
  ...Object.values(SCREEN_ACTION_MESSAGES),
];

const NON_TEXT_INPUTS = ["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"];

/** Odaktaki öğe bir yazma alanı mı (kullanıcı yazıyorsa onay kartı odağı çalmaz)? */
function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.includes(el.type);
}

/** Oturum/izin isteği hatası → kullanıcıya gösterilecek ileti anahtarı. */
function startErrorKey(err: unknown): TranslationKey {
  if (!(err instanceof ApiError)) return "assistant.error.unreachable";
  if (err.status === 429) {
    // Kuruluşun günlük oturum sınırı ya da aylık dakika bütçesi (sunucunun sabit iletisi; Faz 5).
    const limit = voiceLimitKind(err.message);
    if (limit === "dailySessions") return "assistant.error.dailyCap";
    if (limit === "monthlyMinutes") return "assistant.error.monthlyCap";
    return "assistant.error.rateLimited";
  }
  if (err.status === 401) return "assistant.error.unauthorized";
  if (err.status === 403) return "assistant.error.forbidden";
  return "assistant.error.start";
}

/** Başka bir katman (diyalog, açık menü, tam ekran menü) açıkken Esc onundur; asistan oturumu kapanmaz. */
function otherLayerOpen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector("dialog[open], .popover-anchor[data-open='true'], .app-sheet[data-open='true']"),
  );
}

/**
 * Sesli komut asistanı (ADR-0028 §4, Faz 2): yüzen düğme, panel, aydınlatma diyaloğu ve canlı bölge.
 * - İlk basışta aydınlatma/izin diyaloğu; kabul önce denetim kaydına (`consent_given`) yazılır, ancak o kabul edilirse
 *   tarayıcıda kullanıcı kimliği başına tutulur. Kullanıcı kimliği bilinmiyorsa izin hiç hatırlanmaz.
 * - Özellik kapalıysa (`enabled` false) düğme, diyalog ve köprü hiç çizilmez. Açıkken uç 404 dönerse (bayrak sayfa
 *   açıkken kapatıldı) düğme bu sekmede gizlenir.
 * - Deneme oturumunda (`mock: true`) senaryolu bağdaştırıcı, aksi hâlde ElevenLabs kullanılır. Araçlar
 *   `createToolRuntime` ile rol süzgecinden geçer ve kullanıcının oturum çereziyle mevcut `/api/*` uçlarını çağırır.
 * - Asistan adı koda yazılmaz: oturum yanıtındaki `assistantName` (ASSISTANT_NAME ?? APP_NAME); o gelene kadar `appName`.
 */
export function VoiceAssistant({
  enabled = true,
  role,
  lang,
  appName,
  userKey,
  covered = false,
  onOpenLeadSearch,
}: {
  /** Sunucudaki özellik bayrağı (VOICE_ASSISTANT_ENABLED + ajan kimliği); false ise hiçbir şey çizilmez. */
  enabled?: boolean;
  /** Sunucudaki rol; yalnızca düğmeyi göstermek için. Araç listesi oturum yanıtındaki role göre kurulur. */
  role: string | null;
  lang: Language;
  appName: string;
  /** İznin kullanıcı başına tutulması için kararlı ve benzersiz kullanıcı kimliği (tarayıcıya özetlenerek yazılır). */
  userKey?: string | null;
  /** Telefonda bir yazma alanı ya da açık lead konuşması altta: boştaki düğme gizlenir, açık oturum yukarı kayar. */
  covered?: boolean;
  onOpenLeadSearch?: () => void;
}) {
  const router = useRouter();
  const routerRef = useRef(router);
  const openLeadSearchRef = useRef(onOpenLeadSearch);
  useEffect(() => {
    routerRef.current = router;
    openLeadSearchRef.current = onOpenLeadSearch;
  });

  const baseId = useId().replace(/:/g, "");
  const panelId = `va-panel-${baseId}`;

  const [phase, setPhase] = useState<AssistantPhase>("idle");
  const [status, setStatus] = useState<AdapterStatus>("disconnected");
  const [mode, setMode] = useState<AdapterMode>("listening");
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [toolsRunning, setToolsRunning] = useState(0);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [live, dispatchLive] = useReducer(reduceLive, INITIAL_LIVE);
  const [pending, setPending] = useState<PendingView | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingArmed, setPendingArmed] = useState(true);
  // Modal onay penceresinin kendi canlı bölgesi (pencere açıkken sayfanın canlı bölgeleri inert).
  const [dialogAnnounce, setDialogAnnounce] = useState<{ text: string; seq: number } | undefined>(undefined);
  const [clock, setClock] = useState(0);
  const [assistantName, setAssistantName] = useState(appName);
  const [consentBusy, setConsentBusy] = useState(false);
  const [textOnly, setTextOnly] = useState(false);
  const [bridgeWanted, setBridgeWanted] = useState(false);
  // Oturum süresi (Faz 5): bağlantının kurulduğu an ve kalan saniye (yalnızca son 30 sn gösterilir).
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [sessionLeft, setSessionLeft] = useState<number | null>(null);

  const adapterRef = useRef<VoiceSessionAdapter | null>(null);
  const unsubscribeRef = useRef<(() => void)[]>([]);
  const consentInMemory = useRef(false);
  const lineId = useRef(0);
  const startingRef = useRef(false);
  const elevenRef = useRef<ElevenLabsAdapter | null>(null);
  const elevenWaiters = useRef<((adapter: ElevenLabsAdapter) => void)[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Onay kartı: araç dağıtıcısı, görünen eylem, ekrandan çözülen eylemin kimliği, son duyurulan eşik ve odak.
  const runtimeRef = useRef<ToolRuntime | null>(null);
  const pendingRef = useRef<PendingView | null>(null);
  const uiResolvingRef = useRef<string | null>(null);
  const milestoneRef = useRef<number | null>(null);
  const focusCardRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const armTimerRef = useRef<number | null>(null);
  // Oturum süresi: en uzun süre (oturum yanıtından), başlangıç, bildirildi mi, son duyurulan eşik.
  const sessionMaxRef = useRef<number | null>(null);
  /** Sunucunun verdiği oturum kimliği (`session_ended` bununla bildirilir). */
  const sessionRefRef = useRef<string | null>(null);
  const sessionStartRef = useRef<number | null>(null);
  const sessionMilestoneRef = useRef<number | null>(null);

  // Özellik kapalı (bu sekmede 404 alındı): düğme yeniden çizilmez.
  useEffect(() => {
    try {
      if (safeStorage("session")?.getItem(DISABLED_SESSION_KEY) === "1") setPhase("disabled");
    } catch {
      // Depolama kapalı: ilk basışta 404 ile yeniden anlaşılır.
    }
  }, []);

  useEffect(() => {
    setAssistantName((current) => current || appName);
  }, [appName]);

  const uiState = deriveUiState({ phase, status, mode, thinking: awaitingReply || toolsRunning > 0 });
  const stateText = t(STATE_LABEL_KEY[uiState], lang);
  const active = isActiveState(uiState);
  const panelOpen = phase === "connecting" || phase === "permission" || phase === "active" || phase === "error";

  // Durum değişince durum bölgesi kısa metni duyurur. Ajan yanıtı ayrı bölgededir ve "Dinliyorum…" onu ezmez
  // (`reduceLive`: yanıttan sonraki "Dinliyorum…" yanıtın okunma süresi kadar ertelenir; bu arada durum değişirse düşer).
  useEffect(() => {
    dispatchLive({ type: "state", state: uiState, text: stateText });
  }, [uiState, stateText]);

  const deferredStatus = live.deferredStatus;
  const lastMessage = live.message;
  useEffect(() => {
    if (deferredStatus === null) return;
    const timer = window.setTimeout(() => dispatchLive({ type: "flush" }), listeningAnnounceDelayMs(lastMessage));
    return () => window.clearTimeout(timer);
  }, [deferredStatus, lastMessage]);

  const getLevel = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter) return 0;
    return Math.max(adapter.getInputVolume(), adapter.getOutputVolume());
  }, []);

  /** Kartı kapatır; odak karttaysa önceki öğeye (yoksa metin kutusuna, o da yoksa yüzen düğmeye) döner. */
  const closeCard = useCallback((expectedId?: string) => {
    if (expectedId && pendingRef.current?.pendingId !== expectedId) return;
    const active = typeof document === "undefined" ? null : document.activeElement;
    const hadFocus = Boolean(active && cardRef.current?.contains(active));
    const wasDialog = pendingSurface(pendingRef.current) === "dialog";
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    pendingRef.current = null;
    milestoneRef.current = null;
    focusCardRef.current = false;
    if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current);
    armTimerRef.current = null;
    setPending(null);
    setPendingBusy(false);
    setPendingArmed(true);
    setDialogAnnounce(undefined);
    if (wasDialog) {
      // Modal pencere kapanınca (`close()`) odak açan öğeye döner; o öğe kalktıysa odak gövdeye düşer: metin kutusu ya
      // da yüzen düğme.
      window.setTimeout(() => {
        const now = document.activeElement;
        if (now && now !== document.body && !now.closest("dialog:not([open])")) return;
        const input = inputRef.current;
        if (input && !input.disabled) input.focus();
        else buttonRef.current?.focus();
      }, SCREEN_ANNOUNCE_DELAY_MS);
      return;
    }
    if (!hadFocus) return;
    window.setTimeout(() => {
      if (previous?.isConnected && !previous.hasAttribute("disabled")) previous.focus();
      if (previous && document.activeElement === previous) return;
      const input = inputRef.current;
      if (input && !input.disabled) input.focus();
      else buttonRef.current?.focus();
    }, 0);
  }, []);

  /**
   * Oturum sonu (Faz 5): süre (yalnızca saniye) sunucunun verdiği oturum kimliğiyle (`sessionRef`) olay ucuna
   * `session_ended` olarak bildirilir; kuruluşun aylık dakika bütçesi bunlardan toplanır. Bağlantı kurulmuş her oturum için bir kez; bekletmez, hatası yutulur. Sayfa kapanırken
   * (`keepalive`) `fetch(..., { keepalive: true })` kullanılır: `sendBeacon` JSON içerik türünü her tarayıcıda
   * göndermez ve olay ucu `application/json` ile `sameOrigin` (Origin başlığı) ister. Bağlantı kesilmeden önce
   * çağrılmalıdır (konuşma kimliği bağdaştırıcıdan okunur). Döner: oturum süre sınırında mı bitti.
   */
  const finishSession = useCallback((keepalive = false): boolean => {
    const startedAt = sessionStartRef.current;
    const now = Date.now();
    sessionStartRef.current = null;
    sessionMilestoneRef.current = null;
    setSessionStartedAt(null);
    setSessionLeft(null);
    const event: AssistantEvent | null = sessionEndedEvent(
      startedAt,
      now,
      sessionRefRef.current,
      adapterRef.current?.getConversationId(),
    );
    if (event) {
      if (keepalive) {
        try {
          void fetch("/api/assistant/events", {
            method: "POST",
            keepalive: true,
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event),
          }).catch(() => undefined);
        } catch {
          // Sayfa kapanıyor: bildirilemeyen süre bütçeye sayılmaz (ElevenLabs paneli asıl kaynaktır).
        }
      } else {
        void api("/api/assistant/events", "POST", event).catch(() => undefined);
      }
    }
    return reachedSessionLimit(startedAt, now, sessionMaxRef.current);
  }, []);

  /** Dinleyiciler bırakılır; bekleyen eylem iptal edilir (denetime `cancelled`) ve kart kapanır. */
  const detach = useCallback(() => {
    for (const off of unsubscribeRef.current) off();
    unsubscribeRef.current = [];
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    uiResolvingRef.current = null;
    if (pendingRef.current) closeCard();
  }, [closeCard]);

  /**
   * Oturumu kapatır. `refocus: false` (uzak kopma, süre sınırı, ajanın kapatma aracı): odak yalnızca kaybolmuşsa
   * (gövdede ya da asistanın içindeydi) düğmeye döner; kullanıcı başka bir alanda yazıyorsa odağa dokunulmaz.
   */
  const stop = useCallback(
    async (opts: { announce?: boolean; refocus?: boolean } = {}) => {
      const adapter = adapterRef.current;
      const timeLimit = finishSession();
      detach();
      adapterRef.current = null;
      startingRef.current = false;
      setPhase((p) => (p === "disabled" ? p : "idle"));
      setStatus("disconnected");
      setMode("listening");
      setAwaitingReply(false);
      setToolsRunning(0);
      setLines([]);
      setNotice("");
      setError("");
      setTextOnly(false);
      const max = sessionMaxRef.current;
      if (timeLimit && max) {
        // Süre sınırı (tarayıcı ya da ajan kapattı): kibar duyuru; ajan da süre sonu iletisini söyler.
        dispatchLive({ type: "status", text: t("assistant.session.timeLimit", lang).replace("{minutes}", sessionMinutesLabel(max, lang)) });
      } else if (opts.announce !== false) dispatchLive({ type: "status", text: t("assistant.ended", lang) });
      try {
        await adapter?.end();
      } catch {
        // Kapanış hatası kullanıcıya gösterilmez; oturum zaten bırakıldı.
      }
      const focused = typeof document === "undefined" ? null : document.activeElement;
      const focusLost = !focused || focused === document.body || Boolean(rootRef.current?.contains(focused));
      if (opts.refocus !== false || focusLost) buttonRef.current?.focus();
    },
    [detach, finishSession, lang],
  );

  const fail = useCallback(
    async (message: string) => {
      const adapter = adapterRef.current;
      finishSession();
      detach();
      adapterRef.current = null;
      startingRef.current = false;
      setStatus("disconnected");
      setAwaitingReply(false);
      setToolsRunning(0);
      setError(message);
      setPhase("error");
      try {
        await adapter?.end();
      } catch {
        // yut
      }
    },
    [detach, finishSession],
  );

  const onBridgeReady = useCallback((adapter: ElevenLabsAdapter) => {
    elevenRef.current = adapter;
    const waiters = elevenWaiters.current;
    elevenWaiters.current = [];
    for (const resolve of waiters) resolve(adapter);
  }, []);

  function loadElevenLabs(): Promise<ElevenLabsAdapter> {
    if (elevenRef.current) return Promise.resolve(elevenRef.current);
    setBridgeWanted(true);
    return new Promise<ElevenLabsAdapter>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("bridge-timeout")), 15_000);
      elevenWaiters.current.push((adapter) => {
        window.clearTimeout(timer);
        resolve(adapter);
      });
    });
  }

  function addLine(role: TranscriptLine["role"], text: string) {
    const clean = text.trim();
    if (!clean) return;
    lineId.current += 1;
    const line = { id: lineId.current, role, text: clean };
    setLines((current) => appendLine(current, line));
  }

  async function connect() {
    if (startingRef.current) return;
    startingRef.current = true;
    setError("");
    setNotice("");
    setLines([]);
    setPhase("connecting");

    let session: AssistantSessionResponse;
    try {
      session = await api<AssistantSessionResponse>("/api/assistant/session", "POST");
    } catch (err) {
      startingRef.current = false;
      if (err instanceof ApiError && err.status === 404) {
        try {
          safeStorage("session")?.setItem(DISABLED_SESSION_KEY, "1");
        } catch {
          // yut
        }
        setPhase("disabled");
        dispatchLive({ type: "status", text: t("assistant.error.disabled", lang) });
        return;
      }
      await fail(t(startErrorKey(err), lang));
      return;
    }

    if (!startingRef.current) return; // Kullanıcı istek sürerken vazgeçti.
    setAssistantName(session.assistantName || appName);
    // Süre sınırı bağlantı kurulunca işlemeye başlar (`status: connected`).
    sessionMaxRef.current =
      typeof session.maxSessionSeconds === "number" && session.maxSessionSeconds > 0 ? session.maxSessionSeconds : null;
    sessionRefRef.current = typeof session.sessionRef === "string" ? session.sessionRef : null;

    let adapter: VoiceSessionAdapter;
    let useText = false;
    try {
      if (session.mock) {
        adapter = new MockAdapter();
        useText = true;
        setNotice(t("assistant.notice.mock", lang));
      } else {
        setPhase("permission");
        const mic = await microphoneAvailable();
        if (!startingRef.current) return; // Kullanıcı bu arada vazgeçti.
        useText = !mic;
        if (!mic) setNotice(t("assistant.notice.textOnly", lang));
        setPhase("connecting");
        adapter = await loadElevenLabs();
      }
    } catch {
      await fail(t("assistant.error.start", lang));
      return;
    }
    if (!startingRef.current) return;
    setTextOnly(useText);

    const runtime = createToolRuntime({
      role: session.role as Role,
      canApproveSpend: session.canApproveSpend,
      lang: session.language,
      router: { push: (href: string) => routerRef.current.push(href) },
      getConversationId: () => adapter.getConversationId(),
      openLeadSearch: openLeadSearchRef.current ? () => openLeadSearchRef.current?.() : undefined,
      stop: () => {
        // Ajan "kapat" dediğinde: yanıtını bitirsin diye kısa bir gecikmeyle kapanır.
        window.setTimeout(() => void stop({ refocus: false }), 600);
      },
    });
    // Araç çalışırken "düşünüyor" gösterilir. Sarmalayıcı da hiçbir zaman fırlatmaz. ElevenLabs ajanı kayıttaki tüm
    // araçları bilir: role bağlanmayanlar "yetkiniz yok" saplamasıyla yanıtlanır (tanımsız araç SDK hatası olmasın).
    // Senaryolu ajan eksik aracı kendisi "yetkiniz yok" ile yanıtlar.
    const toolSet = adapter.kind === "elevenlabs" ? { ...runtime.deniedTools, ...runtime.clientTools } : runtime.clientTools;
    const clientTools: Record<string, ClientToolFn> = {};
    for (const [name, fn] of Object.entries(toolSet)) {
      clientTools[name] = async (params: unknown) => {
        setToolsRunning((n) => n + 1);
        try {
          return await fn(params);
        } finally {
          setToolsRunning((n) => Math.max(0, n - 1));
        }
      };
    }

    detach();
    adapterRef.current = adapter;
    runtimeRef.current = runtime;
    unsubscribeRef.current = [
      runtime.onPendingChange((view, reason, ended) => {
        if (view) showCard(view);
        else endCard(reason, ended);
      }),
      adapter.on("status", (next) => {
        setStatus(next);
        if (next === "connected") {
          startingRef.current = false;
          setPhase("active");
          if (sessionStartRef.current === null) {
            const startedAt = Date.now();
            sessionStartRef.current = startedAt;
            setSessionStartedAt(startedAt);
          }
        } else if (next === "disconnected" && adapterRef.current === adapter) {
          // Bağlanırken kopma bir hatadır; konuşma sırasında kopma (ajan ya da süre sınırı) oturumu kapatır.
          if (startingRef.current) void fail(t("assistant.error.connection", lang));
          else void stop({ refocus: false });
        }
      }),
      adapter.on("mode", (next) => {
        setMode(next);
        if (next === "speaking") setAwaitingReply(false);
      }),
      adapter.on("message", (message) => {
        addLine(message.role, message.text);
        if (message.role === "user") {
          // Ajan yolundaki onay, eylem oluştuktan sonra gelen açık bir kullanıcı onayı ister (runtime denetler).
          runtime.noteUserTurn(message.text);
          setAwaitingReply(true);
        } else {
          setAwaitingReply(false);
          dispatchLive({ type: "reply", text: `${session.assistantName || appName}: ${message.text}` });
        }
      }),
      adapter.on("error", () => {
        void fail(t("assistant.error.connection", lang));
      }),
    ];

    try {
      await adapter.start({
        credentials: session,
        clientTools,
        // Yalnızca ajanda açık olduğu belgelenen geçersiz kılmalar: dil (ve mikrofon yoksa metin kipi).
        overrides: { language: session.language },
        textOnly: useText,
        // Ajan istemindeki `{{assistant_name}}` ve `{{user_role}}` (eşitleme betiği bunların hepsini bekler).
        dynamicVariables: assistantDynamicVariables(session, appName),
        assistantName: session.assistantName || appName,
      });
    } catch {
      await fail(t("assistant.error.start", lang));
    }
  }

  /**
   * İleti bölgesine duyuru. Modal onay penceresi açıkken sayfanın canlı bölgeleri inert olduğundan, pencere kapanırken
   * yapılan duyuru (`afterDialog`) pencere kapanana dek bekletilir.
   */
  function announce(text: string, afterDialog = false) {
    if (!afterDialog) {
      dispatchLive({ type: "message", text });
      return;
    }
    window.setTimeout(() => dispatchLive({ type: "message", text }), SCREEN_ANNOUNCE_DELAY_MS);
  }

  /** Bağlam iletisi ajana (kişisel veri içermez); hata yutulur. */
  function tellAgent(outcome: PendingOutcome, tool: string, error?: string, result?: string) {
    try {
      adapterRef.current?.sendContextualUpdate(pendingContextUpdate(outcome, tool, error, result));
    } catch {
      // Bağlam iletisi gönderilemezse ajan bir sonraki araç sonucundan durumu öğrenir.
    }
  }

  /**
   * Bekleyen eylem oluştu (ya da öncekinin yerine yenisi geldi).
   * - Odak asistan dışında bir öğedeyse ya da kullanıcı yazıyorsa çalınmaz; ileti bölgesi yalnızca kısa bir "kart
   *   açıldı" duyurusu yapar (özeti ajan yanıtı zaten okur, iki kez duyurulmaz).
   * - Odak gövdede, yüzen düğmede ya da paneldeyse kart kabına (başlık + özet okunur) taşınır; "Onayla"ya değil.
   * - Kart odaktayken eylem değiştiyse odak kart kabına alınır (zaten oradaysa yeni özet ayrıca duyurulur).
   * - "Onayla" her yeni eylemde kısa süre (`CONFIRM_ARM_MS`) etkin olmaz.
   */
  function showCard(view: PendingView) {
    if (pendingSurface(view) !== "card") {
      // R2/R3: modal pencere odağını kendisi yönetir (açılınca "Vazgeç"e) ve "Onayla"yı kendisi geciktirir; kartın odak
      // kuralları uygulanmaz. Pencere açıkken yerine yenisi geldiyse pencerenin kendi bölgesi duyurur.
      const replacing = pendingSurface(pendingRef.current) === "dialog";
      restoreFocusRef.current = null;
      focusCardRef.current = false;
      pendingRef.current = view;
      milestoneRef.current = null;
      if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
      setPendingBusy(false);
      setPendingArmed(false);
      setClock(Date.now());
      setPending(view);
      setDialogAnnounce((prev) =>
        replacing ? { text: t("assistant.pending.replaced", lang).replace("{summary}", view.summary), seq: (prev?.seq ?? 0) + 1 } : undefined,
      );
      return;
    }
    const active = typeof document === "undefined" ? null : document.activeElement;
    const card = cardRef.current;
    const cardHasFocus = Boolean(active && card?.contains(active));
    const move = shouldFocusCard({
      activeIsBody: !active || active === document.body,
      activeInAssistant: Boolean(active && rootRef.current?.contains(active)),
      activeIsEditable: isEditable(active),
      cardHasFocus,
    });
    if (move && !cardHasFocus) restoreFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    const containerFocused = cardHasFocus && active === card;
    focusCardRef.current = move && !containerFocused;
    pendingRef.current = view;
    milestoneRef.current = null;
    setPendingBusy(false);
    setPendingArmed(false);
    if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current);
    armTimerRef.current = window.setTimeout(() => {
      armTimerRef.current = null;
      if (pendingRef.current?.pendingId === view.pendingId) setPendingArmed(true);
    }, CONFIRM_ARM_MS);
    setClock(Date.now());
    setPending(view);
    if (containerFocused) {
      // Odak zaten kart kabında: yeniden odaklamak okunmaz; yeni özet açıkça duyurulur.
      dispatchLive({ type: "message", text: t("assistant.pending.replaced", lang).replace("{summary}", view.summary) });
    } else if (!move) {
      dispatchLive({ type: "message", text: `${t("assistant.pending.shown", lang)} ${t("assistant.pending.typeHint", lang)}` });
    }
  }

  /**
   * Bekleyen eylem bitti. Yalnızca ekrandan çözülmekte olan eylemin kendi bitişi atlanır (sonucu tıklama işleyicisi
   * bildirir); başka bir eylemin bitişi (ör. ekrandaki onay sürerken sesle onaylanan ya da süresi dolan yenisi) kartını
   * kapatır.
   */
  function endCard(reason: PendingEndReason | undefined, ended: PendingView | undefined) {
    // Yerine yenisi geldi: hemen ardından gelen "oluştu" kartı günceller.
    if (reason === "replaced") return;
    if (ended && uiResolvingRef.current === ended.pendingId) return;
    const view = ended ?? pendingRef.current;
    const wasDialog = pendingSurface(view) === "dialog";
    closeCard(view?.pendingId);
    if (reason === "expired" && view) {
      announce(t("assistant.pending.expired", lang), wasDialog);
      tellAgent("expired", view.tool);
    }
    // Sesli onay/iptal: sonucu ajan zaten biliyor ve söyleyecek.
  }

  /** Ekrandaki "Onayla": yalnızca kartın gösterdiği eylem (`expectedId`) hâlâ bekliyorsa ve kart etkinse. */
  async function confirmPending(expectedId: string) {
    const runtime = runtimeRef.current;
    const view = pendingRef.current;
    if (!runtime || !view || view.pendingId !== expectedId || uiResolvingRef.current === view.pendingId) return;
    // R2/R3 kartla onaylanmaz (runtime da reddeder); yalnızca modal penceredeki tıklama.
    if (pendingSurface(view) !== "card") return;
    if (armTimerRef.current !== null) return; // Kart yeni açıldı/değişti: "Onayla" henüz etkin değil.
    uiResolvingRef.current = view.pendingId;
    setPendingBusy(true);
    setToolsRunning((n) => n + 1);
    let result: string;
    try {
      result = await runtime.pending.confirm(view.pendingId);
    } finally {
      setToolsRunning((n) => Math.max(0, n - 1));
      if (uiResolvingRef.current === view.pendingId) uiResolvingRef.current = null;
    }
    if (runtimeRef.current !== runtime) return; // Oturum bu arada kapandı.
    const outcome = parsePendingResult(result, KNOWN_AGENT_ERRORS);
    closeCard(view.pendingId);
    if (outcome.ok) {
      dispatchLive({ type: "message", text: t("assistant.action.done", lang) });
      // Sonuç (ref'ler, üretilen metin) ajana iletilir: sesli onayda döndürülenle aynı, temizlenmiş JSON.
      tellAgent("confirmed", view.tool, undefined, result);
    } else {
      const text = t("assistant.pending.failed", lang);
      dispatchLive({ type: "message", text: outcome.error ? `${text} ${outcome.error}` : text });
      tellAgent("failed", view.tool, outcome.error);
    }
  }

  /**
   * Modal onay penceresindeki "Onayla" (R2/R3'ü çalıştırabilen tek yol). Yalnızca pencerenin gerçek tıklama
   * işleyicisinden (`isTrusted`, düğme etkinken başlamış basış) ve yalnızca pencerenin gösterdiği eylem hâlâ bekliyorsa.
   * Ajan, ses ya da klavye kısayolu buraya ulaşmaz. Sonuç (temizlenmiş JSON) bağlam iletisiyle ajana gider.
   */
  async function confirmScreenPending(expectedId: string, trusted: boolean) {
    const runtime = runtimeRef.current;
    const view = pendingRef.current;
    if (!runtime || !screenConfirmTarget({ clickedId: expectedId, current: view, resolvingId: uiResolvingRef.current, trusted })) return;
    const target = view!;
    uiResolvingRef.current = target.pendingId;
    setPendingBusy(true);
    setToolsRunning((n) => n + 1);
    let result: string;
    try {
      result = await runtime.pending.confirmOnScreen(target.pendingId);
    } finally {
      setToolsRunning((n) => Math.max(0, n - 1));
      if (uiResolvingRef.current === target.pendingId) uiResolvingRef.current = null;
    }
    if (runtimeRef.current !== runtime) return; // Oturum bu arada kapandı.
    const outcome = parsePendingResult(result, KNOWN_AGENT_ERRORS);
    closeCard(target.pendingId);
    if (outcome.ok) {
      announce(t("assistant.action.done", lang), true);
      tellAgent("confirmed", target.tool, undefined, result);
    } else {
      const base = t("assistant.pending.failed", lang);
      const text = outcome.error ? `${base} ${outcome.error}` : base;
      // Harcama/dış etki işleminin başarısızlığı (ör. aylık tavan) panelde de görünür kalır.
      setNotice(text);
      announce(text, true);
      tellAgent("failed", target.tool, outcome.error);
    }
  }

  function cancelPending(expectedId: string) {
    const runtime = runtimeRef.current;
    const view = pendingRef.current;
    if (!runtime || !view || view.pendingId !== expectedId || uiResolvingRef.current === view.pendingId) return;
    const previous = uiResolvingRef.current;
    uiResolvingRef.current = view.pendingId;
    let result: string;
    try {
      result = runtime.pending.cancel(view.pendingId);
    } finally {
      uiResolvingRef.current = previous;
    }
    const wasDialog = pendingSurface(view) === "dialog";
    closeCard(view.pendingId);
    // İptal başarısızsa eylem bu arada süresi dolarak bitmiştir.
    const cancelled = parsePendingResult(result).ok;
    announce(t(cancelled ? "assistant.pending.cancelled" : "assistant.pending.expired", lang), wasDialog);
    tellAgent(cancelled ? "cancelled" : "expired", view.tool);
  }

  // Kart açılınca (odak asistandaysa) odak kart kabına taşınır: başlık ve özet okunur, "Onayla" kazara basılmaz.
  useEffect(() => {
    if (pending && focusCardRef.current) {
      focusCardRef.current = false;
      cardRef.current?.focus();
    }
  }, [pending]);

  // Geri sayım: görünür metin her saniye, duyuru yalnızca eşiklerde (30 ve 10 sn).
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      const left = remainingSeconds(pending.expiresAt, now);
      const milestone = countdownMilestone(left, milestoneRef.current);
      if (milestone === null || uiResolvingRef.current === pending.pendingId) return;
      milestoneRef.current = milestone;
      const text = t("assistant.pending.remaining", lang).replace("{seconds}", String(left));
      // Modal pencere açıkken eşik pencerenin kendi canlı bölgesinden duyurulur.
      if (pendingSurface(pending) === "dialog") setDialogAnnounce((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }));
      else dispatchLive({ type: "message", text });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pending, lang]);

  // Oturum süresi (Faz 5): kalan süre son 30 sn'de görünür, 30 ve 10 sn'de duyurulur; sınır + kısa pay dolunca oturum
  // kibarca kapanır (ajan süre sonu iletisini söyleyip kendisi kapatmadıysa).
  useEffect(() => {
    const max = sessionMaxRef.current;
    if (sessionStartedAt === null || !max) return;
    function tick() {
      const now = Date.now();
      const left = sessionSecondsLeft(sessionStartedAt!, now, max!);
      setSessionLeft(left);
      const milestone = countdownMilestone(left, sessionMilestoneRef.current);
      if (milestone !== null) {
        sessionMilestoneRef.current = milestone;
        dispatchLive({ type: "message", text: t("assistant.session.remaining", lang).replace("{seconds}", String(left)) });
      }
      if (sessionExpired(sessionStartedAt!, now, max!)) void stopRef.current({ announce: false, refocus: false });
    }
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [sessionStartedAt, lang]);

  // Sayfa kapanırken (sekme, yenileme, başka siteye gitme) oturum süresi `keepalive` ile bildirilir.
  useEffect(() => {
    function onPageHide() {
      finishSession(true);
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [finishSession]);

  function begin() {
    if (phase === "disabled" || startingRef.current) return;
    const consented = consentInMemory.current || readConsent(safeStorage("local"), userKey);
    if (!consented) {
      setPhase("consent");
      return;
    }
    void connect();
  }

  async function acceptConsent() {
    setConsentBusy(true);
    const event: AssistantEvent = { type: "consent_given" };
    try {
      await api("/api/assistant/events", "POST", event);
    } catch (err) {
      setConsentBusy(false);
      // Özellik kapalıysa uç 404 döner: düğme gizlenir.
      if (err instanceof ApiError && err.status === 404) {
        setPhase("disabled");
        dispatchLive({ type: "status", text: t("assistant.error.disabled", lang) });
        try {
          safeStorage("session")?.setItem(DISABLED_SESSION_KEY, "1");
        } catch {
          // yut
        }
        return;
      }
      // İzin denetim kaydına yazılamadıysa ses üçüncü tarafa gönderilmez ve izin hatırlanmaz; kullanıcı yeniden dener.
      setError(t(startErrorKey(err), lang));
      setPhase("error");
      return;
    }
    consentInMemory.current = true;
    writeConsent(safeStorage("local"), userKey);
    setConsentBusy(false);
    void connect();
  }

  function cancelConsent() {
    setPhase("idle");
    window.setTimeout(() => buttonRef.current?.focus(), 0);
  }

  function toggle() {
    if (phase === "consent") return;
    if (active || phase === "permission" || phase === "error") void stop();
    else begin();
  }

  function send(text: string) {
    const adapter = adapterRef.current;
    if (!adapter || status !== "connected") return;
    setAwaitingReply(true);
    // Senaryolu ajan kullanıcı satırını (ve turunu) kendisi yayınlar; ElevenLabs metin turunu geri yansıtmayabilir.
    if (adapter.kind !== "mock") {
      addLine("user", text);
      runtimeRef.current?.noteUserTurn(text);
    }
    void Promise.resolve(adapter.sendUserMessage(text)).catch(() => undefined);
  }

  // Kabuğun kısayolu (Ctrl+Shift+Boşluk) ve Esc.
  const toggleRef = useRef(toggle);
  const stopRef = useRef(stop);
  useEffect(() => {
    toggleRef.current = toggle;
    stopRef.current = stop;
  });
  useEffect(() => {
    function onToggle() {
      toggleRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!adapterRef.current && !startingRef.current) return;
      if (otherLayerOpen()) return;
      void stopRef.current();
    }
    window.addEventListener(ASSISTANT_TOGGLE_EVENT, onToggle);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(ASSISTANT_TOGGLE_EVENT, onToggle);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Metin kipinde bağlanınca odak metin kutusuna gider (konuşma yerine yazılacak).
  useEffect(() => {
    if (phase === "active" && textOnly) inputRef.current?.focus();
  }, [phase, textOnly]);

  // Bileşen kalkarken (oturum kapanışı) açık oturum bırakılır.
  useEffect(
    () => () => {
      finishSession(true);
      for (const off of unsubscribeRef.current) off();
      runtimeRef.current?.dispose();
      void adapterRef.current?.end().catch(() => undefined);
    },
    [finishSession],
  );

  const label = useMemo(() => {
    const action =
      active || phase === "error" || phase === "permission" ? t("assistant.actionStop", lang) : t("assistant.actionStart", lang);
    return `${t("assistant.name", lang).replace("{name}", assistantName)}: ${stateText}. ${action}`;
  }, [active, phase, lang, assistantName, stateText]);

  const hidden = !enabled || phase === "disabled" || !role;
  const surface = pendingSurface(pending);
  const pendingRemaining = pending
    ? remainingSeconds(pending.expiresAt, clock || pending.expiresAt - pendingTotalSeconds(pending.risk) * 1000)
    : 0;
  const dialogPending = surface === "dialog" ? pending : null;

  return (
    <div ref={rootRef} className="va-root" data-open={panelOpen ? "true" : "false"} data-covered={covered ? "true" : "false"}>
      {/* Canlı bölgeler her zaman DOM'da (özellik kapalıyken bile): durum ve sonuç `status`, hata `alert`. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {live.status}
      </p>
      {/* Ajan yanıtı ve onay kartı duyuruları ayrı bölgede: durum metni ("Dinliyorum…") yanıtı ezmez. Anahtar, aynı
          metin art arda gelse de yeniden duyurulmasını sağlar. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-live="message">
        <span key={live.messageSeq}>{live.message}</span>
      </p>
      <p className="sr-only" role="alert" aria-atomic="true">
        {error}
      </p>

      {hidden ? null : (
        <>
          {panelOpen ? (
            <AssistantPanel
              id={panelId}
              lang={lang}
              assistantName={assistantName}
              state={uiState}
              stateText={stateText}
              lines={lines}
              notice={notice}
              sessionRemaining={phase === "active" ? sessionLeft : null}
              error={error}
              canSend={phase === "active" && status === "connected"}
              // Hata aşamasında oturum yoktur (başlatma reddedildi ya da bağlantı koptu): yazı kutusu gösterilmez.
              showInput={showsTextInput(phase)}
              inputRef={inputRef}
              getLevel={getLevel}
              onSend={send}
              onEnd={() => void stop()}
              pending={surface === "card" ? pending : null}
              pendingRemaining={pendingRemaining}
              pendingTotal={pendingTotalSeconds("R1")}
              pendingBusy={pendingBusy}
              pendingArmed={pendingArmed}
              cardRef={cardRef}
              confirmRef={confirmRef}
              onConfirmPending={(pendingId) => void confirmPending(pendingId)}
              onCancelPending={cancelPending}
              onRetry={() => {
                // "Tekrar dene" hata bloğuyla birlikte kalkar: odak önce yüzen düğmeye taşınır.
                buttonRef.current?.focus();
                setError("");
                setPhase("idle");
                begin();
              }}
            />
          ) : null}
          <AssistantButton
            ref={buttonRef}
            state={uiState}
            pressed={active}
            label={label}
            stateText={stateText}
            getLevel={getLevel}
            controls={panelOpen ? panelId : undefined}
            unavailable={phase === "consent"}
            onClick={toggle}
          />
          {/* R2/R3: yalnızca bu penceredeki gerçek tıklama onaylar (sesli "evet" ve R1 kartı değil). */}
          <ScreenConfirmDialog
            id={`${panelId}-screen`}
            lang={lang}
            pending={dialogPending}
            confirmation={dialogPending?.confirmation ?? null}
            remaining={pendingRemaining}
            total={dialogPending ? pendingTotalSeconds(dialogPending.risk) : 0}
            busy={pendingBusy}
            announcement={dialogAnnounce}
            onConfirm={(pendingId, trusted) => void confirmScreenPending(pendingId, trusted)}
            onCancel={cancelPending}
          />
          <ConsentDialog
            open={phase === "consent"}
            lang={lang}
            assistantName={assistantName}
            busy={consentBusy}
            onAccept={() => void acceptConsent()}
            onCancel={cancelConsent}
          />
          {bridgeWanted ? <ElevenLabsBridge onReady={onBridgeReady} /> : null}
        </>
      )}
    </div>
  );
}
