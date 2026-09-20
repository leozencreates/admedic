/**
 * Özel matematik fonksiyonları — bağımlılıksız, deterministik.
 * (Lanczos gammaln, series/continued-fraction regularized incomplete beta)
 */

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const;

function lanczosSz(z: number): number {
  z -= 1; // Lanczos bu formda ln Γ(z+1) ölçekli hesaplar; z'yi 1 kaydırıyoruz
  let x = LANCZOS_C[0] as number;
  for (let i = 1; i < LANCZOS_C.length; i++) {
    x += (LANCZOS_C[i] as number) / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** ln Γ(x), x > 0. Küçük x için reflection kullanılır. */
export function lnGamma(x: number): number {
  if (x <= 0 || Number.isNaN(x)) return NaN;
  if (x < 0.5) {
    // Γ(x)Γ(1−x) = π / sin(πx)
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * x)) - lanczosSz(1 - x);
  }
  return lanczosSz(x);
}

export function logBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

/** Regularized incomplete beta I_x(a,b) — Numerical Recipes btcoel/betacf. */
export function betainc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (a <= 0 || b <= 0 || Number.isNaN(x) || Number.isNaN(a) || Number.isNaN(b)) return NaN;

  const logBt = logBeta(a, b);
  const bt = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - logBt);

  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

const BETACF_MAXIT = 300;
const BETACF_EPS = 3e-14;
const BETACF_FPMIN = 1e-300;

function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < BETACF_FPMIN) d = BETACF_FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= BETACF_MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < BETACF_FPMIN) d = BETACF_FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < BETACF_FPMIN) c = BETACF_FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < BETACF_FPMIN) d = BETACF_FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < BETACF_FPMIN) c = BETACF_FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < BETACF_EPS) break;
  }
  return h;
}

/**
 * I_x(a,b) = p olduğu x'i bulur (logit uzayında bisection) → beta quantile.
 */
export function betaincInv(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (a <= 0 || b <= 0) return NaN;

  let lo = -40; // logit(t) alt sınır
  let hi = 40;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const t = 1 / (1 + Math.exp(-mid)); // sigmoid
    const v = betainc(t, a, b);
    if (v < p) lo = mid;
    else hi = mid;
  }
  return 1 / (1 + Math.exp(-(lo + hi) / 2));
}