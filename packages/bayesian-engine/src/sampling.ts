import { mulberry32, seedFromString } from "@admedic/shared";

export type Rng = () => number;

/** Uyumlu deterministik RNG üretir (test için sabit tohum). */
export function makeRng(seed?: number): Rng {
  const s = Number.isFinite(seed) ? (seed as number) : seedFromString(String(Date.now()));
  return mulberry32(s);
}

function stdNormal(rng: Rng): number {
  // Box-Muller — iki uniform okuyup standart normal üretir
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Gamma(shape, rate) örneklemesi (Marsaglia-Tsang).
 * shape < 1 için yükleme yöntemi (boost) kullanılır.
 */
export function gammaSample(shape: number, rate: number, rng: Rng): number {
  if (shape <= 0 || rate <= 0) return 0;
  if (shape < 1) {
    return gammaSample(shape + 1, rate, rng) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = stdNormal(rng);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * Math.pow(x, 4)) return (d * v) / rate;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return (d * v) / rate;
  }
}

/**
 * ROAS örneği: λ ~ Gamma(a,b), ρ ~ Gamma(c,d), ROAS = k·λ / ρ.
 * (bkz. spec §6 / §33: Thompson sample)
 */
export function sampleRoas(
  a: number,
  b: number,
  c: number,
  d: number,
  k: number,
  rng: Rng,
  // Profit varyantı: her €1 harcama için sampled contribution profit
  margin?: number,
): number {
  const lambda = gammaSample(a, b, rng);
  const rho = Math.max(gammaSample(c, d, rng), 1e-12);
  const roas = (k * lambda) / rho;
  if (typeof margin === "number" && Number.isFinite(margin)) {
    return margin * roas - 1; // ProfitUtility = M·θ − 1
  }
  return roas;
}