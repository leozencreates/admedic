import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../../_lib/audit";
export const maxDuration = 30;
const AdaptSchema = z.object({
  creativeId: z.string().min(1),
  size: z.enum(["1200x628", "1080x1080", "1080x1920", "1200x1200"]).optional().default("1200x628"),
  textOverlay: z.string().max(200).optional(),
}).strict();
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const input = await body(request, AdaptSchema);
    const creative = await prisma.creative.findFirst({
      where: { id: input.creativeId, workspaceId: { equals: actor.workspaceId } },
      include: { ads: { select: { id: true, name: true, status: true } }, experimentVariants: { select: { id: true, config: true } } }
    });
    if (!creative) throw new HttpError(404, "Reklam içeriği bulunamadı; silinmiş olabilir. Çok dilli üretim sayfasından yeniden oluşturun.");
    const variants = creative.experimentVariants ?? [];
    const adapted = (variants as Array<{ id: string; config?: { imageUrl?: string } }>).map((variant) => ({
      variantId: variant.id,
      originalUrl: variant.config?.imageUrl ?? null,
      adaptedUrl: `https://mock.admedic.dev/adapt/${creative.id}/${variant.id}/${input.size}.jpg`,
      size: input.size,
      textOverlay: input.textOverlay ?? null,
      status: "PENDING" as const,
    }));
    await logAudit({
      actor,
      action: "CREATIVE_ADAPTED",
      entityType: "CREATIVE",
      entityId: creative.id,
      after: { size: input.size, adaptedVariantCount: adapted.length, textOverlay: input.textOverlay ?? null },
    });
    return { creative: { id: creative.id, name: creative.name, adaptedVariants: adapted, size: input.size } };
  });
}
