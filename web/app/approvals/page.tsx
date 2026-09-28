import Link from "next/link";

import { Badge, Card, EmptyState, PageHeader } from "../_components/ui";
import { requirePageActor } from "../_lib/auth";
import { formatDate, formatDuration, formatNumber } from "../_lib/format";
import {
  PENDING_APPROVAL_KINDS,
  PENDING_APPROVAL_LABEL,
  listPendingApprovals,
  type PendingApprovalItem,
  type PendingApprovalKind,
} from "../_lib/pending-approvals";

/**
 * Onaylar (ADR-0016 · Faz 1 madde 11): bir insanın kararını ya da işlemini bekleyen gerçek işler.
 * Onay bu sayfada verilmez; her satır kararın verildiği sayfaya ("Aç") götürür.
 * Ajan kararları onay işi değildir; geçmişleri /decisions'ta.
 */

const ACTOR_PREFIX: Record<PendingApprovalKind, string> = {
  CONTENT: "Kim onaylar",
  CAMPAIGN: "Kim onaylar",
  ACTIVATION: "Kim etkinleştirir",
  RECOMMENDATION: "Kim onaylar",
};

function ApprovalRow({ item, now }: { item: PendingApprovalItem; now: number }) {
  return (
    <li className="flex flex-col gap-3 py-4 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold text-slate-900">{item.title}</p>
        {item.detail ? <p className="mt-0.5 break-words text-sm text-slate-600">{item.detail}</p> : null}
        <p className="mt-1 text-xs text-muted">
          {item.submittedBy ? (
            <>
              {item.submittedByLabel}: {item.submittedBy}
              {" · "}
            </>
          ) : null}
          <time dateTime={item.waitingSince.toISOString()}>{formatDate(item.waitingSince)}</time> tarihinden beri
          bekliyor ({formatDuration(now - item.waitingSince.getTime())})
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {ACTOR_PREFIX[item.kind]}: {item.actors}
        </p>
      </div>
      <Link href={item.href} className="secondary-button shrink-0 self-start">
        Aç<span className="sr-only">: {item.title}</span>
      </Link>
    </li>
  );
}

export default async function ApprovalsPage() {
  const actor = await requirePageActor("/approvals");
  const { counts, items } = await listPendingApprovals(actor.workspaceId);
  const now = Date.now();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Onaylar"
        description="Onayınızı ya da işleminizi bekleyen işler; onayı ilgili sayfada verirsiniz."
        actions={
          <Link href="/decisions" className="secondary-button">
            Ajan kararları geçmişi
          </Link>
        }
      />

      {counts.total === 0 ? (
        <EmptyState message="Onayınızı bekleyen iş yok." />
      ) : (
        PENDING_APPROVAL_KINDS.map((kind) => {
          const count = counts.byKind[kind];
          const list = items[kind];
          const headingId = `onay-${kind.toLowerCase()}`;
          return (
            <Card key={kind}>
              <section aria-labelledby={headingId}>
                <h2
                  id={headingId}
                  className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900"
                >
                  {PENDING_APPROVAL_LABEL[kind].section}
                  <Badge tone={count > 0 ? "amber" : "gray"}>
                    {formatNumber(count)}
                    <span className="sr-only"> iş bekliyor</span>
                  </Badge>
                </h2>
                {list.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">Bu türde bekleyen iş yok.</p>
                ) : (
                  <ul className="mt-1 divide-y divide-slate-100">
                    {list.map((item) => (
                      <ApprovalRow key={item.id} item={item} now={now} />
                    ))}
                  </ul>
                )}
                {count > list.length ? (
                  <p className="mt-2 text-xs text-muted">
                    En uzun bekleyen {formatNumber(list.length)} iş gösteriliyor.
                  </p>
                ) : null}
              </section>
            </Card>
          );
        })
      )}
    </div>
  );
}
