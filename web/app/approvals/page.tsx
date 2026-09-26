"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading, StatCard } from "../_components/ui";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const APPROVAL_TONE: Record<string, Tone> = { PENDING: "amber", APPROVED: "green", REJECTED: "red", NOT_REQUIRED: "blue", DRAFT: "gray" };
interface DecisionData { id: string; targetType: string; targetId: string; action: string; approval: string; changePct: number | null; reasoning: string; createdAt: string; }
export default function ApprovalsPage() {
  const [decisions, setDecisions] = useState<DecisionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("ALL");
  async function load() {
    setLoading(true);
    try { const data = await api<{ decisions: DecisionData[] }>("/api/decisions"); setDecisions(data.decisions); } catch { setDecisions([]); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  const filtered = filter === "ALL" ? decisions : decisions.filter((d) => d.approval === filter);
  const counts = { PENDING: decisions.filter((d) => d.approval === "PENDING").length, APPROVED: decisions.filter((d) => d.approval === "APPROVED").length, REJECTED: decisions.filter((d) => d.approval === "REJECTED").length };
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">ONAY AKIŞI</span>
        <h1>Onay Merkezi</h1>
        <p className="text-sm text-slate-500">Ajan kararları ve onay akışı.</p>
      </header>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Onay bekleyen" value={counts.PENDING} hint="Harcama değiştiren aksiyonlar" />
        <StatCard label="Onaylanan" value={counts.APPROVED} />
        <StatCard label="Reddedilen" value={counts.REJECTED} />
        <StatCard label="Toplam" value={decisions.length} />
      </div>
      <Card>
        <SectionHeading title="Kararlar" description="Ajan yalnızca öneri üretir; harcamayı değiştiren aksiyonlar onay bekler." />
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          {(["ALL", "PENDING", "APPROVED", "REJECTED"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`rounded-full border px-3 py-1 ${filter === key ? "border-violet-400 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              {key === "ALL" ? "Tümü" : key === "PENDING" ? "Onay bekleyen" : key === "APPROVED" ? "Onaylanan" : "Reddedilen"}
            </button>
          ))}
        </div>
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : filtered.length === 0 ? <EmptyState message="Henüz karar yok." /> : (
          <div className="space-y-3">
            {filtered.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div><p className="text-sm font-medium text-slate-900">{d.targetId}</p><p className="text-xs text-slate-500">{d.action} · {d.targetType}</p></div>
                <div className="flex items-center gap-2">
                  <Badge tone={APPROVAL_TONE[d.approval] ?? "gray"}>{d.approval}</Badge>
                  {d.changePct != null && <span className="text-xs text-slate-400">{d.changePct > 0 ? "+" : ""}{d.changePct}%</span>}
                  <span className="text-xs text-slate-400">{new Date(d.createdAt).toLocaleDateString("tr-TR")}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
