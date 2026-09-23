"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", IN_REVIEW: "amber", APPROVED: "blue", ACTIVE: "green", PAUSED: "amber", REJECTED: "red", ARCHIVED: "gray" };
const OBJECTIVE_LABEL: Record<string, string> = { MAX_ROAS: "Maksimum ROAS", MAX_CONVERSIONS: "Maksimum Dönüşüm", MAX_IMPRESSIONS: "Maksimum Görüntüleme" };
interface CampaignData { id: string; name: string; status: string; objective: string; budget: number; adSets: number; createdAt: string; }
export default function CampaignPlannerPage() {
  const [campaigns, setCampaigns] = useState<CampaignData[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftName, setDraftName] = useState("");
  const [objective, setObjective] = useState("MAX_ROAS");
  const [budget, setBudget] = useState("");
  async function load() {
    setLoading(true);
    try { const data = await api<{ campaigns: CampaignData[] }>("/api/campaigns"); setCampaigns(data.campaigns); } catch { setCampaigns([]); }
    setLoading(false);
  }
  async function createDraft() {
    if (!draftName) return;
    try { await api("/api/campaigns", "POST", JSON.stringify({ name: draftName, objective, budget: parseFloat(budget) || 1000 })); setDraftName(""); setBudget(""); load(); } catch {}
  }
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">KAMPANYA PLANLAYICI</span>
        <h1>Kampanya Taslak Oluştur</h1>
        <p className="text-sm text-slate-500">AI ajan taslağı üretir; onaylanmadan yayınlanmaz.</p>
      </header>
      <Card>
        <SectionHeading title="Yeni Taslak" description="Hedef, bütçe ve hedefleme ayarları." />
        <div className="mt-6 space-y-4">
          <input placeholder="Kampanya adı" value={draftName} onChange={(e) => setDraftName(e.target.value)} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-400/30" />
          <div className="flex gap-4">
            <select value={objective} onChange={(e) => setObjective(e.target.value)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
              {Object.entries(OBJECTIVE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input type="number" placeholder="Bütçe (TL)" value={budget} onChange={(e) => setBudget(e.target.value)} className="w-48 rounded-lg border border-slate-300 px-4 py-2 text-sm" />
          </div>
          <button onClick={createDraft} className="primary-button">AI ile Taslak Oluştur</button>
        </div>
      </Card>
      <Card>
        <SectionHeading title="Taslaklar" description="Onaylanmamış kampanyalar." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : campaigns.length === 0 ? <EmptyState message="Henüz kampanya taslağı yok." /> : (
          <div className="space-y-3">
            {campaigns.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div><p className="text-sm font-medium text-slate-900">{c.name}</p><p className="text-xs text-slate-500">{OBJECTIVE_LABEL[c.objective] ?? c.objective} · {c.adSets} ad set</p></div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[c.status] ?? "gray"}>{c.status}</Badge>
                  <span className="text-xs text-slate-400">{new Date(c.createdAt).toLocaleDateString("tr-TR")}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
