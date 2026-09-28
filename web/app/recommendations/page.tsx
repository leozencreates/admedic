"use client";
import { useState, useEffect, useCallback } from "react";
import { api } from "../_lib/client-api";
import { Badge } from "../_components/ui";
import { formatDate, formatMoney, formatMoneyUnits, formatNumber } from "../_lib/format";
import { priorityLabel, recommendationStatusStyle } from "../_lib/labels";
import {
  isApplicableRecommendation,
  RECOMMENDATION_KIND_LABEL,
  recommendationKind,
} from "../_lib/recommendation-kinds";

const FILTERS = ["ALL", "PENDING", "APPROVED", "APPLIED", "REJECTED"] as const;
type Filter = (typeof FILTERS)[number];

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

/** Beklenen etki: bilinen anahtarlar etiketlenir; bilinmeyen anahtar ve değer gösterilmez. */
function impactLabel(key: string, value: unknown, currency: string): string | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // estimatedSavings ana birimdedir (avro), minor unit değil.
  if (key === "estimatedAdditionalLeads") return `Tahmini ek lead: +${formatNumber(n)}`;
  if (key === "estimatedSavings") return `Tahmini tasarruf: ${formatMoneyUnits(n, currency)}`;
  return null;
}

export default function RecommendationsPage() {
  const [recs, setRecs] = useState<RecommendationData[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");

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
      setError(e instanceof Error ? e.message : "Öneriler yüklenemedi. Sayfayı yenileyip tekrar deneyin.");
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
  const approve = (id: string) =>
    run(() => api(`/api/recommendations/${id}/approve`, "POST"), "Öneri onaylanamadı. Sayfayı yenileyip tekrar deneyin.");
  const dismiss = (id: string) =>
    run(() => api(`/api/recommendations/${id}`, "PATCH", { status: "REJECTED" }), "Öneri yok sayılamadı. Sayfayı yenileyip tekrar deneyin.");
  const apply = (rec: RecommendationData) => {
    const campaignId = (rec.action?.campaignId as string | undefined) || targets[rec.id];
    if (!campaignId) { setError("Önerinin uygulanacağı kampanyayı seçin."); return Promise.resolve(); }
    return run(
      () => api(`/api/recommendations/${rec.id}/apply`, "POST", { campaignId }),
      "Öneri uygulanamadı. Sayfayı yenileyip tekrar deneyin.",
    );
  };

  if (loading) return <div className="studio-card animate-pulse" role="status">Öneriler yükleniyor…</div>;
  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">ÖNERİLER</span>
        <h1>Optimizasyon önerileri</h1>
        <p>Tamamlanan A/B testlerinden üretilen öneriler. Onaylanmadan hiçbiri uygulanmaz.</p>
        <p className="mt-2">
          {formatNumber(pending)} öneri onay bekliyor · {formatNumber(applied)} öneri uygulandı
        </p>
      </header>
      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{error}</div>}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Duruma göre süz">
        {FILTERS.map((s) => {
          const active = filter === s;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={active}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition ${active ? "bg-brand-strong text-white ring-brand-strong" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}
              onClick={() => setFilter(s)}
            >
              {active ? <span aria-hidden="true">✓ </span> : null}
              {s === "ALL" ? "Tümü" : recommendationStatusStyle(s).label}
            </button>
          );
        })}
      </div>
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted">
            {recs.length === 0 ? "Henüz öneri yok. Öneriler tamamlanan A/B testlerinden oluşturulur." : "Bu filtrede öneri yok."}
          </p>
        ) : (
          filtered.map((r) => {
            const kind = recommendationKind(r);
            const applicable = isApplicableRecommendation(kind);
            const status = recommendationStatusStyle(r.status);
            const currency = typeof r.expectedImpact?.currency === "string" ? r.expectedImpact.currency : "EUR";
            const presetCampaign = typeof r.action?.campaignId === "string" ? r.action.campaignId : "";
            const impacts = Object.entries(r.expectedImpact ?? {})
              .map(([k, v]) => ({ key: k, label: impactLabel(k, v, currency) }))
              .filter((i): i is { key: string; label: string } => i.label !== null);
            return (
              <article key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <Badge tone="gray">{priorityLabel(r.priority)}</Badge>
                  <span className="text-sm font-medium text-slate-700">{RECOMMENDATION_KIND_LABEL[kind] ?? "Diğer öneri"}</span>
                  {!applicable && <span className="text-xs text-muted">Değerlendirme notu — otomatik uygulanmaz</span>}
                </div>
                <h2 className="mt-2 text-base font-semibold text-slate-900">{r.title}</h2>
                <p className="mt-1 text-sm text-slate-600">{r.description}</p>
                <p className="mt-1 text-xs text-muted">{r.reasoning}</p>
                {impacts.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {impacts.map((i) => (
                      <span key={i.key} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{i.label}</span>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {r.status === "PENDING" && (
                    <>
                      <button type="button" className="primary-button text-xs" onClick={() => void approve(r.id)}>Onayla</button>
                      <button type="button" className="secondary-button text-xs" onClick={() => void dismiss(r.id)}>Yok say</button>
                    </>
                  )}
                  {r.status === "APPROVED" && applicable && (
                    <>
                      {presetCampaign ? (
                        <span className="text-xs text-slate-600">
                          Hedef kampanya: {campaigns.find((c) => c.id === presetCampaign)?.name ?? "Bilinmeyen kampanya"}
                        </span>
                      ) : (
                        <select
                          className="input w-auto max-w-full py-2 text-xs"
                          value={targets[r.id] ?? ""}
                          onChange={(e) => setTargets((t) => ({ ...t, [r.id]: e.target.value }))}
                          aria-label="Hedef kampanya"
                        >
                          <option value="">Kampanya seçin…</option>
                          {campaigns.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}{c.budgetCents != null ? ` — ${formatMoney(c.budgetCents, c.currency)}/gün` : " — günlük bütçe yok"}
                            </option>
                          ))}
                        </select>
                      )}
                      <button type="button" className="primary-button text-xs" onClick={() => void apply(r)}>Uygula</button>
                      <button type="button" className="secondary-button text-xs" onClick={() => void dismiss(r.id)}>Yok say</button>
                    </>
                  )}
                  {r.status === "APPROVED" && !applicable && (
                    <button type="button" className="secondary-button text-xs" onClick={() => void dismiss(r.id)}>Yok say</button>
                  )}
                  <span className="ml-auto text-xs text-muted">{formatDate(r.createdAt)}</span>
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
