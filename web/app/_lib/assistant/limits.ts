/**
 * Sesli asistan oturum ve maliyet sınırları (ADR-0028 §9, Faz 5). Saf, izomorfik modül: oturum ucu, olay ucu ve
 * tarayıcıdaki bileşen aynı kuralları kullanır.
 * - Oturum süresi: `VOICE_ASSISTANT_MAX_SESSION_SECONDS` (ajanda `conversation.max_duration_seconds` da aynı değer).
 *   Tarayıcı oturumu bu sürede kibarca kapatır; son `SESSION_WARN_SECONDS` saniyede kalan süreyi gösterir.
 * - Günlük oturum sınırı (kuruluş başına) ve aylık dakika bütçesi oturum ucunda denetlenir; aşılınca 429 ve aşağıdaki
 *   sabit Türkçe ileti döner. Tarayıcı bu iletileri tanıyıp kendi dilindeki metni gösterir.
 */

/** Kalan süre bu değerin altına inince panelde gösterilir (ve bir kez duyurulur). */
export const SESSION_WARN_SECONDS = 30;

/**
 * Bildirilen oturum süresi en çok `max + SESSION_END_GRACE_SECONDS` sayılır: tarayıcı oturumu en geç `max`'ta kapatır,
 * bağlantının kurulması ve kapanış birkaç saniye ekler. Daha uzun bir değer (saat kayması, kurcalanmış istemci) kırpılır.
 */
export const SESSION_END_GRACE_SECONDS = 30;

/** 429 iletileri (sunucu → istemci). Sunucu metni olduğu gibi döner; istemci eşleştirip i18n metnini gösterir. */
export const VOICE_LIMIT_MESSAGES = {
  dailySessions: "Kuruluşunuzun bugünkü sesli asistan oturum sınırı doldu. Yarın yeniden deneyin ya da yöneticinize başvurun.",
  monthlyMinutes: "Kuruluşunuzun bu ayki sesli asistan dakika bütçesi doldu. Yöneticinize başvurun.",
} as const;

/** Bildirilen süre (sn) → kayda yazılacak tam sayı: negatif/NaN 0, üst sınır `max + SESSION_END_GRACE_SECONDS`. */
export function clampSessionDuration(seconds: number, maxSessionSeconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(Math.round(seconds), maxSessionSeconds + SESSION_END_GRACE_SECONDS);
}

/** Oturumun kalan süresi (sn, yukarı yuvarlanmış, en az 0). `startedAt` bağlantının kurulduğu an (ms). */
export function sessionSecondsLeft(startedAt: number, now: number, maxSessionSeconds: number): number {
  return Math.max(0, Math.ceil((startedAt + maxSessionSeconds * 1000 - now) / 1000));
}

/** Kalan süre panelde gösterilsin mi (0 < kalan ≤ SESSION_WARN_SECONDS)? */
export function showSessionRemaining(secondsLeft: number): boolean {
  return secondsLeft > 0 && secondsLeft <= SESSION_WARN_SECONDS;
}

/**
 * Ajan süre sınırında kendi iletisini söyleyip oturumu kapatır (`max_conversation_duration_message`). Tarayıcı bunu
 * kesmemek için sınırdan bu kadar saniye sonra kapatır (ajan kapatmadıysa: senaryolu ajan, eşitlenmemiş ajan).
 */
export const CLIENT_END_GRACE_SECONDS = 3;
/** Sınıra bu kadar saniye kala gelen kopma da "süre sınırı" sayılır (ajanın saati bağlantıyla biraz önce başlar). */
export const SESSION_LIMIT_TOLERANCE_SECONDS = 5;

/** Tarayıcı oturumu artık kapatmalı mı (sınır + `CLIENT_END_GRACE_SECONDS` geçti)? */
export function sessionExpired(startedAt: number, now: number, maxSessionSeconds: number): boolean {
  return now >= startedAt + (maxSessionSeconds + CLIENT_END_GRACE_SECONDS) * 1000;
}

/** Oturum (ajan ya da tarayıcı tarafından) süre sınırında mı kapandı? */
export function reachedSessionLimit(startedAt: number | null, now: number, maxSessionSeconds: number | null): boolean {
  if (startedAt === null || !maxSessionSeconds) return false;
  return now >= startedAt + (maxSessionSeconds - SESSION_LIMIT_TOLERANCE_SECONDS) * 1000;
}

/** Geçen süre (sn, tam sayı); başlangıç yoksa 0. */
export function elapsedSessionSeconds(startedAt: number | null, now: number): number {
  return startedAt === null ? 0 : Math.max(0, Math.round((now - startedAt) / 1000));
}

/** Süre sınırı iletisindeki dakika (en çok bir ondalık: 90 sn → 1,5). */
export function sessionMinutesLabel(maxSessionSeconds: number, lang: "tr" | "en"): string {
  return new Intl.NumberFormat(lang === "en" ? "en-US" : "tr-TR", { maximumFractionDigits: 1 }).format(maxSessionSeconds / 60);
}

/** `events.ts` `Ref` ile aynı kural (modül saf kalsın diye şema içe aktarılmaz). */
const SHORT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Oturum sonu olayı (`POST /api/assistant/events`, `session_ended`). Bağlantı hiç kurulmadıysa (`startedAt` yok) ya da
 * sunucu oturum kimliği vermediyse `null`: bildirilecek oturum yoktur. Kimlikler yalnızca olay şemasının kısa kimlik
 * kuralına uyuyorsa eklenir (oturum kimliği uymuyorsa olay gönderilmez).
 */
export function sessionEndedEvent(
  startedAt: number | null,
  now: number,
  sessionRef: string | null | undefined,
  conversationId?: string | null,
): { type: "session_ended"; sessionRef: string; durationSeconds: number; conversationId?: string } | null {
  if (startedAt === null || !sessionRef || !SHORT_ID.test(sessionRef)) return null;
  const durationSeconds = Math.min(elapsedSessionSeconds(startedAt, now), 86_400);
  return {
    type: "session_ended",
    sessionRef,
    durationSeconds,
    ...(conversationId && SHORT_ID.test(conversationId) ? { conversationId } : {}),
  };
}

/** UTC takvim ayının başlangıcı (aylık dakika bütçesi bu andan itibaren toplanır). */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Sonraki UTC ayının başlangıcı (aylık süre sayacının bitişi). */
export function nextMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Aylık bütçe doldu mu? `minutesCap` 0 ise sınırsızdır. */
export function monthlyBudgetExhausted(usedSeconds: number, minutesCap: number): boolean {
  return minutesCap > 0 && usedSeconds >= minutesCap * 60;
}

/** Sunucunun 429 iletisi → hangi sınır (yoksa `null`; genel hız sınırı). */
export function voiceLimitKind(message: string): "dailySessions" | "monthlyMinutes" | null {
  if (message === VOICE_LIMIT_MESSAGES.dailySessions) return "dailySessions";
  if (message === VOICE_LIMIT_MESSAGES.monthlyMinutes) return "monthlyMinutes";
  return null;
}
