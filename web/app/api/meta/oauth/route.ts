import { prisma } from "@admedic/database";
import { requireActor } from "@/_lib/auth";
import { respond, sameOrigin } from "@/_lib/http";
import { loadEnv } from "@admedic/config";
export const maxDuration = 15;
export async function GET(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    loadEnv();
    const appId = process.env.META_APP_ID ?? "";
    const redirectUri = process.env.META_REDIRECT_URI ?? "http://localhost:3000/api/meta/oauth/callback";
    const scopes = ["pages_manage_metadata", "ads_management", "business_management"];
    const state = JSON.stringify({ orgId: actor.orgId, userId: actor.userId });
    const url = `https://www.facebook.com/v26.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${scopes.join(",")}`;
    return { authUrl: url, appId };
  });
}
