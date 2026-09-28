"use client";
import Link from "next/link";
import { Badge, Th } from "./ui";
import { formatDate, formatRelative } from "../_lib/format";
import { channelLabel, countryName, languageName, leadStatusStyle } from "../_lib/labels";

export interface Lead {
  id: string;
  name: string;
  phone: string;
  email: string;
  status: string;
  channel: string;
  country: string;
  language: string;
  interestedService: string;
  campaignId: string;
  adSetId: string;
  adId: string;
  consentGiven: boolean;
  created: string;
}

/** API'den gelen lead (GET /api/leads, GET /api/leads/:id); iletişim alanları role göre maskeli olabilir. */
export interface ApiLead {
  id: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  status?: string;
  channel?: string | null;
  country?: string | null;
  language?: string | null;
  interestedService?: string | null;
  campaignId?: string | null;
  adSetId?: string | null;
  adId?: string | null;
  consentGiven?: boolean;
  createdAt?: string;
  created?: string;
}

export function toLead(apiLead: ApiLead): Lead {
  return {
    id: apiLead.id,
    name: apiLead.name ?? (`${apiLead.firstName ?? ""} ${apiLead.lastName ?? ""}`.trim() || "—"),
    phone: apiLead.phone ?? "",
    email: apiLead.email ?? "",
    status: apiLead.status ?? "",
    channel: apiLead.channel ?? "",
    country: apiLead.country ?? "",
    language: apiLead.language ?? "",
    interestedService: apiLead.interestedService ?? "",
    campaignId: apiLead.campaignId ?? "",
    adSetId: apiLead.adSetId ?? "",
    adId: apiLead.adId ?? "",
    consentGiven: apiLead.consentGiven ?? false,
    created: apiLead.created ?? apiLead.createdAt ?? "",
  };
}

/** Arama (ad, e-posta, telefon) ve durum filtresi. */
export function filterLeads(leads: Lead[], search: string, statusFilter: string): Lead[] {
  const query = search.trim().toLocaleLowerCase("tr");
  return leads.filter((l) => {
    const matchSearch =
      !query ||
      l.name.toLocaleLowerCase("tr").includes(query) ||
      l.email.toLocaleLowerCase("tr").includes(query) ||
      l.phone.includes(query);
    const matchStatus = !statusFilter || l.status === statusFilter;
    return matchSearch && matchStatus;
  });
}

export function LeadTable({
  leads,
  onRowClick,
  search,
  statusFilter,
  onClearFilters,
}: {
  leads: Lead[];
  onRowClick?: (id: string) => void;
  search: string;
  statusFilter: string;
  onClearFilters?: () => void;
}) {
  if (leads.length === 0) {
    return (
      <div className="studio-card py-12 text-center">
        <h2>Henüz lead yok</h2>
        <p className="mt-2 text-sm text-muted">
          Kampanyalarınızdan ve WhatsApp&apos;tan gelen talepler burada listelenir.
        </p>
        <Link href="/campaign-planner" className="secondary-button mt-4">
          Kampanyalara git
        </Link>
      </div>
    );
  }

  const filtered = filterLeads(leads, search, statusFilter);
  if (filtered.length === 0) {
    return (
      <div className="studio-card py-12 text-center">
        <h2>Aramanıza uyan lead yok.</h2>
        {onClearFilters && (
          <button type="button" className="secondary-button mt-4" onClick={onClearFilters}>
            Filtreleri temizle
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-xl border border-slate-200 bg-white"
      tabIndex={0}
      role="region"
      aria-label="Lead tablosu"
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-200">
            <Th>Ad</Th>
            <Th>Telefon</Th>
            <Th>E-posta</Th>
            <Th>Durum</Th>
            <Th>Kanal</Th>
            <Th>Ülke</Th>
            <Th>Dil</Th>
            <Th>Hizmet</Th>
            <Th>Oluşturulma</Th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((lead) => {
            const status = leadStatusStyle(lead.status);
            return (
              <tr
                key={lead.id}
                className="cursor-pointer border-b border-slate-100 transition hover:bg-slate-50"
                onClick={(e) => {
                  // Satırın tamamı fare için tıklanabilir; ad bağlantısı (klavye, yeni sekme) kendi işini yapar.
                  if ((e.target as Element).closest("a, button, input, select, textarea")) return;
                  if (window.getSelection()?.toString()) return; // metin seçimi gezinme sayılmaz
                  onRowClick?.(lead.id);
                }}
              >
                <td className="whitespace-nowrap px-3 py-3 text-sm font-medium">
                  <Link href={`/leads/${lead.id}`} className="text-slate-900 hover:underline" dir="auto">
                    {lead.name}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-sm text-slate-700">{lead.phone || "—"}</td>
                <td className="px-3 py-3 text-sm text-slate-700">{lead.email || "—"}</td>
                <td className="whitespace-nowrap px-3 py-3">
                  <Badge tone={status.tone}>{status.label}</Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-sm text-slate-700">{channelLabel(lead.channel)}</td>
                <td className="whitespace-nowrap px-3 py-3 text-sm text-slate-700">{countryName(lead.country)}</td>
                <td className="whitespace-nowrap px-3 py-3 text-sm text-slate-700">{languageName(lead.language)}</td>
                <td className="px-3 py-3 text-sm text-slate-700">{lead.interestedService || "—"}</td>
                <td className="whitespace-nowrap px-3 py-3 text-sm text-muted">
                  {lead.created ? (
                    <time dateTime={lead.created} title={formatDate(lead.created)}>
                      {formatRelative(lead.created)}
                    </time>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
