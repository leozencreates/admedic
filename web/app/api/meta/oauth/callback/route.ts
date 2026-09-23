import { prisma } from "@admedic/database";
import { respond } from "@/_lib/http";
import { headers } from "next/headers";
import { loadEnv } from "@admedic/config";
export const maxDuration = 15;
export async function GET() {
  return respond(async () => {
    const headersList = await headers();
    const code = headersList.get("x-meta-code") ?? new URLSearchParams(window.location.search).get("code") ?? "";
    const state = headersList.get("x-meta-state") ?? "";
    const error = headersList.get("x-meta-error") ?? "";
    if (error) return new Response(`OAuth error: ${error}`, { status: 400 });
    if (!code) return new Response("Missing code", { status: 400 });
    const parsed = JSON.parse(decodeURIComponent(state ?? "{}"));
    loadEnv();
    const appId = process.env.META_APP_ID ?? "";
    const appSecret = process.env.META_APP_SECRET ?? "";
    const redirectUri = process.env.META_REDIRECT_URI ?? "http://localhost:3000/api/meta/oauth/callback";
    const tokenUrl = `https://graph.facebook.com/v26.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return new Response("Token fetch failed", { status: 400 });
    const { orgId } = parsed;
    if (orgId) {
      const existing = await prisma.metaConnection.findFirst({ where: { orgId, type: "BUSINESS_MANAGER" } });
      if (existing) {
        await prisma.metaConnection.update({ where: { id: existing.id }, data: { status: "CONNECTED", metaAccountId: accessToken, expiresAt: new Date(Date.now() + 3600 * 1000 * 24 * 60) } });
      } else {
        await prisma.metaConnection.create({ data: { orgId, type: "BUSINESS_MANAGER", status: "CONNECTED", metaAccountId: accessToken, expiresAt: new Date(Date.now() + 3600 * 1000 * 24 * 60), scopes: ["pages_manage_metadata", "ads_management", "business_management"] } });
      }
    }
    return { success: true };
  });
}
