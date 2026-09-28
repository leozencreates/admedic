"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { formatDate } from "../_lib/format";
import { POLICY_MATCHERS, policyMatcherLabel, policyRiskStyle, ruleActiveStyle } from "../_lib/labels";
import { Card, EmptyState, SectionHeading, Badge, PageHeader } from "../_components/ui";

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

/** Risk düzeyi seçenekleri; ekranda "Düşük/Orta/Yüksek risk", sunucuya kod gider. */
const RISKS = ["LOW", "MEDIUM", "HIGH"] as const;

type EditForm = { risk: string; reason: string; suggestion: string; phrases: string };

export default function PolicyRulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [history, setHistory] = useState<Rule[] | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Yükleme hatası boş liste gibi gösterilmez (İÇ-3).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [draft, setDraft] = useState({ key: "", matcher: "PHRASES_V1", phrases: "", risk: "MEDIUM", reason: "", suggestion: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ risk: "MEDIUM", reason: "", suggestion: "", phrases: "" });

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<{ rules: Rule[]; canEdit: boolean }>(`/api/policy-rules`);
      setRules(data.rules);
      setCanEdit(Boolean(data.canEdit));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "");
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
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Sürüm geçmişi yüklenemedi. Tekrar deneyin." });
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
      setNotice({ kind: "err", text: err instanceof Error ? err.message : "Kural oluşturulamadı. Tekrar deneyin." });
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
      setNotice({ kind: "ok", text: `“${rule.key}” kuralının yeni sürümü kaydedildi.` });
      setEditing(null);
      load();
      if (historyKey === rule.key) showHistory(rule.key);
    } catch (err) {
      setNotice({ kind: "err", text: err instanceof Error ? err.message : "Kural güncellenemedi. Tekrar deneyin." });
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

  const riskOptions = RISKS.map((r) => (
    <option key={r} value={r}>{policyRiskStyle(r).label}</option>
  ));

  return (
    <div className="space-y-8">
      <PageHeader
        title="İçerik kuralları"
        description={
          canEdit
            ? "Tüm çalışma alanlarında geçerli içerik kurallarını düzenleyin; her değişiklik yeni bir sürüm olarak kaydedilir."
            : "Tüm çalışma alanlarında geçerli içerik kuralları; yalnızca platform yöneticisi düzenleyebilir."
        }
        crumbs={[{ label: "Ayarlar" }]}
      />
      {notice && (
        <div
          role={notice.kind === "ok" ? "status" : "alert"}
          className={`rounded-xl border p-3 text-sm ${notice.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}
        >
          {notice.text}
        </div>
      )}
      {canEdit && (
        <Card>
          <SectionHeading
            title="Yeni kural"
            description="Aynı anahtarla etkin bir kural varken yeni kural açılamaz; önce o kuralı devre dışı bırakın ya da mevcut sürümü düzenleyin."
          />
          <form onSubmit={create} className="mt-6 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field">
                Kural anahtarı
                <input required placeholder="Örn. vip-claim" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
              </label>
              <label className="field">
                Kural türü
                <select value={draft.matcher} onChange={(e) => setDraft({ ...draft, matcher: e.target.value })}>
                  {POLICY_MATCHERS.map((m) => (
                    <option key={m} value={m}>{policyMatcherLabel(m)}</option>
                  ))}
                </select>
              </label>
            </div>
            {draft.matcher === "PHRASES_V1" && (
              <label className="field">
                İfadeler (virgülle ayırın, en az bir)
                <input required value={draft.phrases} onChange={(e) => setDraft({ ...draft, phrases: e.target.value })} />
              </label>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="field">
                Risk düzeyi
                <select value={draft.risk} onChange={(e) => setDraft({ ...draft, risk: e.target.value })}>
                  {riskOptions}
                </select>
              </label>
              <label className="field">
                Gerekçe
                <input required value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
              </label>
              <label className="field">
                Düzeltme önerisi
                <input required value={draft.suggestion} onChange={(e) => setDraft({ ...draft, suggestion: e.target.value })} />
              </label>
            </div>
            <button type="submit" className="primary-button">Kural oluştur</button>
          </form>
        </Card>
      )}
      <Card>
        <SectionHeading
          title="Kurallar"
          description="Her kuralın en güncel sürümü. Devre dışı bırakılan son sürüm de geçerlidir; eski bir sürüm kendiliğinden yeniden etkinleşmez."
        />
        {loading ? (
          <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
        ) : loadError !== null ? (
          <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <p className="font-medium">Kurallar yüklenemedi.</p>
            {loadError && <p className="mt-1">{loadError}</p>}
            <button type="button" className="secondary-button mt-3" onClick={() => void load()}>
              Tekrar dene
            </button>
          </div>
        ) : rules.length === 0 ? (
          <EmptyState
            message={
              canEdit
                ? "Henüz içerik kuralı yok. Yukarıdaki formdan ilk kuralı oluşturun; reklam metinleri yayından önce bu kurallarla kontrol edilir."
                : "Henüz içerik kuralı yok. Platform yöneticisi kural eklediğinde burada listelenir."
            }
          />
        ) : (
          <div className="space-y-3">
            {rules.map((r) => {
              const active = ruleActiveStyle(r.active);
              const risk = policyRiskStyle(r.risk);
              return (
                <div key={r.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-slate-900">
                      {r.key} <span className="ml-2 text-xs font-normal text-muted">v{r.version}</span>
                      <span className="ml-2 text-xs font-normal text-muted">{policyMatcherLabel(r.matcher)}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={active.tone}>{active.label}</Badge>
                      <Badge tone={risk.tone}>{risk.label}</Badge>
                      <button type="button" onClick={() => showHistory(r.key)} className="px-1 py-1 text-xs font-medium text-violet-700 hover:underline">
                        Sürüm geçmişi
                      </button>
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            onClick={() => (editing === r.key ? setEditing(null) : startEdit(r))}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            aria-expanded={editing === r.key}
                          >
                            {editing === r.key ? "Vazgeç" : "Düzenle"}
                          </button>
                          {r.active ? (
                            <button type="button" onClick={() => update(r, { active: false })} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                              Devre dışı bırak
                            </button>
                          ) : (
                            <button type="button" onClick={() => update(r, { active: true })} className="rounded-md border border-emerald-300 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50">
                              Etkinleştir
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-slate-700">{r.reason}</p>
                  <p className="text-xs text-muted">Öneri: {r.suggestion}</p>
                  {r.matcher === "PHRASES_V1" && r.phrases.length > 0 && (
                    <p className="mt-1 text-xs text-muted">İfadeler: {r.phrases.join(", ")}</p>
                  )}
                  {canEdit && editing === r.key && (
                    <form onSubmit={(e) => saveEdit(r, e)} className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3">
                      <label className="field">
                        Risk düzeyi
                        <select value={editForm.risk} onChange={(e) => setEditForm({ ...editForm, risk: e.target.value })}>
                          {riskOptions}
                        </select>
                      </label>
                      <label className="field">
                        Gerekçe
                        <input required value={editForm.reason} onChange={(e) => setEditForm({ ...editForm, reason: e.target.value })} />
                      </label>
                      <label className="field">
                        Düzeltme önerisi
                        <input required value={editForm.suggestion} onChange={(e) => setEditForm({ ...editForm, suggestion: e.target.value })} />
                      </label>
                      {r.matcher === "PHRASES_V1" && (
                        <label className="field sm:col-span-3">
                          İfadeler (virgülle ayırın, en az bir)
                          <input required value={editForm.phrases} onChange={(e) => setEditForm({ ...editForm, phrases: e.target.value })} />
                        </label>
                      )}
                      <div className="sm:col-span-3">
                        <button type="submit" className="primary-button">Yeni sürüm olarak kaydet (v{r.version + 1})</button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {history && (
        <Card>
          <SectionHeading title={`Sürüm geçmişi: ${historyKey}`} description={`${history.length} sürüm. Eski sürümler silinmez.`} />
          <div className="mt-4 space-y-2">
            {history.map((r) => {
              const active = ruleActiveStyle(r.active);
              return (
                <div key={r.id} className="rounded-md border border-slate-200 p-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-700">v{r.version}</span>
                    <span className="text-slate-700">{policyMatcherLabel(r.matcher)} · {policyRiskStyle(r.risk).label}</span>
                    <span className="text-muted">{formatDate(r.createdAt)}</span>
                    <Badge tone={active.tone}>{active.label}</Badge>
                  </div>
                  <p className="mt-1 text-muted">{r.reason}</p>
                  {r.matcher === "PHRASES_V1" && r.phrases.length > 0 && <p className="text-muted">İfadeler: {r.phrases.join(", ")}</p>}
                </div>
              );
            })}
          </div>
          <button type="button" onClick={() => { setHistory(null); setHistoryKey(null); }} className="secondary-button mt-3">
            Geçmişi kapat
          </button>
        </Card>
      )}
    </div>
  );
}
