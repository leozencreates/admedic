import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import { z } from "zod";
export const maxDuration = 10;
const ClinicSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(100),
  category: z.enum(["MEDICAL", "DENTAL", "WELLNESS", "SURGICAL", "DIAGNOSTIC", "PSYCHIATRIC", "OTHER"]).optional().default("MEDICAL"),
  address: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  website: z.string().url().optional().nullable(),
  description: z.string().optional().nullable(),
  languages: z.array(z.enum(["TR", "EN", "DE", "RU", "AR"])).optional().default(["TR"]),
  targetMarket: z.enum(["TURKEY", "GERMANY", "UK", "NETHERLANDS", "USA", "GULF", "OTHER"]).optional().default("TURKEY"),
}).strict();
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    return {
      clinics: await prisma.clinicProfile.findMany({
        where: { workspaceId: actor.workspaceId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, slug: true, category: true, status: true, createdAt: true, updatedAt: true },
      }),
    };
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, ClinicSchema);
    const clinic = await prisma.clinicProfile.create({
      data: {
        workspaceId: actor.workspaceId,
        name: input.name,
        slug: input.slug,
        category: input.category,
        address: input.address ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        website: input.website ?? null,
        description: input.description ?? null,
        languages: input.languages,
        targetMarket: input.targetMarket,
      },
    });
    return { clinic };
  });
}
