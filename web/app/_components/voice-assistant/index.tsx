"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
import { createToolRuntime, type ClientToolFn } from "../../_lib/assistant/runtime";
import { AssistantButton } from "./button";
import { ConsentDialog } from "./consent-dialog";
import { AssistantPanel } from "./panel";
import {
  ASSISTANT_TOGGLE_EVENT,
  DISABLED_SESSION_KEY,
  STATE_LABEL_KEY,
  appendLine,
  deriveUiState,
  isActiveState,
  readConsent,
  safeStorage,
  writeConsent,
  type AssistantPhase,
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

/** Oturum/izin isteği hatası → kullanıcıya gösterilecek ileti anahtarı. */
function startErrorKey(err: unknown): TranslationKey {
  if (!(err instanceof ApiError)) return "assistant.error.unreachable";
  if (err.status === 429) return "assistant.error.rateLimited";
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
  const [announcement, setAnnouncement] = useState("");
  const [assistantName, setAssistantName] = useState(appName);
  const [consentBusy, setConsentBusy] = useState(false);
  const [textOnly, setTextOnly] = useState(false);
  const [bridgeWanted, setBridgeWanted] = useState(false);

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

  // Durum değişince canlı bölge kısa metni duyurur (ajan yanıtı ayrıca duyurulur).
  useEffect(() => {
    if (uiState === "listening" || uiState === "thinking" || uiState === "connecting") setAnnouncement(stateText);
  }, [uiState, stateText]);

  const getLevel = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter) return 0;
    return Math.max(adapter.getInputVolume(), adapter.getOutputVolume());
  }, []);

  const detach = useCallback(() => {
    for (const off of unsubscribeRef.current) off();
    unsubscribeRef.current = [];
  }, []);

  /**
   * Oturumu kapatır. `refocus: false` (uzak kopma, süre sınırı, ajanın kapatma aracı): odak yalnızca kaybolmuşsa
   * (gövdede ya da asistanın içindeydi) düğmeye döner; kullanıcı başka bir alanda yazıyorsa odağa dokunulmaz.
   */
  const stop = useCallback(
    async (opts: { announce?: boolean; refocus?: boolean } = {}) => {
      const adapter = adapterRef.current;
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
      if (opts.announce !== false) setAnnouncement(t("assistant.ended", lang));
      try {
        await adapter?.end();
      } catch {
        // Kapanış hatası kullanıcıya gösterilmez; oturum zaten bırakıldı.
      }
      const focused = typeof document === "undefined" ? null : document.activeElement;
      const focusLost = !focused || focused === document.body || Boolean(rootRef.current?.contains(focused));
      if (opts.refocus !== false || focusLost) buttonRef.current?.focus();
    },
    [detach, lang],
  );

  const fail = useCallback(
    async (message: string) => {
      const adapter = adapterRef.current;
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
    [detach],
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
        setAnnouncement(t("assistant.error.disabled", lang));
        return;
      }
      await fail(t(startErrorKey(err), lang));
      return;
    }

    if (!startingRef.current) return; // Kullanıcı istek sürerken vazgeçti.
    setAssistantName(session.assistantName || appName);

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
    unsubscribeRef.current = [
      adapter.on("status", (next) => {
        setStatus(next);
        if (next === "connected") {
          startingRef.current = false;
          setPhase("active");
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
        if (message.role === "user") setAwaitingReply(true);
        else {
          setAwaitingReply(false);
          setAnnouncement(`${session.assistantName || appName}: ${message.text}`);
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
        setAnnouncement(t("assistant.error.disabled", lang));
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
    // Senaryolu ajan kullanıcı satırını kendisi yayınlar; ElevenLabs metin turunu geri yansıtmayabilir.
    if (adapter.kind !== "mock") addLine("user", text);
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
      for (const off of unsubscribeRef.current) off();
      void adapterRef.current?.end().catch(() => undefined);
    },
    [],
  );

  const label = useMemo(() => {
    const action =
      active || phase === "error" || phase === "permission" ? t("assistant.actionStop", lang) : t("assistant.actionStart", lang);
    return `${t("assistant.name", lang).replace("{name}", assistantName)}: ${stateText}. ${action}`;
  }, [active, phase, lang, assistantName, stateText]);

  const hidden = !enabled || phase === "disabled" || !role;

  return (
    <div ref={rootRef} className="va-root" data-open={panelOpen ? "true" : "false"} data-covered={covered ? "true" : "false"}>
      {/* Canlı bölgeler her zaman DOM'da (özellik kapalıyken bile): durum ve sonuç `status`, hata `alert`. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
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
              error={error}
              canSend={phase === "active" && status === "connected"}
              inputRef={inputRef}
              getLevel={getLevel}
              onSend={send}
              onEnd={() => void stop()}
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
