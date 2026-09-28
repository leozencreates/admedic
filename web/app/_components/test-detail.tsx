"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { DraftContent } from "@admedic/llm";
import { api, defaultAccountCurrency } from "../_lib/client-api";
import { rtlFor } from "../_lib/creative-lang";
import { formatMoneyUnits, formatRatio } from "../_lib/format";
import { ctaDisplay, experimentStatusStyle, languageName } from "../_lib/labels";
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
  const [currency, setCurrency] = useState("EUR");
  const content = test.snapshot;
  const lang = content.language.toLowerCase();
  const result = compare(metrics[0], metrics[1], elapsed, content.duration);
  const locked = !canEdit || busy || test.status === "COMPLETED";
  useEffect(() => {
    void defaultAccountCurrency().then(setCurrency);
  }, []);
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
      setError(e instanceof Error ? e.message : "Deney kaydedilemedi. Tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  }
  const dailyTotal = content.budget / content.duration;
  return (
    <div className="space-y-6">
      <Link href="/tests" className="text-sm text-violet-700">
        ← Kayıtlı deneyler
      </Link>
      <header className="studio-hero">
        <span className="eyebrow">BAŞLIK DENEYİ · {languageName(content.language).toLocaleUpperCase("tr")}</span>
        <h1>
          {content.clinic} · {content.service}
        </h1>
        <p>
          Plan: {content.duration} gün · {formatMoneyUnits(content.budget, currency)} ·{" "}
          {content.market}. Reklam içeriği deney oluşturulurken sabitlendi.
        </p>
        <p>
          Toplam test bütçesi: {formatMoneyUnits(content.budget, currency)} · Günlük toplam:{" "}
          {formatMoneyUnits(dailyTotal, currency, { precise: true })} · Varyant başına günlük:{" "}
          {formatMoneyUnits(dailyTotal / 2, currency, { precise: true })}
        </p>
        {content.clinic.includes("DEMO") && <p role="note">DEMO · Harcama, tıklama ve lead sonuçları örnek veridir. Gerçek reklam yayını veya harcama yoktur.</p>}
        <div className="hero-tags">
          <span>{experimentStatusStyle(test.status).label}</span>
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
        <p className="mt-4 text-xs text-muted">
          İki varyant için aynı dönemin toplam değerlerini girin; kayıt mevcut
          toplamları günceller. Tamamlanan deney kilitlenir. Takibi başlatmak
          reklam yayınlamaz.
        </p>
      </section>
      {/* Studio deneyleri elle girilen ölçümle çalışır; Meta'dan otomatik çekme yok (sync ucu 409 döner). */}
      {test.status === "RUNNING" && (
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/recommendations" className="secondary-button">Önerileri incele →</Link>
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
                <h2 dir={rtlFor(content.language)} lang={lang}>
                  {content.variants[i].headline}
                </h2>
              </div>
              <details className="mb-5 text-sm text-muted">
                <summary className="cursor-pointer">
                  Sabit reklam metnini göster
                </summary>
                <p
                  className="mt-3 leading-6"
                  dir={rtlFor(content.language)}
                  lang={lang}
                >
                  {content.variants[i].text}
                </p>
                <p className="mt-2">
                  Eylem düğmesi: {ctaDisplay(content.variants[i].cta)}
                </p>
              </details>
              <div className="grid grid-cols-3 gap-3">
                {(["spend", "clicks", "leads"] as const).map((key) => (
                  <label className="field" key={key}>
                    {key === "spend"
                      ? `Harcama (${currency})`
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
                  <p className="section-kicker">Lead başı maliyet (CPL)</p>
                  <strong className="text-2xl">
                    {validMetrics(m) && m.leads
                      ? formatMoneyUnits(m.spend / m.leads, currency, { precise: true })
                      : "—"}
                  </strong>
                </div>
                <div>
                  <p className="section-kicker">Dönüşüm oranı</p>
                  <strong className="text-2xl">
                    {validMetrics(m) && m.clicks
                      ? formatRatio(m.leads / m.clicks)
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
              <p className="mt-3 text-xs text-muted">
                {interval && m.clicks
                  ? `%95 Wilson aralığı: ${formatRatio(interval[0])} – ${formatRatio(interval[1])}`
                  : "Analiz için veri bekleniyor."}
              </p>
            </section>
          );
        })}
      </div>
      <section
        className="studio-card border-l-4 border-l-violet-500"
        aria-live="polite"
      >
        <div className="section-kicker">
          {dirty ? "Kaydedilmemiş verilerle önizleme" : "Analiz sonucu"}
        </div>
        <h2>
          {result.winner
            ? `${result.winner} varyantı öne çıkıyor`
            : "Henüz belirgin kazanan yok"}
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-700">
          {result.message}
        </p>
        <p className="mt-4 text-xs leading-5 text-muted">
          Bu analiz yalnızca tıklama → lead dönüşümünü karşılaştırır. Ayrık,
          rastgele kitleler ve önceden belirlenmiş değerlendirme süresi
          varsayılır. Lead kalitesi ve ROAS ölçülmez; otomatik bütçe değişikliği
          uygulanmaz.
        </p>
      </section>
    </div>
  );
}
