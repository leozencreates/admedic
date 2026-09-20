// Deterministik (kural tabanlı) A/B test istatistikleri.
// ROAS dağılımını dengeli örnekleme (bootstrap) ile karşılaştırır.

export interface VariantStatInput {
  date: string;
  impressions: number;
  clicks: number;
  spendKurus: number;
  conversions: number;
  revenueKurus: number;
}

export interface VariantStat {
  impressions: number;
  clicks: number;
  spendKurus: number;
  conversions: number;
  revenueKurus: number;
  roas: number; // gelir / harcama (kuruş bazlı)
  dailyRoas: number[]; // günlük küçük noktalar (0 harcama olan günler atlanır)
  ctr: number;
  cpc: number;
  days: number;
}

export function computeVariantStat(points: VariantStatInput[]): VariantStat {
  let impressions = 0;
  let clicks = 0;
  let spend = 0;
  let conversions = 0;
  let revenue = 0;
  const dailyRoas: number[] = [];

  for (const p of points) {
    impressions += p.impressions;
    clicks += p.clicks;
    spend += p.spendKurus;
    conversions += p.conversions;
    revenue += p.revenueKurus;
    if (p.spendKurus > 0) dailyRoas.push(p.revenueKurus / p.spendKurus);
  }

  const roas = spend > 0 ? revenue / spend : 0;

  return {
    impressions,
    clicks,
    spendKurus: spend,
    conversions,
    revenueKurus: revenue,
    roas,
    dailyRoas,
    ctr: impressions > 0 ? clicks / impressions : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    days: dailyRoas.length,
  };
}

// Mulberry32: sabit tohum ile deterministik RNG
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sabit tohumla "A'nın ROAS'ı B'den büyük" olasılığı.
// Gözlemlenen günlük ROAS vektörlerinden dengeli örnekleme yapar.
export function probabilityLatestWins(
  a: VariantStatInput[],
  b: VariantStatInput[],
  seed: number,
  iterations = 10000
): number {
  const ba = computeVariantStat(a);
  const bb = computeVariantStat(b);

  if (ba.dailyRoas.length === 0 || bb.dailyRoas.length === 0) return 0.5;

  const rand = mulberry32(seed);
  let aWins = 0;
  let draws = 0;
  for (let i = 0; i < iterations; i++) {
    const x =
      ba.dailyRoas[Math.floor(rand() * ba.dailyRoas.length)] ?? 0;
    const y =
      bb.dailyRoas[Math.floor(rand() * bb.dailyRoas.length)] ?? 0;
    if (x > y) aWins++;
    else if (x === y) draws++;
  }
  return (aWins + draws / 2) / iterations;
}