"use client";
import { useState, useEffect, useCallback } from "react";
import { api } from "../_lib/client-api";
import { Badge } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
import type { Tone } from "../_components/ui";
import { formatMoney } from "../_lib/format";
import {
  isApplicableRecommendation,
  RECOMMENDATION_KIND_LABEL,
  RECOMMENDATION_STATUS_LABEL,
  recommendationKind,
} from "../_lib/recommendation-kinds";

const STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", PENDING: "amber", APPROVED: "blue", APPLIED: "green", REJECTED: "red", EXPIRED: "gray" };
const PRIORITY_TONE: Record<string, Tone> = { HIGH: "red", MEDIUM: "amber", LOW: "blue" };
const FILTERS = ["ALL", "PENDING", "APPROVED", "APPLIED", "REJECTED"];

interface RecommendationData {
  id: string;
  type: string;
  title: string;
  description: string;
  reasoning: string;
  status: string;
  priority: string;
  action: Record<string, unknown> | null;
  expectedImpact: Record<string, unknown>;
  createdAt: string;
}
interface CampaignOption { id: string; name: string; budgetCents: number | null; currency: string; workflowStatus: string }

function impactLabel(key: string, value: unknown, currency: string): string | null {
  if (key === "currency") return null;
  if (key === "estimatedAdditionalLeads") return `Tahmini ek lead: +${String(value)}`;
  if (key === "estimatedSavings") return `Tahmini tasarruf: ${formatMoney(Math.round(Number(value) * 100), currency)}`;
  return `${key}: ${String(value)}`;
}

export default function RecommendationsPage() {
  const [recs, setRecs] = useState<RecommendationData[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("ALL");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ recommendations: RecommendationData[] }>("/api/recommendations");
      setRecs(data.recommendations);
      const needsCampaigns = data.recommendations.some((r) => r.status === "APPROVED" && isApplicableRecommendation(recommendationKind(r)));
      if (needsCampaigns) {
        const list = await api<{ campaigns: CampaignOption[] }>("/api/campaigns");
        setCampaigns(list.campaigns.filter((c) => c.workflowStatus !== "ARCHIVED"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Öneriler yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = filter === "ALL" ? recs : recs.filter((r) => r.status === filter);
  const pending = recs.filter((r) => r.status === "PENDING").length;
  const applied = recs.filter((r) => r.status === "APPLIED").length;

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    }
  }
  const approve = (id: string) => run(() => api(`/api/recommendations/${id}/approve`, "POST"), "Onaylanamadı.");
  const reject = (id: string) => run(() => api(`/api/recommendations/${id}`, "PATCH", { status: "REJECTED" }), "Reddedilemedi.");
  const apply = (rec: RecommendationData) => {
    const campaignId = (rec.action?.campaignId as string | undefined) || targets[rec.id];
    if (!campaignId) { setError("Uygulanacak kampanyayı seçin."); return Promise.resolve(); }
    return run(() => api(`/api/recommendations/${rec.id}/apply`, "POST", { campaignId }), "Uygulanamadı.");
  };

  if (loading) return <div className="studio-card animate-pulse">Öneriler yükleniyor…</div>;
  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">ÖNERİLER</span>
        <h1>Optimizasyon Önerileri</h1>
        <div className="mt-4 flex items-center gap-3">
          <span className="text-xs text-slate-400">{pending} onay bekliyor, {applied} uygulandı</span>
          <LanguageSwitcher />
        </div>
      </header>
      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{error}</div>}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((s) => (
          <button key={s} className={`rounded-full px-3 py-1 text-xs font-medium transition ${filter === s ? "bg-violet-500 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`} onClick={() => setFilter(s)}>
            {s === "ALL" ? "Tümü" : RECOMMENDATION_STATUS_LABEL[s] ?? s}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <p className="text-sm text-slate-500">Bu filtrede öneri yok.</p>
        ) : (
          filtered.map((r) => {
            const kind = recommendationKind(r);
            const applicable = isApplicableRecommendation(kind);
            const currency = typeof r.expectedImpact?.currency === "string" ? r.expectedImpact.currency : "EUR";
            const presetCampaign = typeof r.action?.campaignId === "string" ? r.action.campaignId : "";
            return (
              <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={STATUS_TONE[r.status] ?? "gray"}>{RECOMMENDATION_STATUS_LABEL[r.status] ?? r.status}</Badge>
                  <Badge tone={PRIORITY_TONE[r.priority ?? "LOW"] ?? "gray"}>{r.priority ?? "LOW"}</Badge>
                  <span className="font-medium">{RECOMMENDATION_KIND_LABEL[kind] ?? kind}</span>
                  {!applicable && <span className="text-xs text-slate-400">Değerlendirme notu — otomatik uygulanmaz</span>}
                </div>
                <h3 className="mt-2 text-base font-semibold">{r.title}</h3>
                <p className="mt-1 text-sm text-slate-500">{r.description}</p>
                <p className="mt-1 text-xs text-slate-400">{r.reasoning}</p>
                {r.expectedImpact && Object.keys(r.expectedImpact).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {Object.entries(r.expectedImpact).map(([k, v]) => {
                      const label = impactLabel(k, v, currency);
                      return label ? <span key={k} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{label}</span> : null;
                    })}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {r.status === "PENDING" && (
                    <>
                      <button className="primary-button text-xs" onClick={() => void approve(r.id)}>Onayla</button>
                      <button className="secondary-button text-xs" onClick={() => void reject(r.id)}>Reddet</button>
                    </>
                  )}
                  {r.status === "APPROVED" && applicable && (
                    <>
                      {presetCampaign ? (
                        <span className="text-xs text-slate-500">Hedef kampanya: {campaigns.find((c) => c.id === presetCampaign)?.name ?? presetCampaign}</span>
                      ) : (
                        <select
                          className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                          value={targets[r.id] ?? ""}
                          onChange={(e) => setTargets((t) => ({ ...t, [r.id]: e.target.value }))}
                          aria-label="Hedef kampanya"
                        >
                          <option value="">Kampanya seçin…</option>
                          {campaigns.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}{c.budgetCents != null ? ` — ${formatMoney(c.budgetCents, c.currency)}/gün` : " — bütçe yok"}
                            </option>
                          ))}
                        </select>
                      )}
                      <button className="primary-button text-xs" onClick={() => void apply(r)}>Uygula</button>
                      <button className="secondary-button text-xs" onClick={() => void reject(r.id)}>Reddet</button>
                    </>
                  )}
                  {r.status === "APPROVED" && !applicable && (
                    <button className="secondary-button text-xs" onClick={() => void reject(r.id)}>Kapat</button>
                  )}
                  <span className="text-xs text-slate-400 ml-auto">{new Date(r.createdAt).toLocaleDateString("tr-TR")}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
