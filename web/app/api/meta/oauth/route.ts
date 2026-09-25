import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../_lib/http";
import { loadEnv } from "@admedic/config";
import { createOAuthState } from "../../../_lib/oauth-state";
import { META_REQUIRED_SCOPES } from "../../../_lib/meta-scopes";
export const maxDuration = 15;
export async function GET(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const env = loadEnv();
    if (!env.META_APP_ID)
      throw new HttpError(
        400,
        "Meta uygulama kimliği ayarlanmamış (META_APP_ID ortam değişkeni).",
      );
    const { state } = createOAuthState(env.AUTH_SECRET, actor.userId, actor.orgId);
    const scopes = [...META_REQUIRED_SCOPES];
    const url = `https://www.facebook.com/${env.META_API_VERSION}/dialog/oauth?client_id=${encodeURIComponent(env.META_APP_ID)}&redirect_uri=${encodeURIComponent(env.META_REDIRECT_URI)}&state=${encodeURIComponent(state)}&scope=${scopes.join(",")}`;
    return { authUrl: url, appId: env.META_APP_ID };
  });
}