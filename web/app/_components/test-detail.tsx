"use client";
import Link from "next/link";
import { useState } from "react";
import type { DraftContent } from "@admedic/llm";
import { api, labels } from "../_lib/client-api";
import { rtlFor } from "../_lib/creative-lang";
import {
  compare,
  validMetrics,
  wilson,
  type Metrics,
} from "../_lib/experiment";
type Test = {
  id: string;
  version: number;
  status: string;
  elapsedDays: number;
  metrics: Metrics[];
  snapshot: DraftContent;
};
export function TestDetail({
  initial,
  canEdit,
}: {
  initial: Test;
  canEdit: boolean;
}) {
  const [test, setTest] = useState(initial);
  const [metrics, setMetrics] = useState(initial.metrics);
  const [elapsed, setElapsed] = useState(initial.elapsedDays);
   const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const content = test.snapshot;
  const result = compare(metrics[0], metrics[1], elapsed, content.duration);
  const locked = !canEdit || busy || test.status === "COMPLETED";
  async function save(status = test.status) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!metrics.every(validMetrics) || !Number.isInteger(elapsed))
        throw new Error("Geçerli metrikler ve gün sayısı girin.");
      await api(`/api/experiments/${test.id}`, "PATCH", {
        version: test.version,
        metrics,
        elapsedDays: elapsed,
        status,
      });
      const data = await api<{ experiment: Test }>(
        `/api/experiments/${test.id}`,
      );
      setTest(data.experiment);
      setMetrics(data.experiment.metrics);
      setElapsed(data.experiment.elapsedDays);
      setDirty(false);
      setNotice("Deney kaydedildi.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }
  async function syncMetrics() {
    setSyncing(true); setError(""); setNotice("");
    try {
       const data = await api<{ result: { status: string; completed: boolean } }>(`/api/experiments/${test.id}/sync`, "POST", { experimentId: test.id });
      setNotice(`Senkronizasyon tamamlandı: ${data.result.status}.`);
      const recs = await api<{ recommendations: any[] }>("/api/recommendations");
      setRecommendations(recs.recommendations);
    } catch (e) { setError(e instanceof Error ? e.message : "Senkronizasyon başarısız."); }
    finally { setSyncing(false); }
  }
  return (
    <div className="space-y-6">
      <Link href="/tests" className="text-sm text-violet-600">
        ← Kayıtlı deneyler
      </Link>
      <header className="studio-hero">
        <span className="eyebrow">BAŞLIK DENEYİ · {content.language}</span>
        <h1>
          {content.clinic} · {content.service}
        </h1>
        <p>
          Plan: {content.duration} gün · €{content.budget.toFixed(2)} ·{" "}
          {content.market}. Reklam içeriği deney oluşturulurken sabitlendi.
        </p>
        <p>Toplam test bütçesi: €{content.budget.toFixed(2)} · Günlük toplam: €{(content.budget / content.duration).toFixed(2)} · Varyant başına günlük: €{(content.budget / content.duration / 2).toFixed(2)}</p>
        {content.clinic.includes("DEMO") && <p role="note">DEMO · Harcama, tıklama ve lead sonuçları örnek veridir. Gerçek reklam yayını veya harcama yoktur.</p>}
        <div className="hero-tags">
          <span>{labels[test.status]}</span>
          <span>Manuel ölçüm · Meta'da yayınlanmaz</span>
          <span>
            {dirty
              ? "Kaydedilmemiş değişiklikler"
              : `Kayıt sürümü ${test.version}`}
          </span>
        </div>
      </header>
      <section className="studio-card">
        <div className="flex flex-wrap items-end gap-3">
          <label className="field">
            Geçen süre (gün)
            <input
              disabled={locked}
              type="number"
              min={test.elapsedDays}
              max="365"
              value={Number.isNaN(elapsed) ? "" : elapsed}
              onChange={(e) => {
                setElapsed(e.target.valueAsNumber);
                setDirty(true);
              }}
            />
          </label>
          {canEdit && test.status !== "COMPLETED" && (
            <>
              <button
                className="primary-button"
                disabled={locked || !dirty}
                onClick={() => save()}
              >
                Metrikleri kaydet
              </button>
              {test.status === "DRAFT" ? (
                <button
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => save("RUNNING")}
                >
                  Veri takibini başlat
                </button>
              ) : (
                <button
                  className="secondary-button"
                  disabled={locked || elapsed < content.duration}
                  onClick={() => save("COMPLETED")}
                >
                  Deneyi tamamla
                </button>
              )}
            </>
          )}
        </div>
         <p className="mt-4 text-xs text-slate-500">
           İki varyant için aynı dönemin toplam değerlerini girin; kayıt mevcut
           toplamları günceller. Tamamlanan deney kilitlenir. Takibi başlatmak
           reklam yayınlamaz.
         </p>
        </section>
        {test.status === "RUNNING" && (
          <div className="flex flex-wrap gap-3 items-center">
            <button disabled={syncing} className="primary-button" onClick={syncMetrics}>
              {syncing ? "Senkronizasyon sürüyor…" : "Meta metriklerini senkronize et"}
            </button>
            {recommendations.length > 0 && <Link href="/recommendations" className="secondary-button">Önerileri incele ({recommendations.length}) →</Link>}
          </div>
        )}
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700"
        >
          {error}
        </p>
      )}
      <p role="status" className="text-sm text-violet-700">
        {notice}
      </p>
      <div className="grid gap-5 md:grid-cols-2">
        {metrics.map((m, i) => {
          const interval = validMetrics(m) ? wilson(m.leads, m.clicks) : null;
          return (
            <section className="studio-card" key={i}>
              <div className="mb-4 flex items-center gap-3">
                <span className="variant-marker">{i ? "B" : "A"}</span>
                <h2 dir={rtlFor(content.language)}>
                  {content.variants[i].headline}
                </h2>
              </div>
              <details className="mb-5 text-sm text-slate-500">
                <summary className="cursor-pointer">
                  Sabit reklam metnini göster
                </summary>
                <p
                  className="mt-3 leading-6"
                  dir={rtlFor(content.language)}
                >
                  {content.variants[i].text}
                </p>
                <p className="mt-2" dir={rtlFor(content.language)}>
                  {content.variants[i].cta}
                </p>
              </details>
              <div className="grid grid-cols-3 gap-3">
                {(["spend", "clicks", "leads"] as const).map((key) => (
                  <label className="field" key={key}>
                    {key === "spend"
                      ? "Harcama (€)"
                      : key === "clicks"
                        ? "Tıklama"
                        : "Lead"}
                    <input
                      disabled={locked}
                      type="number"
                      min="0"
                      step={key === "spend" ? "0.01" : "1"}
                      value={Number.isNaN(m[key]) ? "" : m[key]}
                      onChange={(e) => {
                        setMetrics(
                          metrics.map((row, index) =>
                            index === i
                              ? { ...row, [key]: e.target.valueAsNumber }
                              : row,
                          ),
                        );
                        setDirty(true);
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-100 pt-5">
                <div>
                  <p className="section-kicker">LEAD BAŞI MALİYET</p>
                  <strong className="text-2xl">
                    {validMetrics(m) && m.leads
                      ? `€${(m.spend / m.leads).toFixed(2)}`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <p className="section-kicker">DÖNÜŞÜM ORANI</p>
                  <strong className="text-2xl">
                    {validMetrics(m) && m.clicks
                      ? `%${((m.leads / m.clicks) * 100).toFixed(1)}`
                      : "—"}
                  </strong>
                </div>
              </div>
              <div className="mt-5 h-3 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${i ? "bg-cyan-500" : "bg-violet-500"}`}
                  style={{
                    width: `${validMetrics(m) && m.clicks ? (m.leads / m.clicks) * 100 : 0}%`,
                  }}
                />
              </div>
              <p className="mt-3 text-xs text-slate-500">
                {interval && m.clicks
                  ? `%95 Wilson: %${(interval[0] * 100).toFixed(1)} – %${(interval[1] * 100).toFixed(1)}`
                  : "Analiz için veri bekleniyor."}
              </p>
            </section>
          );
        })}
       </div>
       {recommendations.length > 0 && (
         <section className="studio-card border-l-4 border-l-amber-500">
           <div className="section-kicker">OPTİMİZASYON ÖNERİLERİ</div>
           <h2>Veriye dayalı öneriler</h2>
           <div className="mt-4 space-y-4">
             {recommendations.map((rec) => (
               <div key={rec.id} className="rounded-xl bg-amber-50 p-4">
                 <p className="font-semibold">{rec.title}</p>
                 <p className="mt-1 text-sm text-slate-600">{rec.description}</p>
                 <p className="mt-2 text-xs text-slate-500">{rec.reasoning}</p>
                 {rec.status === "DRAFT" && (
                   <p className="mt-2 text-xs text-amber-700">Onay bekliyor. Onaylandıktan sonra uygulanabilir.</p>
                 )}
               </div>
             ))}
           </div>
         </section>
       )}
       <section
         className="studio-card border-l-4 border-l-violet-500"
         aria-live="polite"
       >
        <div className="section-kicker">
          {dirty ? "KAYDEDİLMEMİŞ VERİLERLE ÖNİZLEME" : "ANALİZ SONUCU"}
        </div>
        <h2>
          {result.winner
            ? `${result.winner} varyantı öne çıkıyor`
            : "Henüz belirgin kazanan yok"}
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {result.message}
        </p>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          Bu analiz yalnızca tıklama → lead dönüşümünü karşılaştırır. Ayrık,
          rastgele kitleler ve önceden belirlenmiş değerlendirme süresi
          varsayılır. Lead kalitesi ve ROAS ölçülmez; otomatik bütçe değişikliği
          uygulanmaz.
        </p>
      </section>
    </div>
  );
}
