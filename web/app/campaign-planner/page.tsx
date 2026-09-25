"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", IN_REVIEW: "amber", APPROVED: "blue", ACTIVE: "green", PAUSED: "amber", REJECTED: "red", ARCHIVED: "gray", PUBLISHED_PAUSED: "violet" };
const OBJECTIVE_LABEL: Record<string, string> = { MAX_ROAS: "Maksimum ROAS", MAX_CONVERSIONS: "Maksimum Dönüşüm", MAX_IMPRESSIONS: "Maksimum Görüntüleme" };
interface CampaignData { id: string; name: string; status: string; workflowStatus: string; policyRisk: string | null; objective: string; budget: number; adSets: number; createdAt: string; metaCampaignId: string | null; rejectionReason: string | null; }
export default function CampaignPlannerPage() {
  const [campaigns, setCampaigns] = useState<CampaignData[]>([]);
  const [conns, setConns] = useState<{ id: string; status: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftName, setDraftName] = useState("");
  const [objective, setObjective] = useState("MAX_ROAS");
  const [budget, setBudget] = useState("");
  const [notice, setNotice] = useState("");
  async function load() {
    setLoading(true);
    try { const data = await api<{ campaigns: CampaignData[] }>("/api/campaigns"); setCampaigns(data.campaigns); } catch { setCampaigns([]); }
    try { const c = await api<{ connections: { id: string; status: string }[] }>("/api/meta/connections"); setConns(c.connections ?? []); } catch { setConns([]); }
    setLoading(false);
  }
  async function createDraft() {
    if (!draftName) return;
    try { await api("/api/campaigns", "POST", JSON.stringify({ name: draftName, objective, budget: parseFloat(budget) || 1000 })); setDraftName(""); setBudget(""); load(); } catch {}
  }
  async function runAction(id: string, path: string, body?: object) {
    try { await api(`/api/campaigns/${id}/${path}`, "POST", JSON.stringify(body ?? {})); setNotice(""); load(); }
    catch { setNotice("İşlem tamamlanamadı. Yetki veya içerik kontrolünü kontrol edin."); }
  }
  useEffect(() => { load(); }, []);
  function actionsFor(c: CampaignData) {
    const w = c.workflowStatus;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {["DRAFT", "REJECTED"].includes(w) && <button onClick={() => runAction(c.id, "submit")} className="rounded-md border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50">Onaya Gönder</button>}
        {w === "IN_REVIEW" && <>
          <button onClick={() => runAction(c.id, "approve")} className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50">Onayla</button>
          <button onClick={() => runAction(c.id, "reject", { reason: "İnceleme sonrası reddedildi." })} className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Reddet</button>
        </>}
        {w === "APPROVED" && <button onClick={() => runAction(c.id, "publish", { action: "PUBLISH" })} className="primary-button !px-2.5 !py-1 !text-xs">Yayınla</button>}
        {w === "PUBLISHED_PAUSED" && <>
          <button onClick={() => runAction(c.id, "publish", { action: "ACTIVATE" })} className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50">Aktifleştir</button>
          <button onClick={() => runAction(c.id, "publish", { action: "ARCHIVE" })} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">Arşivle</button>
        </>}
        {w === "ACTIVE" && <>
          <button onClick={() => runAction(c.id, "publish", { action: "PAUSE" })} className="rounded-md border border-amber-200 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50">Duraklat</button>
          <button onClick={() => runAction(c.id, "publish", { action: "ARCHIVE" })} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">Arşivle</button>
        </>}
      </div>
    );
  }
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">KAMPANYA PLANLAYICI</span>
        <h1>Kampanya Taslak Oluştur</h1>
        <p className="text-sm text-slate-500">AI ajan taslağı üretir; onaylanmadan yayınlanmaz.</p>
      </header>
      {conns.some((c) => c.status === "EXPIRED" || c.status === "REVOKED") && (
        <a href="/meta-connections" className="block rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 hover:bg-rose-100">
          Meta bağlantısı kesik. Kampanya işlemlerini sürdürmek için bağlantıları yenileyin →
        </a>
      )}
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
          {notice && <p className="text-xs text-red-600">{notice}</p>}
        </div>
      </Card>
      <Card>
        <SectionHeading title="Taslaklar" description="Onaylanmamış kampanyalar." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : campaigns.length === 0 ? <EmptyState message="Henüz kampanya taslağı yok." /> : (
          <div className="space-y-3">
            {campaigns.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">{c.name}{c.metaCampaignId ? <span className="ml-2 text-xs text-slate-400">Meta: {c.metaCampaignId}</span> : null}</p>
                  <p className="text-xs text-slate-500">{OBJECTIVE_LABEL[c.objective] ?? c.objective} · {c.adSets} ad set{c.policyRisk ? <span className="ml-2">İçerik riski: {c.policyRisk}</span> : null}</p>
                  {c.rejectionReason && <p className="text-xs text-red-600">Red gerekçesi: {c.rejectionReason}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {actionsFor(c)}
                  <Badge tone={STATUS_TONE[c.workflowStatus] ?? "gray"}>{c.workflowStatus}</Badge>
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