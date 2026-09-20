import { requireActor } from "../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../_lib/http";
import {
  getDraft,
  changeDraft,
  DraftActionSchema,
} from "../../../_lib/studio-service";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  return respond(async () => ({
    draft: await getDraft(await requireActor(), (await context.params).id),
  }));
}
export async function PATCH(request: Request, context: Context) {
  return respond(async () => {
    sameOrigin(request);
    return changeDraft(
      await requireActor(),
      (await context.params).id,
      await body(request, DraftActionSchema),
    );
  });
}
