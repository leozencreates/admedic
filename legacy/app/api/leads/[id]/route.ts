import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/leads/[id] → lead detayı + mesaj geçmişi + bekleyen takipler
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { sentAt: "desc" }, take: 50 },
      followUps: {
        orderBy: { scheduledAt: "asc" },
        take: 20,
      },
    },
  });
  if (!lead) {
    return NextResponse.json({ error: "Lead bulunamadı." }, { status: 404 });
  }
  return NextResponse.json({ lead });
}

// PATCH /api/leads/[id] → durum güncelleme
export async function PATCH(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await request.json()) as {
    status?: string;
    notes?: string;
  };
  const lead = await prisma.lead.update({
    where: { id },
    data: {
      ...(body.status ? { status: body.status } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    },
  });
  return NextResponse.json({ lead });
}