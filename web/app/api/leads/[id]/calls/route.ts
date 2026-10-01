import { prisma } from "@admedic/database";
import { CALL_BLOCKER_LABELS, createVoiceClient, leadCallState, startVoiceCall } from "@admedic/voice";
import { requireActor, requireRole, quota, CARE_ROLES, LEAD_READ_ROLES } from "../../../../_lib/auth";
import { tryDecryptField } from "../../../../_lib/encrypt";
import { HttpError, respond, sameOrigin } from "../../../../_lib/http";

export const maxDuration = 30;

const NOT_FOUND = "Lead bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.";

/**
 * Sesli ajan aramaları (ADR-0026).
 * - GET: lead'in arama durumu (müsait mi, değilse neden) ve arama geçmişi. Arama özeti hasta verisidir;
 *   yalnızca bakım rollerine döner (ADR-0019 ile aynı kural).
 * - POST: müsait lead'i arar (bakım rolleri). Rıza, arama saatleri ve deneme sınırı sunucuda denetlenir.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    requireRole(actor, LEAD_READ_ROLES);
    const { id } = await params;
    const state = await leadCallState(prisma, { leadId: id, workspaceId: actor.workspaceId }, "MANUAL");
    if (!state) throw new HttpError(404, NOT_FOUND);
    const client = createVoiceClient();
    const canCall = CARE_ROLES.includes(actor.role);
    const calls = await prisma.voiceCall.findMany({
      where: { leadId: id, workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, status: true, trigger: true, outcome: true, summary: true, durationSecs: true,
        failureReason: true, startedAt: true, endedAt: true, createdAt: true,
      },
    });
    return {
      canCall,
      /** Deneme modu: gerçek arama yapılmaz. */
      mock: client.mock,
      configured: client.missingConfig.length === 0,
      consent: state.facts.callConsent,
      attempts: state.facts.attempts,
      blockers: state.blockers.map((code) => ({ code, label: CALL_BLOCKER_LABELS[code] })),
      calls: calls.map((call) => ({ ...call, summary: canCall ? tryDecryptField(call.summary) : null })),
    };
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, CARE_ROLES);
    await quota(`voice-call:${actor.userId}`, 30, 3600);
    const { id } = await params;
    const call = await startVoiceCall(prisma, createVoiceClient(), {
      leadId: id,
      workspaceId: actor.workspaceId,
      trigger: "MANUAL",
      requestedById: actor.userId,
    });
    return { call: { id: call.id, status: call.status } };
  });
}
