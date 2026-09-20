import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { LeadDetailPanel } from "@/components/LeadDetailPanel";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { sentAt: "desc" }, take: 100 },
      followUps: { orderBy: { scheduledAt: "asc" }, take: 30 },
    },
  });

  if (!lead) {
    return <p className="py-10 text-center text-sm text-zinc-500">Lead bulunamadı.</p>;
  }

  const mediaAssets = await prisma.mediaAsset.findMany({
    where: { clinicId: lead.clinicId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link href="/leads" className="text-xs text-teal-700 hover:underline">
            ← Lead Takibi
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{lead.name}</h1>
          <p className="text-sm text-zinc-500">
            {lead.phone} · {lead.country ?? "Ülke yok"} · {lead.source} ·{" "}
            {formatDateTime(lead.createdAt)}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-xl border border-zinc-200 bg-white">
            <div className="border-b border-zinc-100 px-4 py-3 font-medium">
              Konuşma Geçmişi
            </div>
            {lead.messages.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">
                Henüz mesaj yok.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {lead.messages.map((m) => (
                  <li key={m.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-zinc-500">
                        {m.direction === "INBOUND" ? "Lead → Siz" : "Siz → Lead"} ·{" "}
                        {m.status}
                      </span>
                      <span className="text-xs text-zinc-400">
                        {formatDateTime(m.sentAt)}
                      </span>
                    </div>
                    {m.body && (
                      <p className="mt-1 text-sm text-zinc-800">
                        {m.direction === "INBOUND" ? (
                          m.body
                        ) : (
                          <>
                            {m.body}
                            {m.mediaUrl && (
                              <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
                                +medya
                              </span>
                            )}
                          </>
                        )}
                      </p>
                    )}
                    {m.mediaUrl && (
                      <a
                        href={m.mediaUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block text-xs text-teal-700 hover:underline"
                      >
                        Görüntüle: {m.mediaUrl}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white">
            <div className="border-b border-zinc-100 px-4 py-3 font-medium">
              Takip Planı
            </div>
            {lead.followUps.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">
                Planlanmış takip yok.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100 text-sm">
                {lead.followUps.map((f) => (
                  <li key={f.id} className="flex items-center justify-between px-4 py-2.5">
                    <span className={f.status === "PENDING" ? "font-medium" : "text-zinc-400"}>
                      {f.type}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {f.status} · {formatDateTime(f.scheduledAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="lg:col-span-1">
          <LeadDetailPanel leadId={lead.id} status={lead.status} mediaAssets={mediaAssets} />
        </div>
      </div>
    </div>
  );
}