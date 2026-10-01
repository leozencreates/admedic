/**
 * Sesli asistan arayüz durumu (ADR-0028 §4). Saf modül (React yok): durum türetme, durum metni anahtarları ve
 * kullanıcı başına izin kaydı. Bileşenler ve testler aynı kuralları kullanır.
 */
import type { AdapterMode, AdapterStatus } from "../../_lib/assistant/adapter";
import type { TranslationKey } from "../../_lib/i18n";

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
