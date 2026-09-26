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
