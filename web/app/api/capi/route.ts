import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import {
  postConversionEvents,
  healthAllowedEvents,
  hashUserData,
  META_ACTION_SOURCES,
  sha256,
  toMetaEventName,
  type InternalConversionEvent,
} from "@admedic/meta-api";
import { z } from "zod";
import { logAudit } from "../../_lib/audit";
import { requireLiveMetaConnection } from "../../_lib/meta-connection";
import { resolvePixelTarget } from "../../_lib/capi-sync";

export const maxDuration = 15;

/**
 * Genel CAPI olayı (spec 3.9). Veri minimizasyonu: `customData` yalnızca value/currency,
 * `userData` yalnızca izin verilen kimlik alanları (sunucuda hash'lenir). Rıza kapısı:
 * `consentGiven` true olmadan olay gönderilmez.
 */
const CapiSchema = z
  .object({
    eventName: z.string().min(1).max(40),
    eventTime: z.string().datetime(),
    actionSource: z.enum(META_ACTION_SOURCES),
    /** İstemci tarafı tekilleştirme anahtarı (isteğe bağlı; yoksa içerikten türetilir). */
    eventId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
    consentGiven: z.boolean(),
    userData: z
      .object({
        em: z.string().email().optional(),
        ph: z.string().min(5).max(30).optional(),
        fn: z.string().min(1).max(100).optional(),
        ln: z.string().min(1).max(100).optional(),
        country: z.string().length(2).optional(),
        externalId: z.string().min(1).max(200).optional(),
        clientIp: z.string().min(3).max(45).optional(),
        clientUserAgent: z.string().min(1).max(512).optional(),
      })
      .strict()
      .optional(),
    customData: z.object({ value: z.number().nonnegative().optional(), currency: z.string().length(3).optional() }).strict().optional(),
    eventSourceURL: z.string().url().max(2048).optional(),
    campaignId: z.string().optional(),
    adSetId: z.string().optional(),
    adId: z.string().optional(),
  })
  .strict();

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const input = await body(request, CapiSchema);

    const internalName = input.eventName.toUpperCase() as InternalConversionEvent;
    const metaName = toMetaEventName(input.eventName);
    if (!metaName || !healthAllowedEvents().includes(internalName))
      throw new HttpError(422, `Bu olay türü sağlık kategorisi için izin verilmiyor: ${input.eventName}`);
    if (!input.consentGiven)
      throw new HttpError(409, "Rıza (consentGiven) olmadan dönüşüm olayı gönderilmez.");
    if (input.campaignId) {
      const campaign = await prisma.campaign.findFirst({ where: { id: input.campaignId, workspaceId: actor.workspaceId }, select: { id: true } });
      if (!campaign) throw new HttpError(404, "Kampanya bulunamadı.");
    }

    const pixel = await resolvePixelTarget(actor.orgId);
    if (!pixel) throw new HttpError(400, "Pixel/Dataset ID ayarlanmadı.");

    const dedupe = input.eventId
      ? input.eventId
      : sha256(
          [
            internalName,
            input.eventTime,
            input.userData?.em?.trim().toLowerCase() ?? "",
            input.userData?.ph?.replace(/\D/g, "") ?? "",
            input.userData?.externalId ?? "",
            input.customData ? JSON.stringify({ value: input.customData.value ?? null, currency: input.customData.currency ?? null }) : "",
          ].join("|"),
        ).slice(0, 32);
    // İdempotency anahtarı tenant'a özeldir: başka bir organizasyonun aynı eventId'si çakışmaz.
    const externalId = `ce_${sha256(`${actor.orgId}:${dedupe}`).slice(0, 40)}`;
    // İdempotency: aynı olay daha önce kaydedildiyse Meta'ya tekrar gönderilmez.
    const existing = await prisma.conversionEvent.findUnique({ where: { externalId }, select: { id: true } });
    if (existing) return { eventId: externalId, status: "DUPLICATE" as const, duplicate: true, conversionEventId: existing.id };

    const live = await requireLiveMetaConnection(pixel.connectionId, actor.orgId);
    const userData = input.userData
      ? hashUserData({
          email: input.userData.em,
          phone: input.userData.ph,
          firstName: input.userData.fn,
          lastName: input.userData.ln,
          country: input.userData.country,
          externalId: input.userData.externalId,
          clientIp: input.userData.clientIp,
          clientUserAgent: input.userData.clientUserAgent,
        })
      : undefined;
    const value = input.customData?.value;
    const currency = value !== undefined && input.customData?.currency ? input.customData.currency.toUpperCase() : undefined;
    const result = await postConversionEvents(
      pixel.pixelId,
      [
        {
          eventName: internalName,
          eventTime: input.eventTime,
          actionSource: input.actionSource,
          eventId: externalId,
          userData,
          customData: value !== undefined ? { value, currency } : undefined,
          eventSourceURL: input.eventSourceURL,
        },
      ],
      live.token,
    );
    const created = await prisma.conversionEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        campaignId: input.campaignId ?? null,
        adSetId: input.adSetId ?? null,
        adId: input.adId ?? null,
        type: internalName,
        occurredAt: new Date(input.eventTime),
        source: "META",
        externalId,
        value: value !== undefined ? Math.round(value * 100) : null,
        currency: currency ?? null,
      },
    });
    await logAudit({
      actor,
      action: "CAPI_EVENT",
      entityType: "CONVERSION_EVENT",
      entityId: created.id,
      after: { eventName: metaName, externalId, actionSource: input.actionSource, eventsReceived: result.eventsReceived, mock: result.mock },
    });
    return {
      eventId: externalId,
      status: "ACCEPTED" as const,
      duplicate: false,
      conversionEventId: created.id,
      eventsReceived: result.eventsReceived,
      mock: result.mock,
    };
  });
}
