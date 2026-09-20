import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, listAdAccounts } from "@/lib/meta/client";
import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";

// GET /api/meta/callback?code=...&state=... → token alır ve hesabı kaydeder
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code) {
    return NextResponse.json(
      { error: "Meta'dan onay kodu alınamadı." },
      { status: 400 }
    );
  }

  let clinicId: string | null = null;
  if (state) {
    try {
      clinicId = JSON.parse(Buffer.from(state, "base64url").toString()).clinicId;
    } catch {
      clinicId = null;
    }
  }

  try {
    const clinic = clinicId
      ? await prisma.clinic.findUnique({ where: { id: clinicId } })
      : await getCurrentClinic();
    if (!clinic) {
      return NextResponse.json({ error: "Klinik bulunamadı." }, { status: 404 });
    }

    const { accessToken, expiresIn } = await exchangeCodeForToken(code);
    const accounts = await listAdAccounts(accessToken);

    if (accounts.length === 0) {
      return NextResponse.json(
        { error: "Hesabımızda reklam hesabı (ad account) bulunamadı." },
        { status: 400 }
      );
    }

    const account = accounts[0];
    await prisma.metaAccount.upsert({
      where: { clinicId_adAccountId: { clinicId: clinic.id, adAccountId: account.id } },
      update: { accessToken, tokenExpiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null, active: true },
      create: { clinicId: clinic.id, adAccountId: account.id, accessToken, tokenExpiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null },
    });

    const redirectUrl = new URL(request.nextUrl.origin);
    redirectUrl.pathname = "/meta";
    redirectUrl.searchParams.set("bagli", "1");
    return NextResponse.redirect(redirectUrl);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Meta bağlantısı başarısız" },
      { status: 500 }
    );
  }
}