"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { LEAD_SEARCH_EVENT } from "../_components/app-shell";
import { Badge } from "../_components/ui";
import { api } from "../_lib/client-api";
import { formatDuration, formatRelative } from "../_lib/format";
import { LEAD_STAGES, channelLabel, countryName, languageName, leadStatusStyle } from "../_lib/labels";
import { filterLeads, toLead, type ApiLead, type Lead } from "../_components/lead-table";
import {
  INBOX_TABS,
  INBOX_TAB_LABEL,
  inTab,
  lastActivity,
  parseInboxTab,
  sortForTab,
  tabCounts,
  type InboxTab,
} from "../_lib/inbox-view";

/** Liste sekme görünürken bu aralıkla sessizce yenilenir. */
const REFRESH_MS = 20_000;
const LOAD_ERROR = "Lead'ler yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.";
const STATUS_OPTIONS: string[] = [...LEAD_STAGES, "LOST"];
const PARTY_PREFIX: Record<string, string> = { assistant: "Asistan: ", team: "Ekip: ", system: "", lead: "" };

/**
 * Gelen kutusu listesi (ADR-0019 · K4-A): sekmeler (Yanıt bekleyen · Devralınan · Tümü), arama, durum süzgeci
 * ve kart listesi. Kartın tamamı tek bağlantıdır; seçili lead `aria-current="page"` taşır.
 * Seçim URL'dedir (`/leads/<id>`); sekme `?tab=` ile paylaşılabilir.
 */
export function LeadInbox({ selectedId }: { selectedId: string | null }) {
  const pathname = usePathname();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<InboxTab | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [pendingFetch, setPendingFetch] = useState(0);
  const [refetching, setRefetching] = useState(false);
  const [notice, setNotice] = useState("");
  const [refetchError, setRefetchError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    const seq = ++requestSeq.current;
    if (!options.silent) {
      setLoading(true);
      setError("");
    }
    try {
      const data = await api<{ leads: ApiLead[] }>("/api/leads");
      if (seq > appliedSeq.current) {
        appliedSeq.current = seq;
        setLeads(data.leads.map(toLead));
        setNow(Date.now());
        setError("");
      }
    } catch {
      // Arka plan yenilemesindeki hata listeyi silmez.
      if (!options.silent && seq > appliedSeq.current) setError(LOAD_ERROR);
    } finally {
      if (!options.silent) setLoading(false);
    }
    try {
      const pending = await api<{ pending: number }>("/api/leads/refetch");
      setPendingFetch(pending.pending);
    } catch {
      // Bekleyen sayısı alınamazsa bant olduğu gibi kalır.
    }
  }, []);

  // URL parametreleri: ?tab= (sekme), ?q= (üst çubuk araması), ?status= (durum süzgeci).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setTab(parseInboxTab(params.get("tab")));
    const q = params.get("q");
    if (q) setSearch(q);
    const status = params.get("status");
    if (status) setStatusFilter(status);
    const onSearch = (e: Event) => setSearch(String((e as CustomEvent<string>).detail ?? ""));
    window.addEventListener(LEAD_SEARCH_EVENT, onSearch);
    return () => window.removeEventListener(LEAD_SEARCH_EVENT, onSearch);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load({ silent: true });
    }, REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  // Bir lead'e yanıt verilince liste hemen tazelensin (ayrıntı sayfasından dönüldüğünde).
  useEffect(() => {
    void load({ silent: true });
  }, [pathname, load]);

  const counts = tabCounts(leads);
  // Sekme seçilmemişse: yanıt bekleyen varsa o, yoksa Tümü.
  const activeTab: InboxTab = tab ?? (counts.waiting > 0 ? "waiting" : "all");
  const visible = sortForTab(
    filterLeads(leads, search, statusFilter).filter((l) => inTab(l, activeTab)),
    activeTab,
  );

  function chooseTab(next: InboxTab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
  }

  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = INBOX_TABS[(index + delta + INBOX_TABS.length) % INBOX_TABS.length];
    chooseTab(next);
    document.getElementById(`gelen-sekme-${next}`)?.focus();
  }

  async function refetchAll() {
    setRefetching(true);
    setNotice("");
    setRefetchError("");
    try {
      const result = await api<{ recovered: number; failed: number; remaining: number }>("/api/leads/refetch", "POST", {});
      setNotice(
        `Meta'dan yeniden çekildi: ${result.recovered} lead tamamlandı` +
          (result.failed ? `, ${result.failed} lead hâlâ çekilemiyor (Meta bağlantısı / lead izni)` : "") +
          (result.remaining ? ` · bekleyen: ${result.remaining}` : "") +
          ".",
      );
      await load({ silent: true });
    } catch (e) {
      setRefetchError(e instanceof Error ? e.message : "Meta'dan yeniden çekilemedi. Birkaç dakika sonra tekrar deneyin.");
    } finally {
      setRefetching(false);
    }
  }

  const Heading = selectedId ? "h2" : "h1";
  const filtered = Boolean(search.trim() || statusFilter);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 border-b border-line p-3">
        <div className="flex items-baseline justify-between gap-2 px-1">
          <Heading className="text-lg font-semibold text-ink max-lg:sr-only">Lead&apos;ler</Heading>
          {!loading && !error ? <p className="text-xs text-ink-3">{leads.length} lead</p> : null}
        </div>
        <div role="tablist" aria-label="Lead listesi" className="flex gap-1 rounded-md bg-line-soft p-1">
          {INBOX_TABS.map((key, i) => {
            const selected = activeTab === key;
            return (
              <button
                key={key}
                id={`gelen-sekme-${key}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="gelen-liste"
                tabIndex={selected ? 0 : -1}
                onClick={() => chooseTab(key)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={`flex min-h-9 flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded px-2 text-[13px] font-medium max-lg:min-h-11 ${
                  selected ? "bg-surface text-ink shadow-[0_1px_2px_rgb(16_24_40/0.08)]" : "text-ink-2 hover:text-ink"
                }`}
              >
                <span>{INBOX_TAB_LABEL[key]}</span>
                <span className={`tabular-nums ${key === "waiting" && counts.waiting > 0 ? "rounded-full bg-warn-badge px-1.5 text-warn" : "text-ink-3"}`}>
                  {counts[key]}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-surface px-2.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-brand-600">
            <Search size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
            <span className="sr-only">Lead listesinde ara</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Ara"
              className="min-h-9 w-full min-w-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <label className="shrink-0">
            <span className="sr-only">Durum</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input !w-[9.5rem] !py-1.5 text-sm">
              <option value="">Tüm durumlar</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {leadStatusStyle(s).label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {pendingFetch > 0 ? (
          <div className="space-y-2 rounded-md border border-warn-line bg-warn-bg p-2.5 text-xs text-warn">
            <p>{pendingFetch} Anında Form lead&apos;inin yanıtları Meta&apos;dan çekilemedi.</p>
            <button type="button" className="secondary-button !min-h-8 !px-2.5 !text-xs" disabled={refetching} onClick={() => void refetchAll()}>
              {refetching ? "Çekiliyor…" : "Meta'dan yeniden çek"}
            </button>
            {refetchError ? <p role="alert" className="text-bad">{refetchError}</p> : null}
          </div>
        ) : null}
        <p role="status" className={notice ? "text-xs text-ok" : "sr-only"}>
          {notice}
        </p>
      </div>

      <div id="gelen-liste" role="tabpanel" aria-labelledby={`gelen-sekme-${activeTab}`} className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p role="status" className="p-4 text-sm text-ink-2">
            Lead&apos;ler yükleniyor…
          </p>
        ) : error ? (
          <div role="alert" className="space-y-2 p-4 text-sm text-bad">
            <p>{error}</p>
            <button type="button" className="secondary-button" onClick={() => void load()}>
              Tekrar dene
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="space-y-2 p-4 text-sm text-ink-2">
            <p>
              {filtered
                ? "Aramanızla eşleşen lead yok."
                : activeTab === "waiting"
                  ? "Yanıt bekleyen lead yok."
                  : activeTab === "claimed"
                    ? "Devralınmış konuşma yok."
                    : "Henüz lead yok. Reklamlarınızdan gelen başvurular burada görünür."}
            </p>
            {filtered ? (
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("");
                }}
              >
                Süzgeçleri temizle
              </button>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y divide-line-soft">
            {visible.map((lead) => (
              <li key={lead.id}>
                <LeadCard lead={lead} selected={lead.id === selectedId} now={now} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function LeadCard({ lead, selected, now }: { lead: Lead; selected: boolean; now: number }) {
  const status = leadStatusStyle(lead.status);
  const inbox = lead.inbox;
  const last = inbox?.lastMessage;
  const meta = [channelLabel(lead.channel), countryName(lead.country), languageName(lead.language)].filter(
    (v) => v && v !== "—",
  );
  const lang = lead.language ? lead.language.toLowerCase() : undefined;
  return (
    <Link
      href={`/leads/${lead.id}`}
      aria-current={selected ? "page" : undefined}
      className={`block min-h-[72px] px-4 py-3 text-left hover:bg-subtle ${selected ? "bg-brand-50 hover:bg-brand-50" : ""}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-[15px] font-medium text-ink" dir="auto">
          {lead.name}
        </span>
        <span className="shrink-0 text-xs text-ink-2">
          <time dateTime={new Date(lastActivity(lead)).toISOString()}>{formatRelative(new Date(lastActivity(lead)), new Date(now))}</time>
        </span>
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
        <span className="min-w-0 truncate">{meta.join(" · ")}</span>
      </span>
      {last?.preview ? (
        <span className="mt-1 block truncate text-sm text-ink-2">
          {PARTY_PREFIX[last.party] ?? ""}
          <span lang={last.party === "lead" ? lang : undefined} dir="auto">
            {last.preview}
          </span>
        </span>
      ) : null}
      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={status.tone}>{status.label}</Badge>
        {inbox?.handedOff ? <Badge tone="amber">Asistan devretti</Badge> : null}
        {inbox?.claimedBy ? <Badge tone="blue">{inbox.claimedByMe ? "Sizde" : `Devralan: ${inbox.claimedBy}`}</Badge> : null}
        {inbox?.conversationStatus === "ACTIVE" ? <Badge tone="gray">Asistan yanıtlıyor</Badge> : null}
        {inbox?.needsReply && inbox.waitingSince ? (
          <span className="text-xs font-medium text-warn">{formatDuration(now - Date.parse(inbox.waitingSince))} bekliyor</span>
        ) : null}
      </span>
    </Link>
  );
}
