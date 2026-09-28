import Link from "next/link";
import { connection } from "next/server";
import { prisma } from "@admedic/database";

import { IntroPanel, PageHeader } from "../_components/ui";
import { EDIT_ROLES, requirePageActor } from "../_lib/auth";
import {
  approvalScanLimit,
  listCorrectionRequests,
  listPendingApprovals,
  scopePendingApprovals,
} from "../_lib/pending-approvals";
import { hasSpendAuthority } from "../_lib/spend-authority";
import { MONTH_DAYS, activeMonthlyCommitmentCents } from "../_lib/spend-cap";
import { ApprovalsInbox, type InboxCorrection, type InboxItem } from "./approvals-inbox";

/**
 * Onaylar (ADR-0018 · K2-A): bir insanın kararını ya da işlemini bekleyen işlerin tek kutusu.
 * Hesap sahibi ve Yönetici içerik, kampanya ve bütçe önerisini burada onaylar ya da düzeltme ister;
 * harcama yetkisi olan kişi kampanyayı burada etkinleştirir (günlük tutar ve aylık etki onay penceresinde).
 * Reklam uzmanı kendi gönderdiklerini ve düzeltme istenenleri görür. Yetki her işlemde API'de yeniden denetlenir.
 * Ajan kararları onay işi değildir; geçmişleri /decisions'ta.
 */
export default async function ApprovalsPage() {
  await connection();
  const actor = await requirePageActor("/approvals");
  const canApprove = actor.role === "OWNER" || actor.role === "ADMIN";
  // Onaya iş gönderemeyen ve onay veremeyen roller (koordinatör, analist, izleyici) için kutu yoktur.
  if (!EDIT_ROLES.includes(actor.role))
    return (
      <div className="space-y-6">
        <PageHeader title="Onaylar" />
        <IntroPanel title="Onaylar bu rol için kapalı">
          Reklam içerikleri, kampanyalar ve bütçe önerileri hesap sahibi ya da yönetici tarafından onaylanır; reklam
          uzmanı onaya gönderir. Rolünüzün bu işlere katılması gerekiyorsa hesap sahibinden rolünüzü değiştirmesini
          isteyin.
        </IntroPanel>
      </div>
    );
  const [all, canApproveSpend, org, account] = await Promise.all([
    listPendingApprovals(actor.workspaceId, { limit: approvalScanLimit(actor.role) }),
    hasSpendAuthority(actor),
    prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { monthlyAdBudgetCap: true } }),
    prisma.adAccount.findFirst({
      where: { orgId: actor.orgId, workspaceId: actor.workspaceId, status: "ACTIVE" },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { currency: true },
    }),
  ]);
  const scoped = scopePendingApprovals(all, actor, { canApproveSpend });
  const currency = account?.currency ?? "EUR";
  const [committedCents, corrections] = await Promise.all([
    activeMonthlyCommitmentCents(prisma, actor.orgId, currency),
    canApprove ? Promise.resolve([]) : listCorrectionRequests(actor.workspaceId, { userId: actor.userId }),
  ]);

  const items: InboxItem[] = [
    ...scoped.items.CONTENT,
    ...scoped.items.CAMPAIGN,
    ...scoped.items.ACTIVATION,
    ...scoped.items.RECOMMENDATION,
  ].map((item) => ({
    kind: item.kind,
    id: item.id,
    title: item.title,
    detail: item.detail,
    submittedBy: item.submittedBy,
    submittedByLabel: item.submittedByLabel,
    waitingSince: item.waitingSince.toISOString(),
    actors: item.actors,
    href: item.href,
    version: item.version ?? null,
    dailyBudgetCents: item.dailyBudgetCents ?? null,
    currency: item.currency ?? currency,
    workflowStatus: item.workflowStatus ?? null,
  }));
  const correctionItems: InboxCorrection[] = corrections.map((c) => ({
    kind: c.kind,
    id: c.id,
    title: c.title,
    reason: c.reason,
    rejectedBy: c.rejectedBy,
    rejectedAt: c.rejectedAt.toISOString(),
    href: c.href,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Onaylar"
        description={
          canApprove
            ? "Onayınızı ya da işleminizi bekleyen işler; en uzun bekleyen en üstte."
            : "Onaya gönderdiğiniz işler ve sizden düzeltme istenenler."
        }
        actions={
          <Link href="/decisions" className="secondary-button">
            Ajan kararları geçmişi
          </Link>
        }
      />
      <ApprovalsInbox
        items={items}
        corrections={correctionItems}
        canApprove={canApprove}
        canApproveSpend={canApproveSpend}
        monthly={{ committedCents, capCents: org.monthlyAdBudgetCap, currency, monthDays: MONTH_DAYS }}
        now={Date.now()}
      />
    </div>
  );
}
