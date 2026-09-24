"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Card, EmptyState, SectionHeading, Badge } from "../_components/ui";

type Rule = {
  id: string;
  key: string;
  version: number;
  matcher: string;
  phrases: string[];
  risk: "LOW" | "MEDIUM" | "HIGH";
  reason: string;
  suggestion: string;
  active: boolean;
  createdAt: string;
  createdBy: string | null;
};

const RISK_TONE: Record<string, "green" | "amber" | "red"> = { LOW: "green", MEDIUM: "amber", HIGH: "red" };

export default function PolicyRulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [history, setHistory] = useState<Rule[] | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({ key: "", matcher: "PHRASES_V1", phrases: "", risk: "MEDIUM", reason: "", suggestion: "" });

  async function load() {
    setLoading(true);
    try {
      const data = await api<{ rules: Rule[] }>(`/api/policy-rules`);
      setRules(data.rules);
      setNotice("");
    } catch {
      setRules([]);
    }
    setLoading(false);
  }
  async function showHistory(key: string) {
    try {
      const data = await api<{ rules: Rule[] }>(`/api/policy-rules/${key}`);
      setHistory(data.rules);
      setHistoryKey(key);
      setNotice("");
    } catch (e) {
      setNotice((e as Error).message ?? "Geçmiş alınamadı.");
    }
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setNotice("");
    try {
      await api("/api/policy-rules", "POST", JSON.stringify({
        key: draft.key.trim(),
        matcher: draft.matcher,
        phrases: draft.phrases.split(",").map((p) => p.trim()).filter(Boolean),
        risk: draft.risk,
        reason: draft.reason.trim(),
        suggestion: draft.suggestion.trim(),
      }));
      setDraft({ key: "", matcher: "PHRASES_V1", phrases: "", risk: "MEDIUM", reason: "", suggestion: "" });
      load();
    } catch (err) {
      setNotice((err as Error).message ?? "Kural oluşturulamadı.");
    }
  }
  async function update(key: string, rule: Rule, patch: Record<string, unknown>) {
    setNotice("");
    try {
      await api(`/api/policy-rules/${key}`, "PATCH", JSON.stringify({
        expectedPreviousVersion: rule.version,
        intendedVersion: rule.version,
        ...patch,
      }));
      load();
    } catch (err) {
      setNotice((err as Error).message ?? "Güncelleme başarısız.");
    }
  }

  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">PLATFORM ADMIN</span>
        <h1>Politika Kuralları</h1>
        <p className="text-sm text-slate-500">Sürümlü, append-only global kurallar. Yalnızca Platform Admin.</p>
      </header>
      {notice && <p className="text-xs text-red-600">{notice}</p>}
      <Card>
        <SectionHeading title="Yeni Kural" description="Yalnızca aktif olmayan kurallar yeni sürümle güncellenebilir." />
        <form onSubmit={create} className="mt-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <input required placeholder="Kural anahtarı (ör. vip-claim)" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} className="rounded-lg border border-slate-300 px-4 py-2 text-sm" />
            <select value={draft.matcher} onChange={(e) => setDraft({ ...draft, matcher: e.target.value })} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
              <option value="PHRASES_V1">İfade listesi (PHRASES_V1)</option>
              <option value="GUARANTEE_V1">Garanti (GUARANTEE_V1)</option>
              <option value="BEFORE_AFTER_V1">Önce/sonra (BEFORE_AFTER_V1)</option>
              <option value="PERSONAL_ATTRIBUTE_V1">Kişisel özellik (PERSONAL_ATTRIBUTE_V1)</option>
            </select>
          </div>
          {draft.matcher === "PHRASES_V1" && (
            <input required placeholder="Virgülle ayrılmış ifadeler" value={draft.phrases} onChange={(e) => setDraft({ ...draft, phrases: e.target.value })} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm" />
          )}
          <div className="grid grid-cols-3 gap-4">
            <select value={draft.risk} onChange={(e) => setDraft({ ...draft, risk: e.target.value })} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
              <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option>
            </select>
            <input required placeholder="Gerekçe" value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} className="rounded-lg border border-slate-300 px-4 py-2 text-sm" />
            <input required placeholder="Düzeltme önerisi" value={draft.suggestion} onChange={(e) => setDraft({ ...draft, suggestion: e.target.value })} className="rounded-lg border border-slate-300 px-4 py-2 text-sm" />
          </div>
          <button className="primary-button">Kural Oluştur</button>
        </form>
      </Card>
      <Card>
        <SectionHeading title="Kurallar" description="En güncel sürümler." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : rules.length === 0 ? <EmptyState message="Kural yok veya yetkiniz yok." /> : (
          <div className="space-y-3">
            {rules.map((r) => (
              <div key={r.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-900">{r.key} <span className="ml-2 font-mono text-xs text-slate-400">v{r.version}</span></p>
                  <div className="flex items-center gap-2">
                    <Badge tone={r.active ? "green" : "gray"}>{r.active ? "AKTİF" : "KAPALI"}</Badge>
                    <Badge tone={RISK_TONE[r.risk] ?? "gray"}>{r.risk}</Badge>
                    <button onClick={() => showHistory(r.key)} className="text-xs font-medium text-violet-600 hover:underline">Geçmiş</button>
                    {r.active ? (
                      <button onClick={() => update(r.key, r, { active: false })} className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">Kapat</button>
                    ) : (
                      <button onClick={() => update(r.key, r, { active: true })} className="rounded-md border border-emerald-200 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50">Aç</button>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-500">{r.reason}</p>
                <p className="text-xs text-slate-400">{r.suggestion}</p>
                {r.matcher === "PHRASES_V1" && r.phrases.length > 0 && (
                  <p className="mt-1 text-xs text-slate-500">İfadeler: {r.phrases.join(", ")}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {history && (
        <Card>
          <SectionHeading title={`Geçmiş: ${historyKey}`} description={`${history.length} sürüm (append-only).`} />
          <div className="mt-4 space-y-2">
            {history.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border border-slate-100 p-2 text-xs">
                <span className="font-mono text-slate-500">v{r.version}</span>
                <span className="text-slate-600">{r.matcher} · {r.risk}</span>
                <Badge tone={r.active ? "green" : "gray"}>{r.active ? "AKTİF" : "KAPALI"}</Badge>
              </div>
            ))}
          </div>
          <button onClick={() => { setHistory(null); setHistoryKey(null); }} className="mt-3 text-xs text-slate-500 hover:underline">Kapat</button>
        </Card>
      )}
    </div>
  );
}