import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createMessenger } from "@/lib/whatsapp/client";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/leads/[id]/messages → manuel mesaj / medya gönderir
export async function POST(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await request.json()) as {
    body?: string;
    mediaUrl?: string;
    mediaType?: "IMAGE" | "VIDEO";
    caption?: string;
  };

  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) {
    return NextResponse.json({ error: "Lead bulunamadı." }, { status: 404 });
  }

  if (!body) {
    return NextResponse.json({ error: "Adlı gövde gerekli." }, { status: 400 });
  }

  if (!body.body && !body.mediaUrl) {
    return NextResponse.json(
      { error: "body veya mediaUrl gerekli." },
      { status: 400 }
    );
  }

  const config = await prisma.whatsappConfig.upsert({
    where: { clinicId: lead.clinicId },
    update: {},
    create: { clinicId: lead.clinicId },
  });

  const messenger = createMessenger(config);

  try {
    const sendResult = body.mediaUrl
      ? await messenger.sendMedia({
          to: lead.phone,
          type: body.mediaType ?? "IMAGE",
          url: body.mediaUrl,
          caption: body.caption ?? body.body,
        })
      : await messenger.sendText({ to: lead.phone, body: body.body! });

    const record = await prisma.messageRecord.create({
      data: {
        leadId: lead.id,
        direction: "OUTBOUND",
        status: sendResult.mock ? "MOCK" : "SENT",
        body: body.body ?? (body.caption ?? ""),
        mediaUrl: body.mediaUrl ?? null,
        mediaType: body.mediaUrl ? (body.mediaType ?? "IMAGE") : null,
        providerMessageId: sendResult.providerMessageId,
      },
    });

    await prisma.lead.update({
      where: { id: lead.id },
      data: { lastOutboundAt: new Date() },
    });

    return NextResponse.json({ record, mock: sendResult.mock }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Gönderim başarısız" },
      { status: 500 }
    );
  }
}