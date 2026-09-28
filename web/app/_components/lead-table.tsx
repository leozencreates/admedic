/**
 * Lead modeli ve liste süzgeci (istemci). Gelen kutusu listesi: `app/leads/lead-inbox.tsx` (ADR-0019).
 */
import type { InboxState } from "../_lib/inbox";

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
  /** Gelen kutusu durumu (GET /api/leads); ayrıntı uçlarında yoktur. */
  inbox: InboxState | null;
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
  inbox?: InboxState | null;
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
    inbox: apiLead.inbox ?? null,
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
