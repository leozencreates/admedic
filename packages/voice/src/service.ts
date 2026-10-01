import { encryptField, tryDecryptField } from "@admedic/config";
import type { LeadStatus, Prisma, PrismaClient, VoiceCall } from "@admedic/database";
import { AdmedicError } from "@admedic/shared";

import { notConfigured, VoiceApiError, type VoiceClient } from "./client";
import { firstMessage, voiceLanguage } from "./disclosure";
import {
  CALLABLE_STATUSES,
  CALL_BLOCKER_LABELS,
  callBlockers,
  normalizeE164,
  type CallBlocker,
  type CallFacts,
  type CallTrigger,
} from "./eligibility";
import type { VoiceEvent } from "./webhook";

/**
 * Sesli arama akışı (ADR-0026): müsaitlik değerlendirmesi, arama başlatma, arama sonu olayının işlenmesi ve
 * otomatik arama turu. Web (elle arama, webhook) ve işçi (otomatik tur) aynı işlevleri kullanır.
 * Ajana yalnızca ad, dil ve klinik adı gider; ilgilenilen hizmet ya da konuşma içeriği GÖNDERİLMEZ.
 */

/** Sonucu gelmemiş sayılan durumlar. */
const ACTIVE_STATUSES = ["QUEUED", "INITIATED"] as const;
/** Bu süreden uzun süredir sonucu gelmeyen arama başarısız sayılır (webhook kaçmış olabilir). */
export const STALE_CALL_MS = 2 * 3600_000;
/** Otomatik tur sınırları. */
export const AUTO_CALLS_PER_RUN = 5;
export const AUTO_MAX_ACTIVE_CALLS = 3;
export const AUTO_DAILY_LIMIT = 50;

export interface LeadCallState {
  facts: CallFacts;
  blockers: CallBlocker[];
}

/** Okuma işlevleri hem istemciyle hem transaction içinde çağrılır. */
type Db = Prisma.TransactionClient;

interface LeadRow {
  id: string;
  workspaceId: string;
  organizationId: string;
  firstName: string;
  language: string;
  status: string;
  phone: string | null;
}

const LEAD_SELECT = {
  id: true,
  workspaceId: true,
  organizationId: true,
  firstName: true,
  language: true,
  status: true,
  phone: true,
} as const;

async function callFacts(db: Db, lead: LeadRow): Promise<CallFacts> {
  const [consent, escalated, calls] = await Promise.all([
    db.consentRecord.findFirst({
      where: { leadId: lead.id, workspaceId: lead.workspaceId, type: "PHONE_CALL", status: "GRANTED" },
      select: { id: true },
    }),
    db.conversation.findFirst({
      where: { leadId: lead.id, workspaceId: lead.workspaceId, status: "ESCALATED" },
      select: { id: true },
    }),
    db.voiceCall.findMany({
      where: { leadId: lead.id, workspaceId: lead.workspaceId },
      orderBy: { createdAt: "desc" },
      select: { status: true, outcome: true, durationSecs: true, startedAt: true, createdAt: true },
    }),
  ]);
  // Çevrilmeden reddedilen (startedAt yok) arama deneme sayılmaz.
  const dialed = calls.filter((call) => call.startedAt !== null);
  return {
    status: lead.status,
    phone: tryDecryptField(lead.phone),
    callConsent: consent !== null,
    humanOwned: escalated !== null,
    attempts: dialed.length,
    lastAttemptAt: dialed[0]?.startedAt ?? null,
    activeCall: calls.some((call) => (ACTIVE_STATUSES as readonly string[]).includes(call.status)),
    reached: calls.some((call) => call.status === "COMPLETED" && (call.durationSecs ?? 0) > 0 && call.outcome !== "failure"),
  };
}

/** Lead'in arama durumu: olgular ve engeller. Lead bu çalışma alanında yoksa null. */
export async function leadCallState(
  db: Db,
  ref: { leadId: string; workspaceId: string },
  trigger: CallTrigger,
  now: Date = new Date(),
): Promise<LeadCallState | null> {
  const lead = await db.lead.findFirst({ where: { id: ref.leadId, workspaceId: ref.workspaceId }, select: LEAD_SELECT });
  if (!lead) return null;
  const facts = await callFacts(db, lead);
  return { facts, blockers: callBlockers(facts, trigger, now) };
}

export interface StartCallInput {
  leadId: string;
  workspaceId: string;
  trigger: CallTrigger;
  /** Elle başlatan kullanıcı; otomatik turda null. */
  requestedById: string | null;
  now?: Date;
}

async function clinicName(db: PrismaClient, workspaceId: string): Promise<string> {
  const clinic = await db.clinicProfile.findFirst({
    where: { workspaceId, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { name: true },
  });
  if (clinic?.name) return clinic.name;
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
  return workspace?.name ?? "";
}

/**
 * Müsait lead'i arar. Müsait değilse 409 (engeller iletide); sağlayıcı hatasında arama FAILED olarak kalır ve
 * hata yeniden fırlatılır. Aynı lead için eşzamanlı iki arama başlatılamaz (lead bazlı kilit).
 */
export async function startVoiceCall(db: PrismaClient, client: VoiceClient, input: StartCallInput): Promise<VoiceCall> {
  const now = input.now ?? new Date();
  // Yapılandırma eksikken arama kaydı açılmaz (otomatik tur her seferinde başarısız kayıt üretmesin).
  if (client.missingConfig.length > 0) throw notConfigured(client.missingConfig);
  const queued = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.leadId}), hashtext('voice-call'))`;
    const lead = await tx.lead.findFirst({ where: { id: input.leadId, workspaceId: input.workspaceId }, select: LEAD_SELECT });
    if (!lead) throw new AdmedicError("NOT_FOUND", "Lead bulunamadı; silinmiş olabilir.");
    const facts = await callFacts(tx, lead);
    const blockers = callBlockers(facts, input.trigger, now);
    if (blockers.length > 0)
      throw new AdmedicError(
        "CONFLICT",
        `Bu lead şu an aranamaz: ${blockers.map((b) => CALL_BLOCKER_LABELS[b]).join(" ")}`,
        { blockers },
      );
    const call = await tx.voiceCall.create({
      data: {
        leadId: lead.id,
        workspaceId: lead.workspaceId,
        organizationId: lead.organizationId,
        trigger: input.trigger,
        requestedById: input.requestedById,
        status: "QUEUED",
      },
    });
    await tx.auditLog.create({
      data: {
        orgId: lead.organizationId,
        workspaceId: lead.workspaceId,
        userId: input.requestedById,
        action: "VOICE_CALL_STARTED",
        entityType: "LEAD",
        entityId: lead.id,
        after: { callId: call.id, trigger: input.trigger },
      },
    });
    return { call, lead, phone: normalizeE164(facts.phone)! };
  });

  const { call, lead, phone } = queued;
  const language = voiceLanguage(lead.language);
  const clinic = await clinicName(db, lead.workspaceId);
  try {
    const placed = await client.placeCall({
      toNumber: phone,
      language,
      firstMessage: firstMessage(language, { name: lead.firstName, clinic }),
      dynamicVariables: { call_ref: call.id, lead_first_name: lead.firstName, clinic_name: clinic, language },
    });
    if (client.mock) {
      // Deneme modu: gerçek arama yok, sonuç webhook'u gelmez; kayıt hemen kapatılır.
      return await db.voiceCall.update({
        where: { id: call.id },
        data: {
          status: "COMPLETED",
          conversationId: placed.conversationId,
          providerCallId: placed.providerCallId,
          startedAt: now,
          endedAt: now,
          durationSecs: 0,
          outcome: "unknown",
          summary: encryptField("Deneme modu: gerçek arama yapılmadı."),
        },
      });
    }
    return await db.voiceCall.update({
      where: { id: call.id },
      data: { status: "INITIATED", conversationId: placed.conversationId, providerCallId: placed.providerCallId, startedAt: now },
    });
  } catch (error) {
    await db.voiceCall.update({
      where: { id: call.id },
      data: {
        status: "FAILED",
        endedAt: new Date(),
        failureReason: error instanceof VoiceApiError ? `provider_${error.providerStatus ?? "unreachable"}` : "not_started",
      },
    });
    throw error;
  }
}

export interface ApplyEventResult {
  handled: boolean;
  callId?: string;
}

/**
 * Arama sonu olayını kayda işler. Aynı olay yeniden gelirse (ElevenLabs yeniden denemesi) ikinci kez yazılmaz.
 * Görüşme gerçekleştiyse ve lead hâlâ NEW ise CONTACTED olur.
 */
export async function applyVoiceEvent(db: PrismaClient, event: VoiceEvent, now: Date = new Date()): Promise<ApplyEventResult> {
  if (event.type === "ignored") return { handled: false };
  return db.$transaction(async (tx) => {
    const call =
      (await tx.voiceCall.findUnique({ where: { conversationId: event.conversationId } })) ??
      (event.callRef ? await tx.voiceCall.findUnique({ where: { id: event.callRef } }) : null);
    if (!call) return { handled: false };
    if (!(ACTIVE_STATUSES as readonly string[]).includes(call.status)) return { handled: true, callId: call.id };

    if (event.type === "initiation_failure") {
      const status = event.failureReason === "busy" ? "BUSY" : event.failureReason === "no-answer" ? "NO_ANSWER" : "FAILED";
      await tx.voiceCall.update({
        where: { id: call.id },
        data: { status, conversationId: event.conversationId, failureReason: event.failureReason.slice(0, 60), endedAt: now },
      });
      return { handled: true, callId: call.id };
    }

    const voicemail = /voice\s*mail|answering machine/i.test(event.terminationReason ?? "");
    const status = event.status === "failed" ? "FAILED" : voicemail ? "VOICEMAIL" : "COMPLETED";
    await tx.voiceCall.update({
      where: { id: call.id },
      data: {
        status,
        conversationId: event.conversationId,
        outcome: event.outcome,
        summary: event.summary ? encryptField(event.summary.slice(0, 4000)) : null,
        durationSecs: event.durationSecs,
        failureReason: status === "FAILED" ? (event.terminationReason ?? "failed").slice(0, 60) : null,
        endedAt: now,
      },
    });
    if (status === "COMPLETED" && (event.durationSecs ?? 0) > 0 && event.outcome !== "failure") {
      const moved = await tx.lead.updateMany({ where: { id: call.leadId, status: "NEW" }, data: { status: "CONTACTED" } });
      if (moved.count > 0)
        await tx.auditLog.create({
          data: {
            orgId: call.organizationId,
            workspaceId: call.workspaceId,
            userId: null,
            action: "LEAD_UPDATED",
            entityType: "LEAD",
            entityId: call.leadId,
            before: { status: "NEW" },
            after: { status: "CONTACTED", by: "voice-agent", callId: call.id },
          },
        });
    }
    return { handled: true, callId: call.id };
  });
}

/** Sonucu hiç gelmeyen aramaları kapatır; lead sonsuza dek "arama sürüyor" durumunda kalmaz. */
export async function reapStaleCalls(db: PrismaClient, now: Date = new Date()): Promise<number> {
  const result = await db.voiceCall.updateMany({
    where: { status: { in: [...ACTIVE_STATUSES] }, createdAt: { lt: new Date(now.getTime() - STALE_CALL_MS) } },
    data: { status: "FAILED", failureReason: "no_result", endedAt: now },
  });
  return result.count;
}

export interface AutoCallResult {
  started: number;
  skipped: number;
  failed: number;
}

/**
 * Otomatik arama turu: yalnızca hesap sahibinin açtığı kuruluşlarda (`voiceAutoCallEnabled`), müsait lead'leri
 * en eskiden başlayarak arar. Tur, eşzamanlı ve günlük sınırlarla durur; sağlayıcı sınır hatasında o kuruluş
 * için tur kesilir.
 */
export async function runAutoCalls(
  db: PrismaClient,
  client: VoiceClient,
  options: { now?: Date; organizationId?: string } = {},
): Promise<AutoCallResult> {
  const now = options.now ?? new Date();
  const result: AutoCallResult = { started: 0, skipped: 0, failed: 0 };
  const organizations = await db.organization.findMany({
    where: { voiceAutoCallEnabled: true, ...(options.organizationId ? { id: options.organizationId } : {}) },
    select: { id: true },
  });
  for (const org of organizations) {
    const [active, today] = await Promise.all([
      db.voiceCall.count({ where: { organizationId: org.id, status: { in: [...ACTIVE_STATUSES] } } }),
      db.voiceCall.count({
        where: { organizationId: org.id, startedAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
      }),
    ]);
    let budget = Math.min(AUTO_CALLS_PER_RUN, AUTO_MAX_ACTIVE_CALLS - active, AUTO_DAILY_LIMIT - today);
    if (budget <= 0) continue;
    const candidates = await db.lead.findMany({
      where: {
        organizationId: org.id,
        status: { in: [...CALLABLE_STATUSES] as LeadStatus[] },
        phone: { not: null },
        consentRecords: { some: { type: "PHONE_CALL", status: "GRANTED" } },
      },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { id: true, workspaceId: true },
    });
    for (const candidate of candidates) {
      if (budget <= 0) break;
      const state = await leadCallState(db, { leadId: candidate.id, workspaceId: candidate.workspaceId }, "AUTO", now);
      if (!state || state.blockers.length > 0) {
        result.skipped += 1;
        continue;
      }
      try {
        await startVoiceCall(db, client, {
          leadId: candidate.id,
          workspaceId: candidate.workspaceId,
          trigger: "AUTO",
          requestedById: null,
          now,
        });
        result.started += 1;
        budget -= 1;
      } catch (error) {
        // Bu arada durumu değişen lead (ör. koordinatör devraldı) atlanır.
        const details = error instanceof AdmedicError ? (error.details as { blockers?: unknown } | undefined) : undefined;
        if (details?.blockers) {
          result.skipped += 1;
          continue;
        }
        result.failed += 1;
        // Sağlayıcı ya da yapılandırma hatası sıradaki lead'leri de etkiler; bu kuruluş için tur kesilir.
        break;
      }
    }
  }
  return result;
}
