import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { respond } from "../../_lib/http";
export const maxDuration = 15;
/**
 * OPTİMİZASYON politikaları (bütçe guardrail'leri, ajan modu) ve optimizasyon
 * kuralları — içerik politikası (policy_rules) DEĞİLDİR; içerik kuralları
 * `GET /api/policy-rules` üzerinden okunur. Yanıt anahtarları bu ayrımı taşır.
 */
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const policy = await prisma.optimizationPolicy.findUnique({ where: { workspaceId: actor.workspaceId } });
    const optimizationRules = await prisma.optimizationRule.findMany({
      where: { OR: [{ workspaceId: actor.workspaceId }, { workspaceId: null }] },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, version: true, active: true, description: true, workspaceId: true, createdAt: true },
    });
    return {
      kind: "OPTIMIZATION",
      optimizationPolicy: policy,
      optimizationRules,
      // Geriye dönük uyumluluk: eski istemciler `policies`/`rules` anahtarlarını okuyordu.
      policies: policy ? [policy] : [],
      rules: optimizationRules,
    };
  });
}
