import { prisma } from "@admedic/database";
import { EDIT_ROLES, ESCALATION_ROLES, requireActor, type Actor } from "../../_lib/auth";
import { respond } from "../../_lib/http";
import { approvalScanLimit, countPendingApprovals, listPendingApprovals, scopePendingApprovals } from "../../_lib/pending-approvals";
import { hasSpendAuthority } from "../../_lib/spend-authority";
import { alertScope } from "../../_lib/alert-scope";
import { needsReplySummary } from "../../_lib/inbox";
import { alertRecordLinks } from "../../_lib/record-refs";
import { roleLabel } from "../../_lib/labels";

/**
 * Kabuk özeti (ADR-0017): menü rozetleri, bildirim zili ve hesap menüsü için tek, hafif uç.
 * Salt okunur; her sayı çalışma alanıyla sınırlı ve role göre süzülür:
 * - Onaylar: Owner/Admin tüm bekleyen işler; Reklam uzmanı kendi gönderdikleri (+ yetkisi varsa etkinleştirmeler).
 * - Lead'ler: hastası bir insandan yanıt bekleyen lead sayısı (`inbox.ts` kuralı); yalnızca hastaya yazabilen
 *   roller (ESCALATION_ROLES, ADR-0019) — yanıt veremeyen role "sizden beklenen" sayı gösterilmez.
 * - Uyarılar/zil: `alert-scope.ts` (koordinatör yalnızca devir uyarıları, izleyici hiç); rozet ve liste aynı kapsam.
 */
const NOTIFICATION_LIMIT = 8;

/**
 * Onaylar rozeti = kullanıcının yapabileceği işler (ADR-0018). Owner/Admin: tüm bekleyen işler, ancak harcama
 * yetkisi yoksa etkinleştirmeler sayılmaz (onları yalnızca harcama yetkisi olan etkinleştirir). Reklam uzmanı:
 * Onaylar kutusunda gördükleri.
 */
async function approvalCount(actor: Actor): Promise<number> {
  if (actor.role === "OWNER" || actor.role === "ADMIN") {
    const [counts, canApproveSpend] = await Promise.all([countPendingApprovals(actor.workspaceId), hasSpendAuthority(actor)]);
    return counts.total - (canApproveSpend ? 0 : counts.byKind.ACTIVATION);
  }
  if (!EDIT_ROLES.includes(actor.role)) return 0;
  const [all, canApproveSpend] = await Promise.all([
    listPendingApprovals(actor.workspaceId, { limit: approvalScanLimit(actor.role) }),
    hasSpendAuthority(actor),
  ]);
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
    const roleScope = alertScope(actor);
    const scope = roleScope ? { ...roleScope, status: "OPEN" as const } : null;
    const canReply = ESCALATION_ROLES.includes(actor.role);
    const [user, approvals, leads, alertCount, alerts] = await Promise.all([
      prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true, email: true } }),
      approvalCount(actor),
      canReply ? needsReplySummary(actor).then((r) => r.count) : 0,
      scope ? prisma.alert.count({ where: scope }) : 0,
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
