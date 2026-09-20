import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/tests/[id] → test detayı
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const test = await prisma.testRun.findUnique({
    where: { id },
    include: {
      campaign: { include: { metaAccount: true } },
      variants: { include: { metrics: { orderBy: { date: "asc" } } } },
      actions: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!test) {
    return NextResponse.json({ error: "Test bulunamadı." }, { status: 404 });
  }
  return NextResponse.json({ test });
}

// PATCH /api/tests/[id] → { status: "STOPPED" } ile testi durdurur
export async function PATCH(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await request.json()) as { status?: string };

  if (body.status === "STOPPED") {
    const test = await prisma.testRun.update({
      where: { id },
      data: { status: "STOPPED", endedAt: new Date() },
    });
    await prisma.agentAction.create({
      data: {
        testRunId: id,
        type: "TEST_STOPPED",
        detail: "Test kullanıcı tarafından durduruldu. Bütçe kaydırmaları askıya alındı.",
        severity: "WARNING",
      },
    });
    return NextResponse.json({ test });
  }
  return NextResponse.json(
    { error: "Desteklenmeyen işlem." },
    { status: 400 }
  );
}