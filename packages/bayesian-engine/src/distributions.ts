import { betainc, betaincInv } from "./special";

/**
 * Scaled BetaPrime(a, c) dağılımı: X = scale · Z, Z ~ BetaPrime(a,c).
 * Z burada λ/ρ oranıdır (λ~Gamma(a,·), ρ~Gamma(c,·) bağımsız).
 * ROAS ~ (k·d/b) · BetaPrime(a, c)   (spec §7)
 */
export class BetaPrime {
  readonly a: number;
  readonly c: number;
  readonly scale: number; // (k·d / b)

  constructor(a: number, c: number, scale: number) {
    this.a = a;
    this.c = c;
    this.scale = scale;
  }

  /** P(X <= z) = I_{x}(a, c), x = (z/scale)/(1 + z/scale) */
  cdf(z: number): number {
    if (z <= 0) return 0;
    const r = z / this.scale;
    const x = r / (1 + r);
    return betainc(x, this.a, this.c);
  }

  /** P(X >= z) */
  survival(z: number): number {
    return 1 - this.cdf(z);
  }

  /** p-quantile: t = I^{-1}_p(a,c), z = t/(1-t) */
  quantile(p: number): number {
    const t = betaincInv(p, this.a, this.c);
    return this.scale * (t / Math.max(1 - t, 1e-12));
  }

  /** E[X] = scale · a/(c−1) (c > 1) */
  get mean(): number | null {
    if (this.c <= 1) return null;
    return this.scale * (this.a / (this.c - 1));
  }

  /** Var(X) = scale² · a(a+c−1) / ((c−1)²(c−2)) (c > 2) */
  get variance(): number | null {
    if (this.c <= 2) return null;
    return (
      this.scale ** 2 *
      ((this.a * (this.a + this.c - 1)) / ((this.c - 1) ** 2 * (this.c - 2)))
    );
  }
}