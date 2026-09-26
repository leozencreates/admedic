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
const MATCHER_LABEL: Record<string, string> = {
  PHRASES_V1: "İfade listesi",
  GUARANTEE_V1: "Garanti / kesin sonuç",
  BEFORE_AFTER_V1: "Önce/sonra",
  PERSONAL_ATTRIBUTE_V1: "Kişisel özellik",
};

type EditForm = { risk: string; reason: string; suggestion: string; phrases: string };

export default function PolicyRulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [history, setHistory] = useState<Rule[] | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [draft, setDraft] = useState({ key: "", matcher: "PHRASES_V1", phrases: "", risk: "MEDIUM", reason: "", suggestion: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ risk: "MEDIUM", reason: "", suggestion: "", phrases: "" });

  async function load() {
    setLoading(true);
    try {
      const data = await api<{ rules: Rule[]; canEdit: boolean }>(`/api/policy-rules`);
      setRules(data.rules);
      setCanEdit(Boolean(data.canEdit));
    } catch (e) {
      setRules([]);
      setNotice({ kind: "err", text: (e as Error).message ?? "Kurallar alınamadı." });
    }
    setLoading(false);
  }
  async function showHistory(key: string) {
    try {
      const data = await api<{ rules: Rule[] }>(`/api/policy-rules/${key}`);
      setHistory(data.rules);
      setHistoryKey(key);
      setNotice(null);
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message ?? "Geçmiş alınamadı." });
    }
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      // Düz nesne gönderilir; `api()` JSON'a çevirir (çift kodlama yok).
      await api("/api/policy-rules", "POST", {
        key: draft.key.trim(),
        matcher: draft.matcher,
        phrases: draft.phrases.split(",").map((p) => p.trim()).filter(Boolean),
        risk: draft.risk,
        reason: draft.reason.trim(),
        suggestion: draft.suggestion.trim(),
      });
      setDraft({ key: "", matcher: "PHRASES_V1", phrases: "", risk: "MEDIUM", reason: "", suggestion: "" });
      setNotice({ kind: "ok", text: "Kural oluşturuldu." });
      load();
    } catch (err) {
      setNotice({ kind: "err", text: (err as Error).message ?? "Kural oluşturulamadı." });
    }
  }
  async function update(rule: Rule, patch: Record<string, unknown>) {
    setNotice(null);
    try {
      await api(`/api/policy-rules/${rule.key}`, "PATCH", {
        expectedPreviousVersion: rule.version,
        intendedVersion: rule.version,
        ...patch,
      });
      setNotice({ kind: "ok", text: `${rule.key} için yeni sürüm oluşturuldu.` });
      setEditing(null);
      load();
      if (historyKey === rule.key) showHistory(rule.key);
    } catch (err) {
      setNotice({ kind: "err", text: (err as Error).message ?? "Güncelleme başarısız." });
    }
  }
  function startEdit(rule: Rule) {
    setEditing(rule.key);
    setEditForm({ risk: rule.risk, reason: rule.reason, suggestion: rule.suggestion, phrases: rule.phrases.join(", ") });
  }
  async function saveEdit(rule: Rule, e: React.FormEvent) {
    e.preventDefault();
    const patch: Record<string, unknown> = {
      risk: editForm.risk,
      reason: editForm.reason.trim(),
      suggestion: editForm.suggestion.trim(),
    };
    if (rule.matcher === "PHRASES_V1")
      patch.phrases = editForm.phrases.split(",").map((p) => p.trim()).filter(Boolean);
    await update(rule, patch);
  }

  const inputCls = "rounded-lg border border-slate-300 px-4 py-2 text-sm";

  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">{canEdit ? "PLATFORM ADMIN" : "POLİTİKA KURALLARI"}</span>
        <h1>Politika Kuralları</h1>
        <p className="text-sm text-slate-500">
          Sürümlü, append-only global kurallar; tüm tenant'ları bağlar.
          {canEdit ? " Düzenleme yetkiniz var (Platform Admin)." : " Salt okunur: düzenleme yalnızca Platform Admin tarafından yapılır."}
        </p>
      </header>
      {notice && (
        <p role="alert" className={`text-xs ${notice.kind === "ok" ? "text-emerald-700" : "text-red-600"}`}>{notice.text}</p>
      )}
      {canEdit && (
        <Card>
          <SectionHeading title="Yeni Kural" description="Aynı anahtar aktifken yeni kural açılamaz; önce kapatın ya da mevcut sürümü düzenleyin." />
          <form onSubmit={create} className="mt-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <input required placeholder="Kural anahtarı (ör. vip-claim)" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} className={inputCls} />
              <select value={draft.matcher} onChange={(e) => setDraft({ ...draft, matcher: e.target.value })} className={inputCls}>
                <option value="PHRASES_V1">İfade listesi (PHRASES_V1)</option>
                <option value="GUARANTEE_V1">Garanti (GUARANTEE_V1)</option>
                <option value="BEFORE_AFTER_V1">Önce/sonra (BEFORE_AFTER_V1)</option>
                <option value="PERSONAL_ATTRIBUTE_V1">Kişisel özellik (PERSONAL_ATTRIBUTE_V1)</option>
              </select>
            </div>
            {draft.matcher === "PHRASES_V1" && (
              <input required placeholder="Virgülle ayrılmış ifadeler (en az bir)" value={draft.phrases} onChange={(e) => setDraft({ ...draft, phrases: e.target.value })} className={`w-full ${inputCls}`} />
            )}
            <div className="grid grid-cols-3 gap-4">
              <select value={draft.risk} onChange={(e) => setDraft({ ...draft, risk: e.target.value })} className={inputCls}>
                <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option>
              </select>
              <input required placeholder="Gerekçe" value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} className={inputCls} />
              <input required placeholder="Düzeltme önerisi" value={draft.suggestion} onChange={(e) => setDraft({ ...draft, suggestion: e.target.value })} className={inputCls} />
            </div>
            <button className="primary-button">Kural Oluştur</button>
          </form>
        </Card>
      )}
      <Card>
        <SectionHeading title="Kurallar" description="Anahtar başına en güncel sürüm (pasif sürüm de geçerlidir; eski aktif sürüm dirilmez)." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : rules.length === 0 ? <EmptyState message="Kural bulunamadı." /> : (
          <div className="space-y-3">
            {rules.map((r) => (
              <div key={r.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-900">
                    {r.key} <span className="ml-2 font-mono text-xs text-slate-400">v{r.version}</span>
                    <span className="ml-2 text-xs text-slate-500">{MATCHER_LABEL[r.matcher] ?? r.matcher}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <Badge tone={r.active ? "green" : "gray"}>{r.active ? "AKTİF" : "KAPALI"}</Badge>
                    <Badge tone={RISK_TONE[r.risk] ?? "gray"}>{r.risk}</Badge>
                    <button onClick={() => showHistory(r.key)} className="text-xs font-medium text-violet-600 hover:underline">Geçmiş</button>
                    {canEdit && (
                      <>
                        <button onClick={() => (editing === r.key ? setEditing(null) : startEdit(r))} className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                          {editing === r.key ? "Vazgeç" : "Düzenle"}
                        </button>
                        {r.active ? (
                          <button onClick={() => update(r, { active: false })} className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">Kapat</button>
                        ) : (
                          <button onClick={() => update(r, { active: true })} className="rounded-md border border-emerald-200 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50">Aç</button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-500">{r.reason}</p>
                <p className="text-xs text-slate-400">{r.suggestion}</p>
                {r.matcher === "PHRASES_V1" && r.phrases.length > 0 && (
                  <p className="mt-1 text-xs text-slate-500">İfadeler: {r.phrases.join(", ")}</p>
                )}
                {canEdit && editing === r.key && (
                  <form onSubmit={(e) => saveEdit(r, e)} className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3">
                    <select value={editForm.risk} onChange={(e) => setEditForm({ ...editForm, risk: e.target.value })} className={inputCls}>
                      <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option>
                    </select>
                    <input required value={editForm.reason} onChange={(e) => setEditForm({ ...editForm, reason: e.target.value })} className={inputCls} placeholder="Gerekçe" />
                    <input required value={editForm.suggestion} onChange={(e) => setEditForm({ ...editForm, suggestion: e.target.value })} className={inputCls} placeholder="Düzeltme önerisi" />
                    {r.matcher === "PHRASES_V1" && (
                      <input required value={editForm.phrases} onChange={(e) => setEditForm({ ...editForm, phrases: e.target.value })} className={`sm:col-span-3 ${inputCls}`} placeholder="Virgülle ayrılmış ifadeler (en az bir)" />
                    )}
                    <div className="sm:col-span-3">
                      <button type="submit" className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500">Yeni Sürüm Olarak Kaydet (v{r.version + 1})</button>
                    </div>
                  </form>
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
              <div key={r.id} className="rounded-md border border-slate-100 p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-slate-500">v{r.version}</span>
                  <span className="text-slate-600">{MATCHER_LABEL[r.matcher] ?? r.matcher} · {r.risk}</span>
                  <span className="text-slate-400">{new Date(r.createdAt).toLocaleString("tr-TR")}</span>
                  <Badge tone={r.active ? "green" : "gray"}>{r.active ? "AKTİF" : "KAPALI"}</Badge>
                </div>
                <p className="mt-1 text-slate-500">{r.reason}</p>
                {r.matcher === "PHRASES_V1" && r.phrases.length > 0 && <p className="text-slate-400">İfadeler: {r.phrases.join(", ")}</p>}
              </div>
            ))}
          </div>
          <button onClick={() => { setHistory(null); setHistoryKey(null); }} className="mt-3 text-xs text-slate-500 hover:underline">Kapat</button>
        </Card>
      )}
    </div>
  );
}
