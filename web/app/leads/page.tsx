"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { LeadTable, toLead, type ApiLead } from "../_components/lead-table";
import { LanguageSwitcher } from "../_components/language-switcher";

export default function LeadsPage() {
  const router = useRouter();
  const [leads, setLeads] = useState<ReturnType<typeof toLead>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [pendingFetch, setPendingFetch] = useState(0);
  const [refetching, setRefetching] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ leads: ApiLead[] }>("/api/leads");
      setLeads(data.leads.map(toLead));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Leadler yüklenemedi.");
    } finally {
      setLoading(false);
    }
    try {
      const pending = await api<{ pending: number }>("/api/leads/refetch");
      setPendingFetch(pending.pending);
    } catch {
      setPendingFetch(0);
    }
  }

  async function refetchAll() {
    setRefetching(true);
    setNotice("");
    setError("");
    try {
      const result = await api<{ recovered: number; failed: number; remaining: number }>("/api/leads/refetch", "POST", {});
      setNotice(
        `Meta'dan yeniden çekildi: ${result.recovered} lead tamamlandı` +
          (result.failed ? `, ${result.failed} lead hâlâ çekilemiyor (Meta bağlantısı / lead izni)` : "") +
          (result.remaining ? ` · bekleyen: ${result.remaining}` : "") +
          ".",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Yeniden çekme başarısız.");
    } finally {
      setRefetching(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const statusOptions = [
    "NEW",
    "CONTACTED",
    "QUALIFIED",
    "CONSULTATION_BOOKED",
    "TRAVEL_PLANNED",
    "TREATED",
    "LOST",
  ];

  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">LEAD YÖNETİMİ / 01</span>
        <h1>Lead CRM</h1>
        <p>Tüm potansiyel müşterilerinizi görün, filtreleyin ve takip edin.</p>
        <div className="hero-tags">
          <span>{leads.length} lead</span>
          <span>Gerçek zamanlı takip</span>
        </div>
      </header>

      <div className="flex flex-wrap gap-3 items-center">
        <label className="field flex-1 min-w-[200px]">
          Ara
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="İsim, e-posta veya telefon arayın…"
          />
        </label>
        <label className="field">
          Durum
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">Tüm durumlar</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <LanguageSwitcher />
      </div>

      {pendingFetch > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="status">
          <span>
            {pendingFetch} Instant Form lead'inin yanıtları Meta'dan çekilemedi (ad, iletişim ve form yanıtları eksik).
          </span>
          <button className="secondary-button" disabled={refetching} onClick={() => void refetchAll()}>
            {refetching ? "Çekiliyor…" : "Meta'dan yeniden çek"}
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-violet-700">
          {notice}
        </p>
      )}

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
          {error}
          <button className="secondary-button ml-3" onClick={load}>
            Tekrar dene
          </button>
        </div>
      )}

      {loading ? (
        <div className="studio-card animate-pulse" role="status">
          Leadler yükleniyor…
        </div>
      ) : (
        <LeadTable
          leads={leads}
          search={search}
          statusFilter={statusFilter}
          onRowClick={(id) => router.push(`/leads/${id}`)}
        />
      )}

      <Link href="/" className="text-sm text-violet-600">
        ← Ana sayfa
      </Link>
    </div>
  );
}
