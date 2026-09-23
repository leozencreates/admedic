import { prisma } from "@admedic/database";
import { requireActor } from "@/_lib/auth";
import { respond, sameOrigin, HttpError } from "@/_lib/http";
import { loadEnv } from "@admedic/config";
import { createOAuthState } from "@/_lib/oauth-state";
export const maxDuration = 15;
export async function GET(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const env = loadEnv();
    if (!env.META_APP_ID)
      throw new HttpError(
        400,
        "Meta uygulama kimliği ayarlanmamış (META_APP_ID ortam değişkeni).",
      );
    const { state } = createOAuthState(env.AUTH_SECRET, actor.userId, actor.orgId);
    const scopes = ["business_management", "ads_management", "ads_read", "pages_manage_metadata", "pages_show_list"];
    const url = `https://www.facebook.com/${env.META_API_VERSION}/dialog/oauth?client_id=${encodeURIComponent(env.META_APP_ID)}&redirect_uri=${encodeURIComponent(env.META_REDIRECT_URI)}&state=${encodeURIComponent(state)}&scope=${scopes.join(",")}`;
    return { authUrl: url, appId: env.META_APP_ID };
  });
}