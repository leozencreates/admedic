import type { AlertType, Prisma } from "@admedic/database";
import { prisma } from "@admedic/database";
import { CARE_ROLES, EDIT_ROLES, requireActor, type Actor } from "../../_lib/auth";
import { respond } from "../../_lib/http";
import { countPendingApprovals, listPendingApprovals, scopePendingApprovals } from "../../_lib/pending-approvals";
import { hasSpendAuthority } from "../../_lib/spend-authority";
import { HANDOFF_ALERT_TYPE } from "../../_lib/lead-assistant";
import { needsReplySummary } from "../../_lib/inbox";
import { alertRecordLinks } from "../../_lib/record-refs";
import { roleLabel } from "../../_lib/labels";

/**
 * Kabuk özeti (ADR-0017): menü rozetleri, bildirim zili ve hesap menüsü için tek, hafif uç.
 * Salt okunur; her sayı çalışma alanıyla sınırlı ve role göre süzülür:
 * - Onaylar: Owner/Admin tüm bekleyen işler; Reklam uzmanı kendi gönderdikleri (+ yetkisi varsa etkinleştirmeler).
 * - Lead'ler: hastası bir insandan yanıt bekleyen lead sayısı (`inbox.ts` kuralı); yalnızca bakım rolleri.
 * - Uyarılar/zil: hasta koordinatörü yalnızca konuşma devri uyarılarını görür; izleyici hiç görmez.
 */
const NOTIFICATION_LIMIT = 8;

function alertScope(actor: Actor): Prisma.AlertWhereInput | null {
  if (actor.role === "VIEWER") return null;
  const base: Prisma.AlertWhereInput = { workspaceId: actor.workspaceId, status: "OPEN" };
  if (actor.role === "PATIENT_COORDINATOR") return { ...base, type: HANDOFF_ALERT_TYPE as AlertType };
  return base;
}

/** Onaylar rozeti: Owner/Admin tüm bekleyen işler; Reklam uzmanı Onaylar kutusunda gördükleri (ADR-0018). */
async function approvalCount(actor: Actor): Promise<number> {
  if (actor.role === "OWNER" || actor.role === "ADMIN") return (await countPendingApprovals(actor.workspaceId)).total;
  if (!EDIT_ROLES.includes(actor.role)) return 0;
  const [all, canApproveSpend] = await Promise.all([listPendingApprovals(actor.workspaceId), hasSpendAuthority(actor)]);
  return scopePendingApprovals(all, actor, { canApproveSpend }).counts.total;
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = (parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? "?"])
    .map((p) => p.charAt(0).toLocaleUpperCase("tr"));
  return letters.join("").slice(0, 2);
}

export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const scope = alertScope(actor);
    const canCare = CARE_ROLES.includes(actor.role);
    const [user, approvals, leads, alertCount, alerts] = await Promise.all([
      prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true, email: true } }),
      approvalCount(actor),
      canCare ? needsReplySummary(actor).then((r) => r.count) : 0,
      scope && canCare ? prisma.alert.count({ where: scope }) : 0,
      scope
        ? prisma.alert.findMany({
            where: scope,
            orderBy: [{ createdAt: "desc" }],
            take: NOTIFICATION_LIMIT,
            select: { id: true, title: true, severity: true, createdAt: true, entityType: true, entityId: true },
          })
        : [],
    ]);
    const links = alerts.length ? await alertRecordLinks(actor.workspaceId, alerts) : new Map<string, string>();
    const displayName = user?.name?.trim() || user?.email || roleLabel(actor.role);
    return {
      user: {
        name: displayName,
        initials: initials(displayName),
        role: actor.role,
        roleLabel: roleLabel(actor.role),
        workspaceName: actor.workspaceName,
      },
      counts: { approvals, leads, alerts: alertCount },
      notifications: alerts.map((a) => ({
        id: a.id,
        title: a.title,
        severity: a.severity,
        createdAt: a.createdAt.toISOString(),
        href: links.get(a.id) ?? "/alerts",
      })),
    };
  });
}
