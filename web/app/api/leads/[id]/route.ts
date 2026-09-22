import { prisma } from "@admedic/database";
import { requireActor } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { z } from "zod";
export const maxDuration = 30;

const LeadStatusEnum = z.enum(["NEW", "CONTACTED", "QUALIFIED", "CONSULTATION_BOOKED", "TRAVEL_PLANNED", "TREATED", "LOST"]);

const UpdateLeadSchema = z.object({
  status: LeadStatusEnum.optional(),
  lostReason: z.string().nullable().optional(),
  metadata: z.record(z.any()).optional(),
  consentGiven: z.boolean().optional(),
}).strict();

const VALID_TRANSITIONS: Record<string, string[]> = {
  NEW: ["CONTACTED"],
  CONTACTED: ["QUALIFIED"],
  QUALIFIED: ["CONSULTATION_BOOKED"],
  CONSULTATION_BOOKED: ["TRAVEL_PLANNED"],
  TRAVEL_PLANNED: ["TREATED", "LOST"],
};

function getTimestampForStatus(status: string): Record<string, Date> {
  const now = new Date();
  switch (status) {
    case "QUALIFIED": return { qualifiedAt: now };
    case "CONSULTATION_BOOKED": return { consultationBookedAt: now };
    case "TREATED": return { treatedAt: now };
    case "LOST": return { lostAt: now };
    default: return {};
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      include: {
        conversations: {
          include: {
            messages: { orderBy: { createdAt: "desc" }, take: 10 },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    return { lead };
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const { id } = await params;
    const input = await body(request, UpdateLeadSchema);
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    if (input.consentGiven) {
      const existing = await prisma.consentRecord.findFirst({
        where: { leadId: id, type: "MARKETING" },
      });
      if (!existing) {
        await prisma.consentRecord.create({
          data: {
            leadId: id,
            workspaceId: actor.workspaceId,
            type: "MARKETING",
            status: "GRANTED",
            consentText: "Pazarlama iletişimleri için veri işleme onayı.",
            acceptedAt: new Date(),
            ip: null,
            userAgent: null,
          },
        });
      }
    }
    if (input.status) {
      const allowed = VALID_TRANSITIONS[lead.status] ?? [];
      if (!allowed.includes(input.status)) {
        throw new HttpError(409, `Geçersiz durum geçişi: ${lead.status} → ${input.status}`);
      }
      const timestamps = getTimestampForStatus(input.status);
      await prisma.lead.update({
        where: { id },
        data: {
          status: input.status,
          ...timestamps,
          ...(input.lostReason !== undefined ? { lostReason: input.lostReason } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata as Record<string, any> } : {}),
        },
      });
    } else {
      await prisma.lead.update({
        where: { id },
        data: {
          ...(input.lostReason !== undefined ? { lostReason: input.lostReason } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata as Record<string, any> } : {}),
        },
      });
    }
    return { ok: true };
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const { id } = await params;
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    await prisma.lead.delete({ where: { id } });
    return { ok: true };
  });
}
