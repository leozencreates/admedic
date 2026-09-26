import { requireActor } from "../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../_lib/http";
import {
  getDraft,
  changeDraft,
  DraftActionSchema,
  PolicyWarningError,
} from "../../../_lib/studio-service";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  return respond(async () => ({
    draft: await getDraft(await requireActor(), (await context.params).id),
  }));
}
export async function PATCH(request: Request, context: Context) {
  // Orta risk uyarısı: 422 gövdesinde `policyWarning` (kural bulguları + LLM gerekçesi) döner.
  const captured: { warning: PolicyWarningError | null } = { warning: null };
  const response = await respond(async () => {
    sameOrigin(request);
    try {
      return await changeDraft(
        await requireActor(),
        (await context.params).id,
        await body(request, DraftActionSchema),
      );
    } catch (error) {
      if (error instanceof PolicyWarningError) captured.warning = error;
      throw error;
    }
  });
  if (captured.warning) {
    return Response.json(
      { error: captured.warning.message, policyWarning: captured.warning.policyWarning },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  return response;
}
