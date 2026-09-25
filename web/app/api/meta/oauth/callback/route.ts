import { prisma } from "@admedic/database";
import { respond, HttpError } from "../../../../_lib/http";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { loadEnv } from "@admedic/config";
import {
  parseOAuthState,
  consumeOAuthState,
  isOAuthStateUsedError,
} from "../../../../_lib/oauth-state";
import { encrypt } from "../../../../_lib/encrypt";
import { requiredScopesMissing } from "../../../../_lib/meta-scopes";
export const maxDuration = 15;

export async function GET(request: Request) {
  return respond(async () => {
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const url = new URL(request.url);
    const error = url.searchParams.get("error");
    if (error) throw new HttpError(400, `Meta yetkisi verilmedi: ${error}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) throw new HttpError(400, "Meta yetkilendirme kodu alınamadı.");
    if (!state) throw new HttpError(400, "OAuth state eksik.");

    const env = loadEnv();
    const parsed = parseOAuthState(state, env.AUTH_SECRET);
    if (!parsed)
      throw new HttpError(400, "OAuth state doğrulanamadı veya süresi dolmuş.");
    if (parsed.userId !== actor.userId || parsed.orgId !== actor.orgId)
      throw new HttpError(403, "OAuth oturumu bu bağlantı isteğiyle eşleşmiyor.");
    try {
      await consumeOAuthState(parsed.orgId, parsed.nonce);
    } catch (e) {
      if (isOAuthStateUsedError(e))
        throw new HttpError(400, "OAuth isteği zaten işlenmiş.");
      throw e;
    }
    if (!env.META_APP_ID || !env.META_APP_SECRET)
      throw new HttpError(
        400,
        "Meta uygulama kimlik bilgileri ayarlanmamış (META_APP_ID/META_APP_SECRET).",
      );

    const tokenUrl = new URL(
      `https://graph.facebook.com/${env.metaGraphApiVersion}/oauth/access_token`,
    );
    tokenUrl.searchParams.set("client_id", env.META_APP_ID);
    tokenUrl.searchParams.set("redirect_uri", env.META_REDIRECT_URI);
    tokenUrl.searchParams.set("client_secret", env.META_APP_SECRET);
    tokenUrl.searchParams.set("code", code);
    const tokenRes = await fetch(tokenUrl.toString());
    const tokenData = await tokenRes.json().catch(() => ({}));
    const accessToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in;
    const grantedScopes = Array.isArray(tokenData.granted_scopes)
      ? tokenData.granted_scopes.map(String)
      : [];
    if (
      !tokenRes.ok ||
      typeof accessToken !== "string" ||
      accessToken.length === 0
    )
      throw new HttpError(400, "Meta erişim tokenı alınamadı.");

    const meUrl = new URL(
      `https://graph.facebook.com/${env.metaGraphApiVersion}/me`,
    );
    meUrl.searchParams.set("fields", "id,name");
    meUrl.searchParams.set("access_token", accessToken);
    const meRes = await fetch(meUrl.toString());
    const meJson = await meRes.json().catch(() => ({}));
    const metaUserId = meJson.id ? String(meJson.id) : null;
    let accountName = meJson.name ? String(meJson.name) : null;
    if (!meRes.ok || !metaUserId)
      throw new HttpError(400, "Meta kullanıcı bilgisi alınamadı.");

    let metaAccountId: string | null = null;
    try {
      const bmUrl = new URL(
        `https://graph.facebook.com/${env.metaGraphApiVersion}/me/businesses`,
      );
      bmUrl.searchParams.set("fields", "id,name");
      bmUrl.searchParams.set("access_token", accessToken);
      const bmRes = await fetch(bmUrl.toString());
      if (bmRes.ok) {
        const bmJson = await bmRes.json().catch(() => ({}));
        const first = Array.isArray(bmJson.data) ? bmJson.data[0] : null;
        if (first?.id) {
          metaAccountId = String(first.id);
          if (first.name) accountName = String(first.name);
        }
      }
    } catch {
      // Business Manager keşfi kritik değil; bağlantı yine de kurulur.
    }

    const ttlMs =
      typeof expiresIn === "number" && expiresIn > 0
        ? expiresIn * 1000
        : 60 * 24 * 60 * 60 * 1000;
    const tokenCiphertext = encrypt(accessToken);
    const missingPermissions = requiredScopesMissing(grantedScopes);
    const data = {
      status: "CONNECTED" as const,
      name: accountName,
      metaAccountId,
      metaUserId,
      tokenCiphertext,
      scopes: grantedScopes,
      appId: env.META_APP_ID,
      expiresAt: new Date(Date.now() + ttlMs),
      missingPermissions,
      lastError: null as string | null,
    };

    const existing = await prisma.metaConnection.findFirst({
      where: { orgId: actor.orgId, type: "BUSINESS_MANAGER" },
      select: { id: true },
    });
    if (existing) {
      await prisma.metaConnection.update({ where: { id: existing.id }, data });
    } else {
      await prisma.metaConnection.create({
        data: { orgId: actor.orgId, type: "BUSINESS_MANAGER", ...data },
      });
    }
    await prisma.auditLog.create({
      data: {
        orgId: actor.orgId,
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        action: "META_CONNECTED",
        entityType: "META_CONNECTION",
        after: { type: "BUSINESS_MANAGER", metaUserId },
      },
    });
    return { success: true };
  });
}