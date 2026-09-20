import { NextRequest, NextResponse } from "next/server";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/media/[id]
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) {
    return NextResponse.json({ error: "Medya bulunamadı." }, { status: 404 });
  }

  await prisma.mediaAsset.delete({ where: { id } });

  if (asset.url.startsWith("/uploads/")) {
    const filePath = path.join(process.cwd(), "public", asset.url);
    await unlink(filePath).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}