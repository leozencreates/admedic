import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import { createDraft, SaveSchema } from "../../_lib/studio-service";
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    return {
      drafts: await prisma.studioDraft.findMany({
        where: { workspaceId: actor.workspaceId },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: {
          id: true,
          name: true,
          status: true,
          updatedAt: true,
          version: true,
          content: true,
          policy: true,
          experiment: { select: { id: true } },
        },
      }),
    };
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, SaveSchema);
    return { draft: await createDraft(actor, input.content) };
  });
}
