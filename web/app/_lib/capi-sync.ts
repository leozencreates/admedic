import { prisma, type Lead, type Prisma } from "@admedic/database";
import {
  eventIdFor,
  hashUserData,
  healthAllowedEvents,
  LEAD_STATUS_EVENT,
  postConversionEvents,
  type InternalConversionEvent,
  type MetaActionSource,
} from "@admedic/meta-api";
import { isAdmedicError } from "@admedic/shared";
import { tryDecryptField } from "./encrypt";
import { requireLiveMetaConnection } from "./meta-connection";
import { logAudit } from "./audit";
import { HttpError } from "./http";
import { logger } from "./log";

/**
 * CRM → Meta Conversions API köprüsü (spec 3.9). Lead durum geçişinden offline dönüşüm
 * olayı üretir: rıza kapısı, Pixel/Dataset hedefi (`MetaConnection.pixelId`), idempotency
 * (`ConversionEvent.externalId`), veri minimizasyonu (`custom_data` yalnızca value/currency).
 *
 * `sendLeadStatusConversion(leadId, status)` hiçbir zaman fırlatmaz; `web/app/api/leads/[id]/route.ts`
 * PATCH'i durum güncellemesinden sonra çağırmalıdır (best-effort, sonucu yanıta ekleyebilir).
 */
export type LeadConversionReason =
  | "NO_EVENT_FOR_STATUS"
  | "EVENT_NOT_ALLOWED"
  | "LEAD_NOT_FOUND"
  | "LEAD_LOST"
  | "NO_CONSENT"
  | "NO_PIXEL"
  | "CONNECTION"
  | "META_ERROR";

export interface LeadConversionResult {
  status: "SENT" | "DUPLICATE" | "SKIPPED" | "FAILED";
  reason?: LeadConversionReason;
  message?: string;
  eventName?: InternalConversionEvent;
  eventId?: string;
  conversionEventId?: string;
  eventsReceived?: number;
  mock?: boolean;
}

export interface PixelTarget {
  connectionId: string;
  pixelId: string;
}

/** Organizasyonun CONNECTED bağlantılarından Pixel/Dataset hedefini bulur (PIXEL türü öncelikli). */
export async function resolvePixelTarget(orgId: string): Promise<PixelTarget | null> {
  const conns = await prisma.metaConnection.findMany({
    where: { orgId, status: "CONNECTED", pixelId: { not: null } },
    select: { id: true, type: true, pixelId: true },
    orderBy: { createdAt: "asc" },
  });
  const pick = conns.find((c) => c.type === "PIXEL") ?? conns[0];
  if (!pick?.pixelId?.trim()) return null;
  return { connectionId: pick.id, pixelId: pick.pixelId.trim() };
}

/**
 * Rıza kapısı: `consentGiven` doğru olmalı ve EN SON pazarlama rıza kaydı GRANTED olmalı
 * (geri çekilip yeniden verilen rıza geçerlidir; yalnızca son kayıt belirleyicidir).
 */
export async function leadHasMarketingConsent(lead: Pick<Lead, "id" | "consentGiven">): Promise<boolean> {
  if (!lead.consentGiven) return false;
  const latest = await prisma.consentRecord.findFirst({
    where: { leadId: lead.id, type: "MARKETING" },
    orderBy: [{ createdAt: "desc" }],
    select: { status: true },
  });
  return latest ? latest.status === "GRANTED" : true;
}

export interface SendLeadConversionInput {
  lead: Lead;
  eventName: InternalConversionEvent;
  /** Major birim (örn. 1200 = 1.200 EUR); yalnızca value/currency Meta'ya gider. */
  value?: number | null;
  currency?: string | null;
  actionSource?: MetaActionSource;
  actor?: { orgId: string; workspaceId: string; userId: string } | null;
  /** Olay zamanı (varsayılan şimdi). */
  occurredAt?: Date;
}

/** Lead için tek bir dönüşüm olayı gönderir; fırlatmaz. */
export async function sendLeadConversion(input: SendLeadConversionInput): Promise<LeadConversionResult> {
  const { lead, eventName } = input;
  try {
    if (!healthAllowedEvents().includes(eventName))
      return { status: "SKIPPED", reason: "EVENT_NOT_ALLOWED", message: `Olay türü izin verilmiyor: ${eventName}`, eventName };
    if (lead.status === "LOST")
      return { status: "SKIPPED", reason: "LEAD_LOST", message: "Kayıp lead'e dönüşüm gönderilmez.", eventName };
    if (!(await leadHasMarketingConsent(lead)))
      return { status: "SKIPPED", reason: "NO_CONSENT", message: "Bu lead için pazarlama rızası verilmemiş; CAPI dönüşümü gönderilmedi.", eventName };
    const pixel = await resolvePixelTarget(lead.organizationId);
    if (!pixel) return { status: "SKIPPED", reason: "NO_PIXEL", message: "Meta Pikseli kimliği girilmemiş. Meta bağlantıları sayfasında piksel kimliğini girin.", eventName };

    const occurredAt = input.occurredAt ?? new Date();
    const externalId = eventIdFor({ prefix: "crm", leadId: lead.id, eventName, date: occurredAt });
    const existing = await prisma.conversionEvent.findUnique({ where: { externalId }, select: { id: true } });
    if (existing) return { status: "DUPLICATE", eventName, eventId: externalId, conversionEventId: existing.id };

    let token: string;
    let mockMode: boolean;
    try {
      const live = await requireLiveMetaConnection(pixel.connectionId, lead.organizationId);
      token = live.token;
      mockMode = live.mockMode;
    } catch (err) {
      return { status: "FAILED", reason: "CONNECTION", message: err instanceof HttpError ? err.message : "Meta bağlantısı doğrulanamadı.", eventName };
    }

    const userData = hashUserData({
      email: tryDecryptField(lead.email),
      phone: tryDecryptField(lead.phone),
      firstName: lead.firstName,
      lastName: lead.lastName,
      country: lead.country,
      externalId: lead.lookupHash,
    });
    const value = typeof input.value === "number" && Number.isFinite(input.value) && input.value > 0 ? input.value : undefined;
    const currency = value !== undefined && input.currency ? input.currency.toUpperCase() : undefined;
    let eventsReceived = 0;
    try {
      const result = await postConversionEvents(
        pixel.pixelId,
        [
          {
            eventName,
            eventTime: occurredAt,
            actionSource: input.actionSource ?? "system_generated",
            eventId: externalId,
            userData,
            customData: value !== undefined ? { value, currency } : undefined,
          },
        ],
        token,
      );
      eventsReceived = result.eventsReceived;
      mockMode = result.mock;
    } catch (err) {
      const message = isAdmedicError(err) ? err.message : "Dönüşüm Meta'ya bildirilemedi. Meta bağlantısını kontrol edin; bildirim bir sonraki denemede yeniden gönderilir.";
      return { status: "FAILED", reason: "META_ERROR", message, eventName, eventId: externalId };
    }

    let conversionEventId: string;
    try {
      const created = await prisma.conversionEvent.create({
        data: {
          workspaceId: lead.workspaceId,
          campaignId: lead.campaignId ?? null,
          adSetId: lead.adSetId ?? null,
          adId: lead.adId ?? null,
          type: eventName,
          value: value !== undefined ? Math.round(value * 100) : null,
          currency: currency ?? null,
          source: "CRM",
          externalId,
          occurredAt,
        },
      });
      conversionEventId = created.id;
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "P2002")
        return { status: "DUPLICATE", eventName, eventId: externalId };
      throw err;
    }
    if (input.actor) {
      await logAudit({
        actor: input.actor,
        action: "CRM_CONVERSION",
        entityType: "CONVERSION_EVENT",
        entityId: conversionEventId,
        after: { eventName, leadId: lead.id, leadStatus: lead.status, source: "CRM", eventsReceived, mock: mockMode },
      });
    }
    return { status: "SENT", eventName, eventId: externalId, conversionEventId, eventsReceived, mock: mockMode };
  } catch (err) {
    // PII içermeyen kısa teşhis; çağıranı (lead güncellemesi) asla bozmaz.
    logger.warn(`[capi] lead dönüşümü gönderilemedi (${eventName}): ${err instanceof Error ? err.name : "Error"}`);
    return { status: "FAILED", reason: "META_ERROR", message: "Dönüşüm gönderilemedi.", eventName };
  }
}

/**
 * CRM durum geçişinden otomatik CAPI: CONTACTED→Contact, QUALIFIED→Lead,
 * CONSULTATION_BOOKED→Schedule, TRAVEL_PLANNED→CompleteRegistration, TREATED→Purchase.
 * `web/app/api/leads/[id]/route.ts` PATCH'i durum güncellemesinden SONRA çağırmalıdır.
 */
export async function sendLeadStatusConversion(
  leadId: string,
  status: string,
  options: { actor?: SendLeadConversionInput["actor"]; value?: number | null; currency?: string | null; db?: Prisma.TransactionClient } = {},
): Promise<LeadConversionResult> {
  const eventName = LEAD_STATUS_EVENT[status] ?? null;
  if (!eventName) return { status: "SKIPPED", reason: "NO_EVENT_FOR_STATUS" };
  const lead = await (options.db ?? prisma).lead.findUnique({ where: { id: leadId } });
  if (!lead) return { status: "SKIPPED", reason: "LEAD_NOT_FOUND", eventName };
  return sendLeadConversion({ lead: { ...lead, status: status as Lead["status"] }, eventName, actor: options.actor, value: options.value, currency: options.currency });
}
