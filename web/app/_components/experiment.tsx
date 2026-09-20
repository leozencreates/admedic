"use client";

import { useState } from "react";
import {
  compare,
  validMetrics,
  wilson,
  type Metrics,
} from "../_lib/experiment";

const empty: Metrics = { spend: 0, clicks: 0, leads: 0 };
export function Experiment({
  initialDuration = 7,
}: {
  initialDuration?: number;
}) {
  const [metrics, setMetrics] = useState<Metrics[]>([
    { ...empty },
    { ...empty },
  ]);
  const [duration, setDuration] = useState(initialDuration);
  const [elapsed, setElapsed] = useState(0);
  const [source, setSource] = useState("Manuel veri girişi");
  const result = compare(metrics[0], metrics[1], elapsed, duration);
  const valid = metrics.every(validMetrics);
  return (
    <div className="space-y-7">
      <header className="studio-hero">
        <span className="eyebrow">DENEY MERKEZİ / 02</span>
        <h1>Tahmin etmeyin. Karşılaştırın.</h1>
        <p>
          A ve B reklamlarının sonuçlarını girin; dönüşüm oranını, maliyeti ve
          belirsizliği birlikte görün.
        </p>
        <div className="hero-tags">
          <span>{source}</span>
          <span>Otomatik harcama kapalı</span>
        </div>
      </header>
      <section className="studio-card">
        <div className="flex flex-wrap items-end gap-4">
          <label className="field">
            Planlanan süre (gün)
            <input
              type="number"
              min="1"
              max="90"
              value={Number.isNaN(duration) ? "" : duration}
              onChange={(e) => setDuration(e.target.valueAsNumber)}
            />
          </label>
          <label className="field">
            Geçen süre (gün)
            <input
              type="number"
              min="0"
              value={Number.isNaN(elapsed) ? "" : elapsed}
              onChange={(e) => setElapsed(e.target.valueAsNumber)}
            />
          </label>
          <button
            className="secondary-button"
            onClick={() => {
              setMetrics([
                { spend: 350, clicks: 1000, leads: 50 },
                { spend: 350, clicks: 1000, leads: 110 },
              ]);
              setElapsed(7);
              setDuration(7);
              setSource("DEMO — örnek veriler");
            }}
          >
            Örnek verilerle incele
          </button>
          <button
            className="secondary-button"
            onClick={() => {
              setMetrics([{ ...empty }, { ...empty }]);
              setElapsed(0);
              setSource("Manuel veri girişi");
            }}
          >
            Temizle
          </button>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Meta Ads Manager'dan aynı tarih aralığındaki verileri girin. Tek
          değişken, rastgele ayrılmış kitleler ve önceden belirlenmiş
          değerlendirme süresi kullanın.
        </p>
      </section>
      <div className="grid gap-5 md:grid-cols-2">
        {metrics.map((m, i) => {
          const interval = validMetrics(m) ? wilson(m.leads, m.clicks) : null;
          return (
            <section className="studio-card" key={i}>
              <div className="mb-6 flex items-center gap-3">
                <span className="variant-marker">{i ? "B" : "A"}</span>
                <h2>Varyant {i ? "B" : "A"}</h2>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(["spend", "clicks", "leads"] as const).map((key) => (
                  <label className="field" key={key}>
                    {key === "spend"
                      ? "Harcama (€)"
                      : key === "clicks"
                        ? "Tıklama"
                        : "Lead"}
                    <input
                      type="number"
                      min="0"
                      step={key === "spend" ? "0.01" : "1"}
                      value={Number.isNaN(m[key]) ? "" : m[key]}
                      onChange={(e) =>
                        setMetrics(
                          metrics.map((row, index) =>
                            index === i
                              ? { ...row, [key]: e.target.valueAsNumber }
                              : row,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="mt-6 grid grid-cols-2 gap-4 border-t border-slate-100 pt-5">
                <div>
                  <p className="section-kicker">LEAD BAŞI MALİYET</p>
                  <p className="text-2xl font-semibold">
                    {validMetrics(m) && m.leads
                      ? `€${(m.spend / m.leads).toFixed(2)}`
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="section-kicker">DÖNÜŞÜM ORANI</p>
                  <p className="text-2xl font-semibold">
                    {validMetrics(m) && m.clicks
                      ? `%${((100 * m.leads) / m.clicks).toFixed(1)}`
                      : "—"}
                  </p>
                </div>
              </div>
              <div className="mt-5 h-3 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${i ? "bg-cyan-500" : "bg-violet-500"}`}
                  style={{
                    width: `${validMetrics(m) && m.clicks ? (100 * m.leads) / m.clicks : 0}%`,
                  }}
                />
              </div>
              <p className="mt-3 text-xs text-slate-500">
                {interval && m.clicks
                  ? `%95 Wilson aralığı: %${(interval[0] * 100).toFixed(1)} – %${(interval[1] * 100).toFixed(1)}`
                  : "Aralık hesaplamak için veri girin."}
              </p>
            </section>
          );
        })}
      </div>
      <section
        className="studio-card border-l-4 border-l-violet-500"
        aria-live="polite"
      >
        <div className="section-kicker">ANALİZ SONUCU</div>
        <h2>
          {!valid
            ? "Verileri kontrol edin"
            : result.winner
              ? `Varyant ${result.winner} öne çıkıyor`
              : "Henüz karar vermeyin"}
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {result.message}
        </p>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          Bu analiz tıklama → lead oranını karşılaştırır; lead kalitesi veya
          ROAS ölçmez. Wilson aralıklarının ayrışması konservatif bir karar
          ölçütüdür. Sonuca bakarak testi sürekli uzatmak istatistiksel
          güvenilirliği bozar. Bütçe ve yayın değişikliği uygulanmaz.
        </p>
      </section>
    </div>
  );
}
