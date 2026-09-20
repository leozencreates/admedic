import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";

// GET /api/leads → lead listesi + özetler
export async function GET() {
  const clinic = await getCurrentClinic();
  const leads = await prisma.lead.findMany({
    where: { clinicId: clinic.id },
    include: {
      messages: { orderBy: { sentAt: "desc" }, take: 1 },
      followUps: { where: { status: "PENDING" }, orderBy: { scheduledAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    leads: leads.map((l) => ({
      id: l.id,
      name: l.name,
      phone: l.phone,
      country: l.country,
      source: l.source,
      status: l.status,
      createdAt: l.createdAt,
      lastInboundAt: l.lastInboundAt,
      lastOutboundAt: l.lastOutboundAt,
      lastMessage: l.messages[0]?.body ?? null,
      lastMessageDirection: l.messages[0]?.direction ?? null,
      nextFollowUp: l.followUps[0]?.scheduledAt ?? null,
      nextFollowUpType: l.followUps[0]?.type ?? null,
    })),
  });
}

// POST /api/leads → yeni lead ekler ve karşılama planı kurar
export async function POST(request: NextRequest) {
  const clinic = await getCurrentClinic();
  const body = (await request.json()) as {
    name: string;
    phone: string;
    country?: string;
    source?: string;
    notes?: string;
    sendWelcome?: boolean;
  };

  if (!body.name || !body.phone) {
    return NextResponse.json(
      { error: "name ve phone zorunludur." },
      { status: 400 }
    );
  }

  const lead = await prisma.lead.create({
    data: {
      clinicId: clinic.id,
      name: body.name,
      phone: body.phone,
      country: body.country ?? null,
      source: body.source ?? "MANUAL",
      notes: body.notes ?? null,
    },
  });

  if (body.sendWelcome !== false) {
    await prisma.followUp.create({
      data: { leadId: lead.id, type: "WELCOME", scheduledAt: new Date() },
    });
  }

  return NextResponse.json({ lead }, { status: 201 });
}