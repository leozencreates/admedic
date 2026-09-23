"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const RISK_TONE: Record<string, Tone> = { LOW: "green", MEDIUM: "amber", HIGH: "red" };
const RULE_TONE: Record<string, Tone> = { ACTIVE: "green", INACTIVE: "gray" };
interface PolicyData { id: string; name: string; version: string; active: boolean; riskScore: string; ruleType: string; description: string; createdAt: string; }
export default function PoliciesPage() {
  const [policies, setPolicies] = useState<PolicyData[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try { const data = await api<{ policies: PolicyData[] }>("/api/policies"); setPolicies(data.policies); } catch { setPolicies([]); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">POLİTİKALAR</span>
        <h1>Politika Motoru</h1>
        <p className="text-sm text-slate-500">Kural tabanlı ve LLM tabanlı politika kontrolü.</p>
      </header>
      <Card>
        <SectionHeading title="Kural Tabanlı Kontrol" description="Deterministik kurallar: kişisel özellik, garanti vaadi, önce/sonra, yasaklı ifadeler." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : policies.length === 0 ? <EmptyState message="Henüz politika kuralı yok." /> : (
          <div className="space-y-3">
            {policies.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div><p className="text-sm font-medium text-slate-900">{p.name}</p><p className="text-xs text-slate-500">{p.description}</p></div>
                <div className="flex items-center gap-2">
                  <Badge tone={RULE_TONE[p.active ? "ACTIVE" : "INACTIVE"] ?? "gray"}>{p.active ? "ACTIVE" : "INACTIVE"}</Badge>
                  <Badge tone={RISK_TONE[p.riskScore] ?? "gray"}>{p.riskScore}</Badge>
                  <span className="text-xs text-slate-400">v{p.version}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
