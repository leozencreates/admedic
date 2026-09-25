import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { postConversionEvents, healthAllowedEvents } from "@admedic/meta-api";
import { loadEnv } from "@admedic/config";
import { z } from "zod";
import { logAudit } from "../../_lib/audit";
import { requireLiveMetaConnection } from "../../_lib/meta-connection";

const CapiSchema = z
  .object({
    eventName: z.string().min(1),
    eventTime: z.string().datetime(),
    actionSource: z.string().min(1),
    userData: z
      .object({
        clientIp: z.string().optional(),
        clientUserAgent: z.string().optional(),
        em: z.string().optional(),
        ph: z.string().optional(),
      })
      .optional(),
    customData: z.record(z.unknown()).optional(),
    eventSourceURL: z.string().optional(),
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
    const { eventName } = input;

    if (!healthAllowedEvents().includes(eventName)) {
      throw new HttpError(
        422,
        `Bu olay türü sağlık kategorisi için izin verilmiyor: ${eventName}`,
      );
    }
    const env = loadEnv();
    const workspace = await prisma.workspace.findUnique({
      where: { id: actor.workspaceId },
      include: { adAccounts: { where: { connectionId: { not: null } }, include: { connection: true } } },
    });
    const adAccount = workspace?.adAccounts?.find((a) => a.isDefault) ?? workspace?.adAccounts?.[0];
    if (!adAccount?.connectionId)
      throw new HttpError(400, "Meta bağlantısı yapılandırılmadı.");
    const live = await requireLiveMetaConnection(adAccount.connectionId, actor.orgId);
    const token = live.token;
    const externalId = `ce_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const result = await postConversionEvents(
      adAccount.id,
      [
        {
          eventName,
          eventTime: input.eventTime,
          actionSource: input.actionSource,
          eventId: externalId,
          userData: input.userData,
          customData: input.customData,
          eventSourceURL: input.eventSourceURL,
        },
      ],
      token,
    );
    const metaResult = result.data[0];
    await prisma.conversionEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        campaignId: input.campaignId ?? null,
        adSetId: input.adSetId ?? null,
        adId: input.adId ?? null,
        type: eventName,
        occurredAt: new Date(input.eventTime),
        source: "META",
        externalId,
        value: (input.customData?.value as number | null) ?? null,
        currency: (input.customData?.currency as string | null) ?? null,
      },
    });
    await logAudit({
      actor,
      action: "CAPI_EVENT",
      entityType: "CONVERSION_EVENT",
      entityId: externalId,
      after: { eventName, externalId, duplicated: metaResult?.isEventDuplicated },
    });
    return {
      eventId: externalId,
      status: metaResult?.isEventDuplicated ? "DUPLICATE" : ("ACCEPTED" as const),
    };
  });
}