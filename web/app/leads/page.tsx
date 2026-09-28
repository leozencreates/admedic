"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { formatDate } from "../_lib/format";
import { LEAD_STAGES, leadStatusStyle } from "../_lib/labels";
import { LeadTable, toLead, type ApiLead, type Lead } from "../_components/lead-table";

/** Liste sekme görünürken bu aralıkla sessizce yenilenir (yükleniyor göstergesi yok). */
const REFRESH_MS = 20_000;
const LOAD_ERROR = "Lead'ler yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.";
const STATUS_OPTIONS: string[] = [...LEAD_STAGES, "LOST"];

/** "14:05" (Europe/Istanbul; format.ts'in tarih biçiminden). */
function clockTime(date: Date): string {
  const text = formatDate(date);
  const comma = text.lastIndexOf(", ");
  return comma === -1 ? text : text.slice(comma + 2);
}

export default function LeadsPage() {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [pendingFetch, setPendingFetch] = useState(0);
  const [refetching, setRefetching] = useState(false);
  const [notice, setNotice] = useState("");
  const [refetchError, setRefetchError] = useState("");
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
      // Yanıtlar sırasız gelebilir: daha yeni bir yanıt uygulandıysa eskisi atılır.
      if (seq > appliedSeq.current) {
        appliedSeq.current = seq;
        setLeads(data.leads.map(toLead));
        setUpdatedAt(new Date());
        setError("");
      }
    } catch {
      // Arka plan yenilemesindeki hata listeyi silmez; "Son güncelleme" saati eski kalır.
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

  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">LEAD YÖNETİMİ / 01</span>
        <h1>Lead CRM</h1>
        <p>Tüm potansiyel müşterilerinizi görün, filtreleyin ve takip edin.</p>
        {!loading && !error && (
          <div className="hero-tags">
            <span>{leads.length} lead</span>
          </div>
        )}
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="field min-w-[200px] flex-1">
          Ara
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="İsim, e-posta veya telefon arayın…"
          />
        </label>
        <label className="field">
          Durum
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Tüm durumlar</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {leadStatusStyle(s).label}
              </option>
            ))}
          </select>
        </label>
        {updatedAt && (
          <p className="ml-auto pb-3 text-xs text-muted">
            Son güncelleme <time dateTime={updatedAt.toISOString()}>{clockTime(updatedAt)}</time>
          </p>
        )}
      </div>

      {pendingFetch > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              {pendingFetch} Anında Form lead&apos;inin yanıtları Meta&apos;dan çekilemedi (ad, iletişim ve form yanıtları eksik).
            </span>
            <button className="secondary-button" disabled={refetching} onClick={() => void refetchAll()}>
              {refetching ? "Çekiliyor…" : "Meta'dan yeniden çek"}
            </button>
          </div>
          {refetchError && (
            <p role="alert" className="text-rose-700">
              {refetchError}
            </p>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {error && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
          <span>{error}</span>
          <button className="secondary-button" onClick={() => void load()}>
            Tekrar dene
          </button>
        </div>
      )}

      {loading ? (
        <div className="studio-card animate-pulse" role="status">
          Lead&apos;ler yükleniyor…
        </div>
      ) : error && leads.length === 0 ? null : (
        <LeadTable
          leads={leads}
          search={search}
          statusFilter={statusFilter}
          onRowClick={(id) => router.push(`/leads/${id}`)}
          onClearFilters={() => {
            setSearch("");
            setStatusFilter("");
          }}
        />
      )}

      <Link href="/" className="text-sm text-violet-600">
        ← Ana sayfa
      </Link>
    </div>
  );
}
