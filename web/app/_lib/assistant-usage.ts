import { prisma } from "@admedic/database";
import type { AppEnv } from "@admedic/config";
import { randomBytes } from "node:crypto";
import { quota, type Actor } from "./auth";
import { logAudit } from "./audit";
import { HttpError } from "./http";
import { clampSessionDuration, monthlyBudgetExhausted, nextMonthStartUtc, VOICE_LIMIT_MESSAGES } from "./assistant/limits";

/** Oturum açılış ve sonu denetim kayıtları (konuşma metni yok). */
export const VOICE_SESSION_STARTED = "VOICE_SESSION_STARTED";
export const VOICE_SESSION_ENDED = "VOICE_SESSION_ENDED";

/**
 * Oturum sonu, açılıştan en geç bu kadar saniye (en uzun süreye ek) içinde bildirilebilir. Belirteç alındıktan sonra
 * mikrofon istemi ve bağlantı kurulması da beklenir; daha geç gelen bildirim oturumu bulamaz (404).
 */
export const SESSION_END_LOOKUP_SECONDS = 3600;

/** Sunucunun verdiği oturum kimliği (`/api/assistant/session` yanıtı, `VOICE_SESSION_STARTED.after.sessionRef`). */
export function newVoiceSessionRef(): string {
  return randomBytes(16).toString("hex");
}

/** UTC ayı anahtarı (ör. `2026-10`). */
function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Kuruluşun aylık süre sayacı (`RequestQuota`, `count` = saniye). `session_ended` kaydıyla aynı işlemde artar; bütçe
 * denetimi tek satır okur (denetim kaydı taranmaz). `voice-org:` önekiyle (günlük oturum sayacı) çakışmaz.
 */
export function voiceMinutesKey(orgId: string, now: Date): string {
  return `voice-minutes:${orgId}:${monthKey(now)}`;
}

/** Bir oturumun sonunun kaydedildiğini gösteren tek kullanımlık işaret (benzersiz anahtar; ikinci bildirim 409). */
export function voiceSessionEndedKey(orgId: string, sessionRef: string): string {
  return `voice-session-ended:${orgId}:${sessionRef}`;
}

/**
 * Kuruluşun bu UTC ayında kaydedilen asistan süresi (sn): aylık sayaç satırı (`voiceMinutesKey`). Tek satır okunur;
 * denetim kaydı taranmaz. Bildirilmeyen oturumlar (sekme çöktü, ağ koptu) sayılmaz: bu bir bütçe korumasıdır, fatura
 * değil. Ayrıntılı döküm için denetim kaydı (`VOICE_SESSION_ENDED`) kullanılır (docs/runbook.md).
 */
export async function monthlyVoiceSeconds(orgId: string, now = new Date()): Promise<number> {
  const row = await prisma.requestQuota.findUnique({ where: { key: voiceMinutesKey(orgId, now) }, select: { count: true } });
  return row && row.count > 0 ? row.count : 0;
}

/**
 * Oturum sonu (`session_ended`) kaydı. Sunucu oturumun sahibidir:
 * - `sessionRef` aynı kullanıcının, aynı kuruluştaki, son `max + SESSION_END_LOOKUP_SECONDS` içinde açılmış bir
 *   `VOICE_SESSION_STARTED` satırına ait olmalıdır; değilse 404. Başka kullanıcının oturumu da bulunamaz.
 * - Her oturum bir kez kaydedilir: benzersiz işaret satırı (`voiceSessionEndedKey`) aynı işlemde yazılır; ikinci
 *   bildirim 409 döner ve sayaç artmaz.
 * - Kaydedilen süre = min(bildirilen, max + 30 sn, açılıştan bu yana geçen duvar saati süresi).
 * İşaret, aylık sayaç ve denetim satırı tek işlemdedir. Döner: kaydedilen saniye.
 */
export async function recordVoiceSessionEnd(
  actor: Actor,
  input: { sessionRef: string; durationSeconds: number; conversationId?: string | null },
  env: Pick<AppEnv, "VOICE_ASSISTANT_MAX_SESSION_SECONDS">,
  now = new Date(),
): Promise<number> {
  const max = env.VOICE_ASSISTANT_MAX_SESSION_SECONDS;
  const started = await prisma.auditLog.findFirst({
    where: {
      orgId: actor.orgId,
      userId: actor.userId,
      action: VOICE_SESSION_STARTED,
      createdAt: { gte: new Date(now.getTime() - (max + SESSION_END_LOOKUP_SECONDS) * 1000) },
      after: { path: ["sessionRef"], equals: input.sessionRef },
    },
    select: { createdAt: true },
  });
  if (!started) throw new HttpError(404, "Oturum bulunamadı.");
  const elapsed = Math.max(0, Math.ceil((now.getTime() - started.createdAt.getTime()) / 1000));
  const seconds = Math.min(clampSessionDuration(input.durationSeconds, max), elapsed);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.requestQuota.create({
        data: {
          key: voiceSessionEndedKey(actor.orgId, input.sessionRef),
          count: 1,
          expiresAt: new Date(started.createdAt.getTime() + (max + SESSION_END_LOOKUP_SECONDS) * 1000),
        },
      });
      const key = voiceMinutesKey(actor.orgId, now);
      await tx.requestQuota.upsert({
        where: { key },
        create: { key, count: seconds, expiresAt: nextMonthStartUtc(now) },
        update: { count: { increment: seconds } },
      });
      await logAudit(
        {
          actor,
          action: VOICE_SESSION_ENDED,
          entityType: "VOICE_ASSISTANT",
          entityId: input.conversationId ?? null,
          after: { durationSeconds: seconds, source: "client", sessionRef: input.sessionRef },
        },
        tx,
      );
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") throw new HttpError(409, "Bu oturumun sonu zaten kaydedildi.");
    throw error;
  }
  return seconds;
}

/**
 * Yeni asistan oturumu öncesi kuruluş sınırları (ADR-0028 §9, Faz 5). Kullanıcı başına saatlik sınırdan sonra çağrılır.
 * 1. Aylık dakika bütçesi (`VOICE_ASSISTANT_MONTHLY_MINUTES_PER_ORG` > 0): bu ay kaydedilen süre (aylık sayaç)
 *    bütçeye ulaştıysa 429.
 *    Yalnızca okur; reddedilen istek sayaç tüketmez.
 * 2. Günlük oturum sınırı (`VOICE_ASSISTANT_DAILY_SESSIONS_PER_ORG` > 0): `quota('voice-org:<orgId>', n, 1 gün)`.
 *    Sayaç belirteç alınmadan önce artar (ElevenLabs hatası da bir hak tüketir; mevcut `quota()` davranışı).
 */
export async function enforceVoiceSessionLimits(
  actor: Pick<Actor, "orgId">,
  env: Pick<AppEnv, "VOICE_ASSISTANT_MONTHLY_MINUTES_PER_ORG" | "VOICE_ASSISTANT_DAILY_SESSIONS_PER_ORG">,
  now = new Date(),
): Promise<void> {
  const minutesCap = env.VOICE_ASSISTANT_MONTHLY_MINUTES_PER_ORG;
  if (minutesCap > 0 && monthlyBudgetExhausted(await monthlyVoiceSeconds(actor.orgId, now), minutesCap))
    throw new HttpError(429, VOICE_LIMIT_MESSAGES.monthlyMinutes);
  const dailyCap = env.VOICE_ASSISTANT_DAILY_SESSIONS_PER_ORG;
  if (dailyCap > 0) {
    try {
      await quota(`voice-org:${actor.orgId}`, dailyCap, 86_400);
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) throw new HttpError(429, VOICE_LIMIT_MESSAGES.dailySessions);
      throw error;
    }
  }
}
