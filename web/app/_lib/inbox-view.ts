/**
 * Gelen kutusu sekmeleri ve sıralama (ADR-0019 · K4-A). Saf modül (istemci ve test).
 * - Yanıt bekleyen: hasta bir insandan yanıt bekliyor (`inbox.ts` kuralı); en uzun bekleyen en üstte.
 * - Devralınan: konuşmayı bir ekip üyesi devraldı; en son hareket en üstte.
 * - Tümü: en son hareket en üstte.
 */
import type { InboxState } from "./inbox";

export type InboxTab = "waiting" | "claimed" | "all";
export const INBOX_TABS: readonly InboxTab[] = ["waiting", "claimed", "all"];
export const INBOX_TAB_LABEL: Record<InboxTab, string> = {
  waiting: "Yanıt bekleyen",
  claimed: "Devralınan",
  all: "Tümü",
};

export interface InboxLead {
  created: string;
  inbox: InboxState | null;
}

export function parseInboxTab(value: string | null | undefined): InboxTab | null {
  return value && (INBOX_TABS as readonly string[]).includes(value) ? (value as InboxTab) : null;
}

export function inTab(lead: InboxLead, tab: InboxTab): boolean {
  if (tab === "all") return true;
  if (tab === "waiting") return Boolean(lead.inbox?.needsReply);
  return Boolean(lead.inbox?.claimedBy);
}

/** Son hareket: son mesaj, yoksa lead'in oluşturulması. */
export function lastActivity(lead: InboxLead): number {
  const at = lead.inbox?.lastMessage?.at ?? lead.created;
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

export function sortForTab<T extends InboxLead>(leads: T[], tab: InboxTab): T[] {
  const copy = leads.slice();
  if (tab === "waiting")
    return copy.sort(
      (a, b) => Date.parse(a.inbox?.waitingSince ?? a.created) - Date.parse(b.inbox?.waitingSince ?? b.created),
    );
  return copy.sort((a, b) => lastActivity(b) - lastActivity(a));
}

export function tabCounts(leads: InboxLead[]): Record<InboxTab, number> {
  return {
    waiting: leads.filter((l) => inTab(l, "waiting")).length,
    claimed: leads.filter((l) => inTab(l, "claimed")).length,
    all: leads.length,
  };
}
