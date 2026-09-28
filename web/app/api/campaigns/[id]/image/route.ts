import { prisma } from "@admedic/database";
import { createMetaClient, MOCK_AD_ACCOUNT_ID } from "@admedic/meta-api";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { lockCampaignRow, ownedCampaign } from "../../../../_lib/campaign-workflow";
import { decodeAdImage, ImageUploadSchema, MAX_AD_IMAGE_REQUEST_BYTES } from "../../../../_lib/ad-image";
import { requireLiveMetaConnection } from "../../../../_lib/meta-connection";

export const maxDuration = 30;

const EDITABLE = ["DRAFT", "REJECTED"];

/**
 * Reklam görselini Meta reklam hesabının görsel kütüphanesine yükler (`act_{id}/adimages`) ve dönen
 * hash'i kampanyaya yazar. Kütüphanedeki görsel reklam değildir (harcama yok); onay sürecinde
 * incelenir ve yayında kreatiflere `image_hash` olarak girer. Onaydan sonra değiştirilemez.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const input = await body(request, ImageUploadSchema, { maxBytes: MAX_AD_IMAGE_REQUEST_BYTES });
    const image = decodeAdImage(input);
    const campaign = await ownedCampaign(actor, id);
    if (!EDITABLE.includes(campaign.workflowStatus))
      throw new HttpError(409, "Görsel yalnızca taslak veya reddedilmiş kampanyada değiştirilebilir. Onaydaki ya da yayındaki kampanya için yeni kampanya oluşturun.");
    if (!campaign.adAccount.connectionId) throw new HttpError(400, "Meta bağlantısı kurulmamış. Meta bağlantıları sayfasından Meta ile bağlantı kurun.");
    const live = await requireLiveMetaConnection(campaign.adAccount.connectionId, actor.orgId);
    const rawAccountId = campaign.adAccount.metaAccountId ?? (live.mockMode ? MOCK_AD_ACCOUNT_ID : null);
    if (!rawAccountId) throw new HttpError(400, "Reklam hesabının Meta kimliği tanımlı değil. Meta bağlantıları sayfasından Meta ile yeniden bağlanın.");
    const uploaded = await createMetaClient().uploadAdImage(
      rawAccountId.replace(/^act_/, ""),
      { bytesBase64: image.base64, filename: image.filename },
      live.token,
    );
    if (!uploaded.hash) throw new HttpError(502, "Görsel Meta'ya yüklenemedi (Meta görsel kimliği döndürmedi). Birkaç dakika sonra tekrar deneyin.");
    await prisma.$transaction(async (tx) => {
      await lockCampaignRow(tx, actor, id);
      const fresh = await ownedCampaign(actor, id, tx);
      if (!EDITABLE.includes(fresh.workflowStatus))
        throw new HttpError(409, "Kampanya bu sırada onaya gönderildi; görsel bağlanmadı. Sayfayı yenileyip kampanyanın durumunu kontrol edin.");
      await tx.campaign.update({
        where: { id },
        data: { imageHash: uploaded.hash, imageUrl: uploaded.url ?? null },
      });
      await logAudit({
        actor,
        action: "CAMPAIGN_IMAGE_UPLOADED",
        entityType: "CAMPAIGN",
        entityId: id,
        before: { imageHash: fresh.imageHash },
        after: {
          imageHash: uploaded.hash,
          type: image.type,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          filename: image.filename,
        },
      }, tx);
    });
    return {
      campaign: {
        id,
        imageHash: uploaded.hash,
        imageUrl: uploaded.url ?? null,
        image: { type: image.type, bytes: image.bytes, width: image.width, height: image.height },
        warnings: image.warnings,
      },
    };
  });
}
