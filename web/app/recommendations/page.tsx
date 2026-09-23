"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
import type { Tone } from "../_components/ui";
const TYPE_LABEL: Record<string, string> = { BUDGET_REALLOCATION: "Bütçe Yeniden Tahsisi", CREATIVE_SWAP: "Kreatif Değişimi", AUDIENCE_TUNE: "Kitle Ayarı", BID_ADJUSTMENT: "Teklif Ayarı", CREATIVE_FATIGUE: "Kreatif Yorgunluğu" };
const STATUS_LABEL: Record<string, string> = { DRAFT: "Taslak", PENDING: "Onay Beklemede", APPROVED: "Onaylandı", APPLIED: "Uygulandı", REJECTED: "Reddedildi" };
const STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", PENDING: "amber", APPROVED: "blue", APPLIED: "green", REJECTED: "red" };
const PRIORITY_TONE: Record<string, Tone> = { HIGH: "red", MEDIUM: "amber", LOW: "blue" };
interface RecommendationData {
  id: string;
  type: string;
  title: string;
  description: string;
  reasoning: string;
  status: string;
  priority: string;
  expectedImpact: Record<string, unknown>;
  createdAt: string;
}
export default function RecommendationsPage() {
  const [recs, setRecs] = useState<RecommendationData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("ALL");
  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ recommendations: RecommendationData[] }>("/api/recommendations");
      setRecs(data.recommendations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Öneriler yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);
  const filtered = filter === "ALL" ? recs : recs.filter((r) => r.status === filter);
  const pending = recs.filter((r) => r.status === "PENDING").length;
  const applied = recs.filter((r) => r.status === "APPLIED").length;
  async function applyRecommendation(id: string) {
    try {
      await api(`/api/recommendations/${id}/apply`, "POST");
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Uygulanamadı.");
    }
  }
  async function approveRecommendation(id: string) {
    try {
      await api(`/api/recommendations/${id}/approve`, "POST");
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onaylanamadı.");
    }
  }
  if (loading) return <div className="studio-card animate-pulse">Öneriler yükleniyor…</div>;
  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{error}</div>;
  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">ÖNERİLER</span>
        <h1>Optimizasyon Önerileri</h1>
        <div className="mt-4 flex items-center gap-3">
          <span className="text-xs text-slate-400">{pending} bekleyen, {applied} uygulandı</span>
          <LanguageSwitcher />
        </div>
      </header>
      <div className="flex flex-wrap gap-2">
        {["ALL", "PENDING", "APPROVED", "APPLIED", "REJECTED"].map((s) => (
          <button key={s} className={`rounded-full px-3 py-1 text-xs font-medium transition ${filter === s ? "bg-violet-500 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`} onClick={() => setFilter(s)}>
            {s === "ALL" ? "Tümü" : STATUS_LABEL[s] ?? s}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <p className="text-sm text-slate-500">Bu filtrede öneri yok.</p>
        ) : (
          filtered.map((r) => (
            <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-3">
                <Badge tone={STATUS_TONE[r.status] ?? "gray"}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                <Badge tone={PRIORITY_TONE[r.priority ?? "LOW"] ?? "gray"}>{r.priority ?? "LOW"}</Badge>
                <span className="font-medium">{TYPE_LABEL[r.type] ?? r.type}</span>
              </div>
              <h3 className="mt-2 text-base font-semibold">{r.title}</h3>
              <p className="mt-1 text-sm text-slate-500">{r.description}</p>
              <p className="mt-1 text-xs text-slate-400">{r.reasoning}</p>
              {Object.keys(r.expectedImpact).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.entries(r.expectedImpact).map(([k, v]) => (
                    <span key={k} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{k}: {typeof v === "number" ? (v / 100).toFixed(1) + "%" : String(v)}</span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                {r.status === "PENDING" && (
                  <>
                    <button className="primary-button text-xs" onClick={() => void approveRecommendation(r.id)}>Onayla</button>
                    <button className="primary-button text-xs" onClick={() => void applyRecommendation(r.id)}>Uygula</button>
                  </>
                )}
                <span className="text-xs text-slate-400 ml-auto">{new Date(r.createdAt).toLocaleDateString("tr-TR")}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
