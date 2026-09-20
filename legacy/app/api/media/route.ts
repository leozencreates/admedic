import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

// GET /api/media → kliniğin medya kütüphanesi
export async function GET() {
  const clinic = await getCurrentClinic();
  const assets = await prisma.mediaAsset.findMany({
    where: { clinicId: clinic.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ assets });
}

// POST /api/media → fotoğraf/video yükler (multipart)
export async function POST(request: NextRequest) {
  const clinic = await getCurrentClinic();
  const formData = await request.formData();
  const file = formData.get("file");
  const name = String(formData.get("name") ?? "Medya");
  const type = String(formData.get("type") ?? "IMAGE");

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Dosya gerekli." }, { status: 400 });
  }

  const allowed = ["image/jpeg", "image/png", "image/webp", "image/svg+xml", "video/mp4"];
  if (!allowed.includes(file.type)) {
    return NextResponse.json(
      { error: `Desteklenen türler: ${allowed.join(", ")}` },
      { status: 400 }
    );
  }

  const ext = file.type.startsWith("video/") ? "mp4" : file.name.split(".").pop() ?? "bin";
  const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, filename), Buffer.from(await file.arrayBuffer()));

  const asset = await prisma.mediaAsset.create({
    data: {
      clinicId: clinic.id,
      name,
      type,
      url: `/uploads/${filename}`,
      mimeType: file.type,
      sizeBytes: file.size,
    },
  });

  return NextResponse.json({ asset }, { status: 201 });
}