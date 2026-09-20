"use client";
import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { api } from "../../_lib/client-api";
import { LeadChat } from "../../_components/lead-chat";
import { Badge } from "../../_components/ui";
import { toLead } from "../../_components/lead-table";
import { formatDate } from "../../_lib/format";
import type { Tone } from "../../_components/ui";

interface ApiLead {
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
}

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

const FLOW: Record<string, string[]> = {
  NEW: ["CONTACTED"],
  CONTACTED: ["QUALIFIED"],
  QUALIFIED: ["CONSULTATION_BOOKED"],
  CONSULTATION_BOOKED: ["TRAVEL_PLANNED"],
  TRAVEL_PLANNED: ["TREATED", "LOST"],
};

export default function LeadDetailPage() {
  const router = useRouter();
  const { id } = useParams();
  const [lead, setLead] = useState<ReturnType<typeof toLead> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ lead: ApiLead }>(`/api/leads/${id}`);
      setLead(toLead(data.lead));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lead yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [id]);

  async function transitionStatus(nextStatus: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/leads/${id}`, "PATCH", { status: nextStatus });
      setLead((prev: ReturnType<typeof toLead> | null) => (prev ? { ...prev, status: nextStatus } : prev));
      setNotice(`Durum güncellendi: ${STATUS_LABEL[nextStatus] ?? nextStatus}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Durum güncellenemedi.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="studio-card animate-pulse" role="status">
        Lead detayı yükleniyor…
      </div>
    );
  }

  if (error || !lead) {
    return (
      <div className="space-y-4">
        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
            {error}
          </div>
        )}
        <Link href="/leads" className="text-sm text-violet-600">
          ← Lead listesine geri dön
        </Link>
      </div>
    );
  }

  const nextStatuses = FLOW[lead.status] ?? [];

  return (
    <div className="space-y-6">
      <Link href="/leads" className="text-sm text-violet-600">
        ← Lead listesine geri dön
      </Link>

      <header className="studio-hero">
        <span className="eyebrow">LEAD DETAY</span>
        <h1>{lead.name}</h1>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Badge tone={STATUS_TONE[lead.status] ?? "gray"}>
            {STATUS_LABEL[lead.status] ?? lead.status}
          </Badge>
          <span className="text-xs text-slate-400">
            Oluşturulma: {formatDate(lead.created)}
          </span>
        </div>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="studio-card">
          <div className="section-kicker">BİLGİLER</div>
          <h2>Kişi Bilgileri</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Ad</dt>
              <dd className="font-medium text-slate-900">{lead.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Telefon</dt>
              <dd className="font-medium text-slate-900">{lead.phone}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">E-posta</dt>
              <dd className="font-medium text-slate-900">{lead.email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Kanal</dt>
              <dd className="font-medium text-slate-900">{lead.channel}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Ülke</dt>
              <dd className="font-medium text-slate-900">{lead.country}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Durum</dt>
              <dd>
                <Badge tone={STATUS_TONE[lead.status] ?? "gray"}>
                  {STATUS_LABEL[lead.status] ?? lead.status}
                </Badge>
              </dd>
            </div>
          </dl>
        </section>

        <section className="studio-card">
          <div className="section-kicker">DURUM GEÇİŞİ</div>
          <h2>Durum Atlama</h2>
          <p className="mt-2 text-sm text-slate-500">
            Bu lead'in şu anki durumu:{" "}
            <strong>{STATUS_LABEL[lead.status] ?? lead.status}</strong>
          </p>
          {nextStatuses.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-3">
              {nextStatuses.map((next) => (
                <button
                  key={next}
                  className="primary-button"
                  disabled={busy}
                  onClick={() => transitionStatus(next)}
                >
                  {busy ? "Güncelleniyor…" : `${STATUS_LABEL[next] ?? next} →`}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">
              Bu durumdan ileri geçiş yapılamıyor veya lead zaten son duruma erişmiş.
            </p>
          )}
        </section>
      </div>

      {notice && (
        <p role="status" className="text-sm text-violet-700">
          {notice}
        </p>
      )}

      <LeadChat leadId={lead.id} />
    </div>
  );
}
