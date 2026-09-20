"use client";
import { Badge } from "./ui";
import { formatDate } from "../_lib/format";
import type { Tone } from "../_components/ui";

const STATUS_TONE: Record<string, Tone> = {
  NEW: "blue",
  CONTACTED: "amber",
  QUALIFIED: "green",
  CONSULTATION_BOOKED: "violet",
  TRAVEL_PLANNED: "blue",
  TREATED: "green",
  LOST: "red",
};

const STATUS_LABEL: Record<string, string> = {
  NEW: "Yeni",
  CONTACTED: "İletişime Geçildi",
  QUALIFIED: "Değerlendirildi",
  CONSULTATION_BOOKED: "Danışma Randevusu",
  TRAVEL_PLANNED: "Seyahat Planlandı",
  TREATED: "Tedavi Edildi",
  LOST: "Kaybedildi",
};

export interface Lead {
  id: string;
  name: string;
  phone: string;
  email: string;
  status: string;
  channel: string;
  country: string;
  created: string;
}

export function toLead(apiLead: {
  id: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  phone?: string;
  email?: string;
  status?: string;
  channel?: string;
  country?: string;
  createdAt?: string;
  created?: string;
}): Lead {
  return {
    id: apiLead.id,
    name: apiLead.name ?? (`${apiLead.firstName ?? ""} ${apiLead.lastName ?? ""}`.trim() || "—"),
    phone: apiLead.phone ?? "",
    email: apiLead.email ?? "",
    status: apiLead.status ?? "",
    channel: apiLead.channel ?? "",
    country: apiLead.country ?? "",
    created: apiLead.created ?? apiLead.createdAt ?? "",
  };
}

export function LeadTable({
  leads,
  onRowClick,
  search,
  statusFilter,
}: {
  leads: Lead[];
  onRowClick?: (id: string) => void;
  search: string;
  statusFilter: string;
}) {
  const filtered = leads.filter((l) => {
    const matchSearch =
      !search ||
      l.name.toLocaleLowerCase("tr").includes(search.toLocaleLowerCase("tr")) ||
      l.email.toLocaleLowerCase("tr").includes(search.toLocaleLowerCase("tr")) ||
      l.phone.includes(search);
    const matchStatus = !statusFilter || l.status === statusFilter;
    return matchSearch && matchStatus;
  });

  if (filtered.length === 0) {
    return (
      <div className="studio-card py-12 text-center">
        <h2>Lead bulunamadı</h2>
        <p className="mt-2 text-sm text-slate-500">
          Arama veya filtre kriterlerinize uygun lead yok.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-200">
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
              Ad
            </th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
              Telefon
            </th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
              E-posta
            </th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
              Durum
            </th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
              Kanal
            </th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
              Ülke
            </th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
              Oluşturulma
            </th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((lead) => (
            <tr
              key={lead.id}
              className="border-b border-slate-100 cursor-pointer transition hover:bg-slate-50"
              onClick={() => onRowClick?.(lead.id)}
            >
              <td className="px-3 py-3 text-sm font-medium text-slate-900">
                {lead.name}
              </td>
              <td className="px-3 py-3 text-sm text-slate-700">{lead.phone}</td>
              <td className="px-3 py-3 text-sm text-slate-700">{lead.email}</td>
              <td className="px-3 py-3">
                <Badge tone={STATUS_TONE[lead.status] ?? "gray"}>
                  {STATUS_LABEL[lead.status] ?? lead.status}
                </Badge>
              </td>
              <td className="px-3 py-3 text-sm text-slate-700">{lead.channel}</td>
              <td className="px-3 py-3 text-sm text-slate-700">{lead.country}</td>
              <td className="px-3 py-3 text-sm text-slate-500">
                {formatDate(lead.created)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
