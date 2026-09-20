import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";
import { AddLeadForm } from "@/components/AddLeadForm";
import { LeadAgentBar } from "@/components/LeadAgentBar";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  NEW: "Yeni",
  CONTACTED: "İletişim Kuruldu",
  CONVERSING: "Görüşme",
  WON: "Kazanıldı",
  LOST: "Kaybedildi",
  DND: "Rahatsız Etme",
};

const STATUS_COLOR: Record<string, string> = {
  NEW: "bg-emerald-100 text-emerald-800",
  CONTACTED: "bg-blue-100 text-blue-800",
  CONVERSING: "bg-violet-100 text-violet-800",
  WON: "bg-green-200 text-green-900",
  LOST: "bg-zinc-200 text-zinc-600",
  DND: "bg-red-100 text-red-800",
};

export default async function LeadsPage() {
  const clinic = await getCurrentClinic();
  const leads = await prisma.lead.findMany({
    where: { clinicId: clinic.id },
    include: {
      messages: { orderBy: { sentAt: "desc" }, take: 1 },
      followUps: {
        where: { status: "PENDING" },
        orderBy: { scheduledAt: "asc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const counts = leads.reduce<Record<string, number>>((acc, l) => {
    acc[l.status] = (acc[l.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Lead Takibi</h1>
        <p className="text-sm text-zinc-500">
          WhatsApp üzerinden otomatik takip — karşılama, günlük hatırlatma ve
          klinik medyası
        </p>
      </div>

      <LeadAgentBar />
      <AddLeadForm />

      <div className="flex flex-wrap gap-2 text-xs">
        {Object.entries(STATUS_LABEL).map(([k, label]) => (
          <span key={k} className="rounded-full border border-zinc-200 bg-white px-3 py-1">
            <span className={`mr-1 inline-block h-2 w-2 rounded-full ${k === "NEW" ? "bg-emerald-500" : k === "CONTACTED" ? "bg-blue-500" : k === "CONVERSING" ? "bg-violet-500" : k === "WON" ? "bg-green-600" : k === "LOST" ? "bg-zinc-400" : "bg-red-500"}`} />
            {label}: {counts[k] ?? 0}
          </span>
        ))}
      </div>

      {leads.length === 0 ? (
        <p className="rounded-xl border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500">
          Henüz lead yok.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3">Lead</th>
                <th className="px-4 py-3">Durum</th>
                <th className="px-4 py-3">Kaynak</th>
                <th className="px-4 py-3">Son Mesaj</th>
                <th className="px-4 py-3">Sıradaki Takip</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {leads.map((l) => (
                <tr key={l.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-3">
                    <Link href={`/leads/${l.id}`} className="font-medium text-teal-700 hover:underline">
                      {l.name}
                    </Link>
                    <p className="text-xs text-zinc-500">
                      {l.phone} {l.country ? `· ${l.country}` : ""}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[l.status] ?? "bg-zinc-100 text-zinc-600"}`}>
                      {STATUS_LABEL[l.status] ?? l.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{l.source}</td>
                  <td className="max-w-[260px] truncate px-4 py-3 text-xs text-zinc-600">
                    {l.messages[0] ? (
                      <span>
                        <span className={l.messages[0].direction === "INBOUND" ? "text-violet-700" : "text-zinc-500"}>
                          {l.messages[0].direction === "INBOUND" ? "← " : "→ "}
                        </span>
                        {l.messages[0].body || "(medya)"}
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {l.followUps[0] ? (
                      <span>
                        <span className="font-medium text-zinc-700">{l.followUps[0].type}</span>
                        <br />
                        <span className="text-zinc-500">{formatDateTime(l.followUps[0].scheduledAt)}</span>
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}