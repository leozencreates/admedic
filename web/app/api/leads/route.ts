import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import { z } from "zod";
export const maxDuration = 30;

const LeadStatusEnum = z.enum(["NEW", "CONTACTED", "QUALIFIED", "CONSULTATION_BOOKED", "TRAVEL_PLANNED", "TREATED", "LOST"]);

const LeadListSchema = z.object({
  status: LeadStatusEnum.optional(),
  search: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
}).strict();

const CreateLeadSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().nullable().optional().default(null),
  phone: z.string().nullable().optional().default(null),
  country: z.string().nullable().optional().default(null),
  language: z.string().min(1).max(10).optional().default("tr"),
  channel: z.string().nullable().optional().default(null),
  campaignId: z.string().nullable().optional().default(null),
  adSetId: z.string().nullable().optional().default(null),
  adId: z.string().nullable().optional().default(null),
  metadata: z.record(z.any()).optional().default({}),
}).strict();

export async function GET(request: Request) {
  return respond(async () => {
    const actor = await requireActor();
    const url = new URL(request.url);
    const params = LeadListSchema.parse({
      status: (url.searchParams.get("status") ?? undefined) as string | undefined,
      search: url.searchParams.get("search") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    const page = params.page ? parseInt(params.page, 10) : 1;
    const pageSize = params.pageSize ? parseInt(params.pageSize, 10) : 50;
    const where: Record<string, unknown> = { workspaceId: actor.workspaceId };
    if (params.status) where.status = params.status;
    if (params.search) {
      where.OR = [
        { firstName: { contains: params.search } },
        { lastName: { contains: params.search } },
        { email: { contains: params.search } },
        { phone: { contains: params.search } },
      ];
    }
    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.lead.count({ where }),
    ]);
    return { leads, total };
  });
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, CreateLeadSchema);
    const lead = await prisma.lead.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        country: input.country,
        language: input.language,
        channel: input.channel,
        campaignId: input.campaignId,
        adSetId: input.adSetId,
        adId: input.adId,
        metadata: input.metadata as Record<string, any>,
        workspaceId: actor.workspaceId,
        organizationId: actor.orgId,
      },
    });
    return { lead };
  });
}
