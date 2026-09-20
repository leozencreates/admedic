import { NextResponse } from "next/server";
import { buildOAuthUrl } from "@/lib/meta/client";
import { getCurrentClinic } from "@/lib/clinic";

// GET /api/meta/connect → Meta OAuth bağlantı URL'si üretir
export async function GET() {
  try {
    const clinic = await getCurrentClinic();
    const state = Buffer.from(
      JSON.stringify({ clinicId: clinic.id, ts: Date.now() })
    ).toString("base64url");
    const url = buildOAuthUrl(state);
    return NextResponse.json({ url, state });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Bağlantı hatası" },
      { status: 500 }
    );
  }
}