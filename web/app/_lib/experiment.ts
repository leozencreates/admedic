export type Metrics = { spend: number; clicks: number; leads: number };

export function validMetrics(m: Metrics): boolean {
  return (
    Number.isFinite(m.spend) &&
    m.spend >= 0 &&
    Number.isSafeInteger(m.clicks) &&
    m.clicks >= 0 &&
    Number.isSafeInteger(m.leads) &&
    m.leads >= 0 &&
    m.leads <= m.clicks
  );
}

export function wilson(leads: number, clicks: number): [number, number] {
  if (!clicks) return [0, 1];
  const z = 1.96;
  const p = leads / clicks;
  const denominator = 1 + (z * z) / clicks;
  const center = (p + (z * z) / (2 * clicks)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / clicks + (z * z) / (4 * clicks * clicks))) /
    denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function compare(
  a: Metrics,
  b: Metrics,
  elapsed: number,
  duration: number,
) {
  if (
    ![a, b].every(validMetrics) ||
    !Number.isSafeInteger(elapsed) ||
    elapsed < 0 ||
    !Number.isSafeInteger(duration) ||
    duration < 1
  ) {
    return {
      winner: null,
      message: "Geçerli metrikler girin. Lead sayısı tıklama sayısını aşamaz.",
    };
  }
  if (elapsed < duration)
    return {
      winner: null,
      message: "Veri toplama sürüyor. Planlanan süre dolmadan karar vermeyin.",
    };
  if ([a, b].some((m) => m.clicks < 100 || m.leads < 10)) {
    return {
      winner: null,
      message:
        "Veri yetersiz: her varyantta en az 100 tıklama ve 10 lead gerekiyor.",
    };
  }
  const ai = wilson(a.leads, a.clicks);
  const bi = wilson(b.leads, b.clicks);
  const winner = ai[0] > bi[1] ? "A" : bi[0] > ai[1] ? "B" : null;
  return {
    winner,
    message: winner
      ? `${winner} varyantı tıklama → lead dönüşümünde önde. %95 Wilson aralıkları ayrışıyor. Bütçe kararı için CPL'yi de inceleyin.`
      : "Belirgin kazanan yok. %95 Wilson aralıkları örtüşüyor; mevcut sonuç kesin karar için yeterli değil.",
  };
}
