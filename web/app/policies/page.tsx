"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { formatMoney } from "../_lib/format";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const RISK_TONE: Record<string, Tone> = { LOW: "green", MEDIUM: "amber", HIGH: "red" };
const MATCHER_LABEL: Record<string, string> = {
  PHRASES_V1: "İfade listesi",
  GUARANTEE_V1: "Garanti / kesin sonuç",
  BEFORE_AFTER_V1: "Önce/sonra",
  PERSONAL_ATTRIBUTE_V1: "Kişisel özellik",
};
const OBJECTIVE_LABEL: Record<string, string> = {
  MAX_ROAS: "Maksimum ROAS",
  MAX_REVENUE: "Maksimum gelir",
  MAX_PROFIT: "Maksimum kâr",
  MIN_CPA: "Minimum CPA",
  MAX_PURCHASES_BUDGET: "Bütçe içinde maksimum satın alma",
  TARGET_ROAS: "Hedef ROAS",
  TARGET_CPA: "Hedef CPA",
};
const MODE_LABEL: Record<string, string> = {
  OBSERVE: "Gözlem",
  APPROVAL: "Onaylı",
  AUTOPILOT: "Otopilot",
  SHADOW: "Gölge",
};
interface PolicyRule {
  id: string; key: string; version: number; matcher: string; phrases: string[];
  risk: string; reason: string; suggestion: string; active: boolean;
}
interface OptimizationPolicy {
  enabled: boolean; objective: string; mode: string;
  minDailyBudgetCents: number; maxDailyBudgetCents: number | null;
  campaignDailyMaxCents: number | null; accountDailyMaxCents: number | null; accountMonthlyMaxCents: number | null;
  maxIncreasePct: number; maxDecreasePct: number; maxChangePer24hPct: number; minHoursBetweenChanges: number;
  targetRoas: number; maxCpaCents: number | null; updatedAt: string;
}
interface OptimizationRule { id: string; name: string; version: string; active: boolean; description: string | null; workspaceId: string | null }

export default function PoliciesPage() {
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [policy, setPolicy] = useState<OptimizationPolicy | null>(null);
  const [optRules, setOptRules] = useState<OptimizationRule[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      const data = await api<{ rules: PolicyRule[]; canEdit: boolean }>("/api/policy-rules");
      setRules(data.rules);
      setCanEdit(Boolean(data.canEdit));
    } catch { setRules([]); }
    try {
      const data = await api<{ optimizationPolicy: OptimizationPolicy | null; optimizationRules: OptimizationRule[] }>("/api/policies");
      setPolicy(data.optimizationPolicy);
      setOptRules(data.optimizationRules ?? []);
    } catch { setPolicy(null); setOptRules([]); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">POLİTİKALAR</span>
        <h1>Politika Motoru</h1>
        <p className="text-sm text-slate-500">Kural tabanlı içerik kontrolü (katman 1) ve LLM risk skoru (katman 2); optimizasyon guardrail'leri ayrı listelenir.</p>
      </header>
      <Card>
        <SectionHeading
          title="Politika Kuralları (salt okunur)"
          description="Deterministik, sürümlü global kurallar: garanti vaadi, önce/sonra, kişisel özellik, ifade listeleri. Klinik yasaklı ifadeleri klinik profilinden gelir."
          action={<Link href="/policy-rules" className="text-xs font-medium text-violet-600 hover:underline">{canEdit ? "Kuralları yönet →" : "Sürüm geçmişi →"}</Link>}
        />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : rules.length === 0 ? <EmptyState message="Henüz politika kuralı yok." /> : (
          <div className="space-y-3">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">{r.key} <span className="ml-1 text-xs font-normal text-slate-500">{MATCHER_LABEL[r.matcher] ?? r.matcher}</span></p>
                  <p className="text-xs text-slate-500">{r.reason}</p>
                  {r.matcher === "PHRASES_V1" && r.phrases.length > 0 && <p className="text-xs text-slate-400">İfadeler: {r.phrases.join(", ")}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={r.active ? "green" : "gray"}>{r.active ? "AKTİF" : "KAPALI"}</Badge>
                  <Badge tone={RISK_TONE[r.risk] ?? "gray"}>{r.risk}</Badge>
                  <span className="text-xs text-slate-400">v{r.version}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <SectionHeading title="Optimizasyon Politikası" description="Bütçe guardrail'leri ve ajan modu (içerik politikası değildir; ROAS Autopilot için)." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : !policy ? <EmptyState message="Bu çalışma alanı için optimizasyon politikası tanımlı değil." /> : (
          <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
            <p>Durum: <Badge tone={policy.enabled ? "green" : "gray"}>{policy.enabled ? "ETKİN" : "KAPALI"}</Badge></p>
            <p>Mod: <Badge tone="blue">{MODE_LABEL[policy.mode] ?? policy.mode}</Badge></p>
            <p>Hedef: {OBJECTIVE_LABEL[policy.objective] ?? policy.objective} · hedef ROAS {policy.targetRoas}</p>
            <p>Günlük bütçe aralığı: {formatMoney(policy.minDailyBudgetCents)} – {policy.maxDailyBudgetCents !== null ? formatMoney(policy.maxDailyBudgetCents) : "sınırsız"}</p>
            <p>Kampanya günlük üst sınır: {policy.campaignDailyMaxCents !== null ? formatMoney(policy.campaignDailyMaxCents) : "-"}</p>
            <p>Hesap günlük / aylık üst sınır: {policy.accountDailyMaxCents !== null ? formatMoney(policy.accountDailyMaxCents) : "-"} / {policy.accountMonthlyMaxCents !== null ? formatMoney(policy.accountMonthlyMaxCents) : "-"}</p>
            <p>Tek adım değişim: +%{policy.maxIncreasePct} / −%{policy.maxDecreasePct}; 24 saatte en fazla %{policy.maxChangePer24hPct}</p>
            <p>Değişiklikler arası en az {policy.minHoursBetweenChanges} saat · maks CPA {policy.maxCpaCents !== null ? formatMoney(policy.maxCpaCents) : "-"}</p>
          </div>
        )}
        {optRules.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Optimizasyon kuralları</p>
            {optRules.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-2.5">
                <div><p className="text-sm text-slate-900">{r.name}</p>{r.description && <p className="text-xs text-slate-500">{r.description}</p>}</div>
                <div className="flex items-center gap-2">
                  <Badge tone={r.active ? "green" : "gray"}>{r.active ? "AKTİF" : "KAPALI"}</Badge>
                  <span className="text-xs text-slate-400">{r.version}{r.workspaceId ? "" : " · global"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
