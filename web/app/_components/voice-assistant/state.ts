/**
 * Sesli asistan arayüz durumu (ADR-0028 §4). Saf modül (React yok): durum türetme, durum metni anahtarları ve
 * kullanıcı başına izin kaydı. Bileşenler ve testler aynı kuralları kullanır.
 */
import type { AdapterMode, AdapterStatus } from "../../_lib/assistant/adapter";
import type { TranslationKey } from "../../_lib/i18n";
import { PENDING_TTL_BY_RISK, type PendingRisk, type PendingView } from "../../_lib/assistant/pending";

/** Kabuğun klavye kısayolu (Ctrl+Shift+Boşluk) bu olayı yayınlar; asistan açılır ya da kapanır. */
export const ASSISTANT_TOGGLE_EVENT = "app:assistant-toggle";

export type AssistantUiState =
  | "idle"
  | "consent"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "disabled";

/** Bileşenin kendi aşaması; bağdaştırıcı durumu ve kipiyle birleşip görünen duruma çevrilir. */
export type AssistantPhase = "idle" | "consent" | "permission" | "connecting" | "active" | "error" | "disabled";

export function deriveUiState(input: {
  phase: AssistantPhase;
  status: AdapterStatus;
  mode: AdapterMode;
  thinking: boolean;
}): AssistantUiState {
  const { phase, status, mode, thinking } = input;
  if (phase === "disabled") return "disabled";
  if (phase === "error" || status === "error") return "error";
  if (phase === "consent" || phase === "permission") return "consent";
  if (phase === "connecting" || status === "connecting") return "connecting";
  if (phase !== "active" || status !== "connected") return "idle";
  if (mode === "speaking") return "speaking";
  if (thinking) return "thinking";
  return "listening";
}

/**
 * Panelde yazı kutusu gösterilir mi? Yalnızca bir oturum açılırken ya da açıkken (izin, bağlanma, etkin). Başlatma
 * reddedildiğinde (günlük/aylık kuruluş sınırı, hız sınırı) ya da oturum hatayla bittiğinde oturum yoktur: panel
 * yalnızca hata iletisini ve "Tekrar dene"yi gösterir.
 */
export function showsTextInput(phase: AssistantPhase): boolean {
  return phase === "permission" || phase === "connecting" || phase === "active";
}

/** Oturum açık ya da açılıyor: düğme "durdur" anlamı taşır (`aria-pressed`). */
export function isActiveState(state: AssistantUiState): boolean {
  return state === "connecting" || state === "listening" || state === "thinking" || state === "speaking";
}

export const STATE_LABEL_KEY: Record<AssistantUiState, TranslationKey> = {
  idle: "assistant.state.idle",
  consent: "assistant.state.consent",
  connecting: "assistant.state.connecting",
  listening: "assistant.state.listening",
  thinking: "assistant.state.thinking",
  speaking: "assistant.state.speaking",
  error: "assistant.state.error",
  disabled: "assistant.state.disabled",
};

/** İzin metni değişirse sürüm artar ve herkesten yeniden izin istenir. */
export const CONSENT_VERSION = 1;
const CONSENT_PREFIX = "assistant-consent";
/** Özellik kapalıysa (oturum ucu 404) sekme boyunca düğme gösterilmez. */
export const DISABLED_SESSION_KEY = "assistant-disabled";

/**
 * Kullanıcı anahtarını tarayıcıya düz yazmamak için kısa özet (FNV-1a, 32 bit). Güvenlik amacı yoktur; yalnızca
 * aynı tarayıcıyı paylaşan iki kullanıcının iznini ayırır. Asıl kayıt denetim kaydındaki `consent_given` olayıdır.
 */
export function hashKey(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Kullanıcı başına izin anahtarı. Anahtar yalnızca kararlı ve benzersiz bir kullanıcı kimliğinden üretilir (görünen ad
 * değil); kimlik bilinmiyorsa `null` döner ve izin hiç okunmaz/yazılmaz (paylaşılan "anonim" anahtar yoktur).
 */
export function consentStorageKey(userKey: string | null | undefined): string | null {
  const key = userKey?.trim();
  return key ? `${CONSENT_PREFIX}:v${CONSENT_VERSION}:${hashKey(key)}` : null;
}

/** Tarayıcı depolaması yoksa, erişim hata verirse (gizli pencere) ya da kullanıcı bilinmiyorsa izin yok sayılır. */
export function readConsent(storage: Pick<Storage, "getItem"> | null | undefined, userKey: string | null | undefined): boolean {
  const key = consentStorageKey(userKey);
  if (!key) return false;
  try {
    return storage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeConsent(storage: Pick<Storage, "setItem"> | null | undefined, userKey: string | null | undefined): void {
  const key = consentStorageKey(userKey);
  if (!key) return;
  try {
    storage?.setItem(key, "1");
  } catch {
    // Depolama kapalı: izin bu sayfa ömrü boyunca bellekte tutulur.
  }
}

/** `window.localStorage` erişimi bile hata fırlatabilir (engellenmiş site verisi). */
export function safeStorage(kind: "local" | "session"): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export interface TranscriptLine {
  id: number;
  role: "user" | "agent";
  text: string;
}

/** Panelde yalnızca son satırlar tutulur (bellekte; kaydedilmez). */
export const TRANSCRIPT_LIMIT = 20;

export function appendLine(lines: TranscriptLine[], line: TranscriptLine): TranscriptLine[] {
  const next = [...lines, line];
  return next.length > TRANSCRIPT_LIMIT ? next.slice(next.length - TRANSCRIPT_LIMIT) : next;
}

/** Ctrl+Shift+Boşluk (macOS: ⌘+Shift+Boşluk değil; Spotlight ile çakışmasın diye yalnızca Ctrl). */
export function isToggleShortcut(e: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "code">): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "Space";
}

// ---------------------------------------------------------------------------------------------------------------
// Canlı bölgeler (ADR-0028 §4, ADR-0021 "kalıcı role=status bölgeleri"). İki ayrı kibar bölge vardır:
// - `status` (role=status): kısa durum metni ("Bağlanıyor…", "Düşünüyor…", "Dinliyorum…") ve oturum iletileri.
// - `message`: ajan yanıtı ve onay kartı duyuruları.
// Eskiden tek bölge vardı ve ajan yanıtı, hemen ardından gelen "Dinliyorum…" ile ekran okuyucu okuyamadan eziliyordu.
// Kurallar:
// - Bağlandıktan sonraki ilk "Dinliyorum…" her zaman hemen duyurulur (mikrofonun açıldığını bildiren tek işaret). Açılış
//   selamı aynı anda gelse de ezilmez: selam kendi bölgesinde kalır.
// - Sonraki yanıtlardan sonra "Dinliyorum…" hemen değil, yanıtın okunması için süre tanındıktan sonra (bkz.
//   `listeningAnnounceDelayMs`) bir kez duyurulur (`deferredStatus` → `flush`). Bu arada kullanıcı yeniden konuşur
//   ya da durum değişirse bekleyen duyuru düşer ("Düşünüyor…" duyurulur).
// ---------------------------------------------------------------------------------------------------------------

export interface LiveRegions {
  status: string;
  message: string;
  /** Aynı metin art arda gelse de yeniden duyurulsun diye ileti düğümünün anahtarı. */
  messageSeq: number;
  /** Son olay bir yanıttı: "dinliyorum" hemen duyurulmaz, ertelenir. */
  quietListening: boolean;
  /** Yanıt okunduktan sonra (`flush`) durum bölgesine yazılacak metin; yoksa `null`. */
  deferredStatus: string | null;
  /** Bu bağlantıda "Dinliyorum…" en az bir kez duyuruldu. */
  listenedSinceConnect: boolean;
}

export const INITIAL_LIVE: LiveRegions = {
  status: "",
  message: "",
  messageSeq: 0,
  quietListening: false,
  deferredStatus: null,
  listenedSinceConnect: false,
};

export type LiveEvent =
  /** Görünen durum değişti (yalnızca bağlanıyor/dinliyor/düşünüyor duyurulur). */
  | { type: "state"; state: AssistantUiState; text: string }
  /** Ajan yanıtı. */
  | { type: "reply"; text: string }
  /** Onay kartı ve geri sayım gibi ileti bölgesine giden kısa duyuru. */
  | { type: "message"; text: string }
  /** Oturum iletisi (kapandı, devre dışı): durum bölgesine yazılır. */
  | { type: "status"; text: string }
  /** Yanıtın okunma süresi doldu: ertelenen durum (varsa) duyurulur. */
  | { type: "flush" };

const ANNOUNCED_STATES: readonly AssistantUiState[] = ["connecting", "listening", "thinking"];

/**
 * Yanıttan sonra ertelenen "Dinliyorum…" duyurusunun beklemesi (ms): ekran okuyucunun yanıtı okuyabileceği kaba süre
 * (karakter başına ~60 ms ≈ dakikada 170 sözcük), en az 1,5 sn, en çok 8 sn.
 */
export function listeningAnnounceDelayMs(reply: string): number {
  return Math.min(8_000, Math.max(1_500, 1_000 + reply.trim().length * 60));
}

function announceStatus(prev: LiveRegions, text: string, patch: Partial<LiveRegions> = {}): LiveRegions {
  return { ...prev, status: text, quietListening: false, deferredStatus: null, ...patch };
}

export function reduceLive(prev: LiveRegions, event: LiveEvent): LiveRegions {
  switch (event.type) {
    case "state": {
      if (!ANNOUNCED_STATES.includes(event.state))
        // Konuşuyor/hata/boşta duyurulmaz; ertelenmiş "dinliyorum" artık geçersizdir.
        return prev.deferredStatus === null ? prev : { ...prev, deferredStatus: null };
      if (event.state === "connecting") return announceStatus(prev, event.text, { listenedSinceConnect: false });
      if (event.state === "listening") {
        if (prev.quietListening && prev.listenedSinceConnect) {
          if (prev.deferredStatus === event.text) return prev;
          return { ...prev, deferredStatus: event.text };
        }
        if (prev.status === event.text && !prev.quietListening)
          return prev.listenedSinceConnect ? prev : { ...prev, listenedSinceConnect: true };
        return announceStatus(prev, event.text, { listenedSinceConnect: true });
      }
      // thinking
      if (prev.status === event.text && !prev.quietListening && prev.deferredStatus === null) return prev;
      return announceStatus(prev, event.text);
    }
    case "flush":
      if (prev.deferredStatus === null) return prev;
      return announceStatus(prev, prev.deferredStatus);
    case "reply": {
      const text = event.text.trim();
      if (!text) return prev;
      // Durum bölgesi boşaltılır: bir sonraki durum yeni bir değişiklik olarak yeniden duyurulur.
      return { ...prev, status: "", message: text, messageSeq: prev.messageSeq + 1, quietListening: true, deferredStatus: null };
    }
    case "message": {
      const text = event.text.trim();
      if (!text) return prev;
      return { ...prev, message: text, messageSeq: prev.messageSeq + 1 };
    }
    case "status":
      return announceStatus(prev, event.text);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Onay kartı (Faz 3, R1). Geri sayım her saniye görünür biçimde güncellenir ama yalnızca eşiklerde duyurulur.
// ---------------------------------------------------------------------------------------------------------------

/** Kalan süre bu saniyelere inince (bir kez) kibarca duyurulur. */
export const PENDING_ANNOUNCE_AT = [30, 10] as const;

export function remainingSeconds(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/**
 * Duyurulacak eşik ya da `null`. `last` en son duyurulan eşiktir (henüz yoksa `null`). Sekme uyutulup süre birden
 * birkaç eşiği atlarsa yalnızca en küçüğü duyurulur; 0'da duyuru yapılmaz (süre dolumu ayrıca duyurulur).
 */
export function countdownMilestone(remaining: number, last: number | null): number | null {
  if (remaining <= 0) return null;
  const hits = PENDING_ANNOUNCE_AT.filter((m) => remaining <= m && (last === null || m < last));
  return hits.length ? Math.min(...hits) : null;
}

/** Kart açıldıktan (ya da yerine yenisi geldikten) sonra "Onayla" bu kadar süre etkin olmaz: yolda olan bir tuş vuruşu
 * ya da tıklama, kullanıcının görmediği eyleme düşmesin. */
export const CONFIRM_ARM_MS = 1_000;

/**
 * Kart açılınca odak kartın kendisine (grup: başlık + özet okunur; "Onayla"ya değil) taşınır mı?
 * - Kart zaten odaktaysa (yerine yenisi geldi): evet, odak kart kabına alınır ve yeni özet okunur.
 * - Kullanıcı bir yazma alanındaysa (panelin metin kutusu dahil): hayır; ileti bölgesi duyurur.
 * - Odak gövdede, yüzen düğmede ya da panelin içindeyse: evet.
 * - Sayfanın başka bir öğesindeyse (bağlantı, düğme): hayır; odak asistan dışından çalınmaz.
 */
export function shouldFocusCard(input: {
  activeIsBody: boolean;
  activeInAssistant: boolean;
  activeIsEditable: boolean;
  cardHasFocus: boolean;
}): boolean {
  if (input.cardHasFocus) return true;
  if (input.activeIsEditable) return false;
  return input.activeIsBody || input.activeInAssistant;
}

export type PendingOutcome = "confirmed" | "failed" | "cancelled" | "expired";

/**
 * Araç sonucu (JSON) → başarı ve ajana aktarılabilecek hata iletisi. Hata metni yalnızca bilinen sabit kalıplara
 * uyuyorsa döner (araç iletileri ve bekleyen eylem hataları); başka her şey atılır.
 */
export function parsePendingResult(result: string, knownErrors: readonly string[] = []): { ok: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false };
  const record = parsed as { ok?: unknown; error?: unknown };
  if (record.ok !== false) return { ok: true };
  const error = typeof record.error === "string" ? record.error : "";
  return isSafeAgentError(error, knownErrors) ? { ok: false, error } : { ok: false };
}

const SAFE_ERROR_PATTERNS: readonly RegExp[] = [
  /^Bu işlem şu an uygulanamıyor: [a-z_]{1,40}$/,
  /^Geçersiz parametre(?: \([A-Za-z0-9_., ]{1,120}\))?$/,
];

function isSafeAgentError(error: string, knownErrors: readonly string[]): boolean {
  if (!error || error.length > 200) return false;
  return knownErrors.includes(error) || SAFE_ERROR_PATTERNS.some((p) => p.test(error));
}

/** Bağlam iletisine eklenen araç sonucu için üst sınır (karakter); aşılırsa sonuç eklenmez. */
export const CONTEXT_RESULT_LIMIT = 4_000;

/**
 * Onaylanan aracın sonucu (araç dağıtıcısının ajana sesli onayda da döndürdüğü, `sanitize.ts`'ten geçmiş JSON) →
 * bağlam iletisine eklenecek metin. Yalnızca başarılı (`ok` false olmayan) bir JSON nesnesi yeniden yazılarak eklenir.
 */
function contextResult(result: string | undefined): string {
  if (!result) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { ok?: unknown }).ok === false) return "";
  const text = JSON.stringify(parsed);
  return text.length <= CONTEXT_RESULT_LIMIT ? text : "";
}

/**
 * Ekrandaki karttan onay/iptal ya da süre dolumundan sonra ajana giden kısa bağlam iletisi (`sendContextualUpdate`).
 * Kişisel veri, özet, kimlik ya da parametre içermez: araç adı, sonuç, (varsa) sabit hata iletisi ve onaylanınca aracın
 * temizlenmiş sonucu (ref'ler, üretilen metin varyantları; sesli onayda ajanın aldığıyla aynı JSON).
 */
export function pendingContextUpdate(outcome: PendingOutcome, tool: string, error?: string, result?: string): string {
  const name = /^[a-z_]{1,64}$/.test(tool) ? ` (${tool})` : "";
  switch (outcome) {
    case "confirmed": {
      const payload = contextResult(result);
      const base = `[Ekran] Kullanıcı bekleyen işlemi${name} ekrandaki Onayla düğmesiyle onayladı; işlem tamamlandı. Yeniden onay isteme, confirm_pending_action çağırma; kısaca bildir.`;
      return payload ? `${base} Araç sonucu (sonraki adımlarda bu ref'leri kullan): ${payload}` : base;
    }
    case "failed":
      return `[Ekran] Kullanıcı bekleyen işlemi${name} ekrandaki Onayla düğmesiyle onayladı ama işlem tamamlanamadı${error ? `: ${error}` : "."} Aynı işlemi kendiliğinden yeniden deneme.`;
    case "cancelled":
      return `[Ekran] Kullanıcı bekleyen işlemi${name} ekrandaki Vazgeç düğmesiyle iptal etti; hiçbir değişiklik yapılmadı. confirm_pending_action çağırma.`;
    case "expired":
      return `[Ekran] Bekleyen işlemin${name} onay süresi doldu; işlem yapılmadı. Kullanıcı isterse işlemi yeniden iste.`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ekrandaki modal onay penceresi (Faz 4, R2/R3). R2/R3 eylemi R1 kartında değil, yalnızca bu pencerede ve yalnızca
// gerçek bir tıklamayla onaylanır (`runtime.pending.confirmOnScreen`). Sesli "evet" ve ajan bunu tetikleyemez.
// ---------------------------------------------------------------------------------------------------------------

/** Bekleyen eylemin gösterildiği yer: R1 → paneldeki kart; R2/R3 (ekran görünümüyle) → modal pencere. */
export type PendingSurface = "card" | "dialog" | "none";

/**
 * R1 → `card`. R2/R3 yalnızca aynı risk seviyesinde bir ekran görünümü (`confirmation`) taşıyorsa → `dialog`; taşımıyorsa
 * (depo bunu zaten reddeder) hiçbir yerde onaylanabilir gösterilmez → `none` (ajan iptal eder ya da süresi dolar).
 */
export function pendingSurface(view: Pick<PendingView, "risk" | "confirmation"> | null | undefined): PendingSurface | null {
  if (!view) return null;
  if (view.risk === "R1") return "card";
  return view.confirmation && view.confirmation.risk === view.risk ? "dialog" : "none";
}

/** Geri sayım çubuğunun toplamı (saniye): risk seviyesinin onay süresi. */
export function pendingTotalSeconds(risk: PendingRisk): number {
  return Math.round(PENDING_TTL_BY_RISK[risk] / 1000);
}

/** Penceredeki onay düğmesi: R3'te ne onaylandığı açıkça yazılır ("Harcamayı onayla"). */
export function screenConfirmLabelKey(risk: "R2" | "R3"): TranslationKey {
  return risk === "R3" ? "assistant.screen.confirmSpend" : "assistant.screen.confirm";
}

/**
 * Penceredeki "Onayla" tıklaması kabul edilir mi?
 * - Tıklama tarayıcının ürettiği gerçek bir olay olmalı (`isTrusted`; betikle `click()` geçmez).
 * - Pencere açıldıktan (ya da eylem değiştikten) sonra `CONFIRM_ARM_MS` geçmiş olmalı (`armed`).
 * - İşlem sürmüyor olmalı (`busy` değil).
 * - İşaretçiyle tıklamada (`fromPointer`) basış da düğme etkinken başlamış olmalı: pencere açılmadan başlayan bir basış,
 *   düğme etkinleştikten sonra bırakılınca onaylamasın. Klavyeyle etkinleştirmede (Enter/Boşluk) odak zaten "Vazgeç"te
 *   açılır; kullanıcı "Onayla"ya bilerek geçmiş olmalıdır.
 */
export function screenClickAllowed(input: {
  trusted: boolean;
  armed: boolean;
  busy: boolean;
  fromPointer: boolean;
  pressStartedArmed: boolean;
}): boolean {
  if (!input.trusted || !input.armed || input.busy) return false;
  return !input.fromPointer || input.pressStartedArmed;
}

/**
 * Üst bileşende ikinci denetim: tıklanan pencerenin eylemi hâlâ bekleyen eylem mi, ekran eylemi mi ve başka bir onay
 * sürmüyor mu? (Pencere bu arada değiştiyse eski tıklama yok sayılır.)
 */
export function screenConfirmTarget(input: {
  clickedId: string;
  current: Pick<PendingView, "pendingId" | "risk" | "confirmation"> | null;
  resolvingId: string | null;
  trusted: boolean;
}): boolean {
  const { clickedId, current, resolvingId, trusted } = input;
  if (!trusted || !current || current.pendingId !== clickedId) return false;
  if (resolvingId === clickedId) return false;
  return pendingSurface(current) === "dialog";
}

/**
 * Modal pencere açıkken sayfanın geri kalanı (asistanın canlı bölgeleri dahil) erişilebilirlik ağacından çıkar
 * (`showModal` → inert). Pencere kapanınca yapılan duyuru, pencere DOM'dan kapanana dek bekletilir.
 */
export const SCREEN_ANNOUNCE_DELAY_MS = 150;
