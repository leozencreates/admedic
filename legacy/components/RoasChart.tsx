"use client";

import { useMemo } from "react";

interface Series {
  name: string;
  color?: string;
  points: { date: string; value: number }[];
}

const COLORS = ["#0d9488", "#7c3aed", "#0284c7", "#ea580c"];

export function RoasChart({ series }: { series: Series[] }) {
  const data = useMemo(() => {
    const values = series.flatMap((s) => s.points.map((p) => p.value)).filter(Number.isFinite);
    if (values.length === 0) return null;
    const max = Math.max(...values, 0.0001);
    const allDates = Array.from(
      new Set(series.flatMap((s) => s.points.map((p) => p.date)))
    ).sort();

    const W = 720;
    const H = 220;
    const PX = 40;
    const PY = 16;

    const xIndex = (d: string) => allDates.indexOf(d);
    const x = (i: number) => PX + (i / Math.max(allDates.length - 1, 1)) * (W - PX * 2);
    const y = (v: number) => H - PY - (v / max) * (H - PY * 2);

    const paths = series.map((s, si) => {
      const pts = s.points
        .map((p) => ({ px: x(xIndex(p.date)), py: y(p.value) }));
      if (pts.length === 0) return null;
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");
      return { name: s.name, color: s.color ?? COLORS[si % COLORS.length], d, pts };
    });

    return { W, H, PX, PY, max, allDates, x, paths };
  }, [series]);

  if (!data) {
    return (
      <div className="flex h-[160px] items-center justify-center text-sm text-zinc-400">
        Grafik için yeterli veri yok
      </div>
    );
  }

  return (
    <div>
      <svg viewBox={`0 0 ${data.W} ${data.H}`} className="w-full">
        {[0.25, 0.5, 0.75].map((r) => (
          <line
            key={r}
            x1={data.PX}
            x2={data.W - data.PX}
            y1={data.H - data.PY - r * (data.H - data.PY * 2)}
            y2={data.H - data.PY - r * (data.H - data.PY * 2)}
            stroke="#e4e4e7"
            strokeDasharray="4 4"
          />
        ))}
        {data.paths.map((p) =>
          p ? (
            <g key={p.name}>
              <path d={p.d} fill="none" stroke={p.color} strokeWidth={2.5} strokeLinejoin="round" />
              {p.pts.map((pt, i) => (
                <circle key={i} cx={pt.px} cy={pt.py} r={3} fill={p.color} />
              ))}
            </g>
          ) : null
        )}
      </svg>
      <div className="mt-2 flex flex-wrap gap-3">
        {data.paths.map((p) =>
          p ? (
            <span key={p.name} className="flex items-center gap-1.5 text-xs text-zinc-600">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
              {p.name}
            </span>
          ) : null
        )}
      </div>
    </div>
  );
}