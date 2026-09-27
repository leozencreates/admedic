import type { MetaClientLike } from "@admedic/meta-api";

type AdSetBudgetRow = { id: string; metaAdSetId: string | null; dailyBudget: number | null };

/** Kampanyanın bütçesi ad set'lerde mi (ABO)? Plan stratejisi belirleyicidir. */
export function isAdSetBudgetPlan(plan: unknown): boolean {
  return (plan as { strategy?: unknown } | null | undefined)?.strategy === "ABO";
}

/**
 * ABO'da yeni toplam günlük bütçeyi mevcut ad set paylarıyla orantılı dağıtır (minor unit; toplam
 * birebir korunur — en büyük kalan yöntemi). Mevcut paylar yoksa eşit bölünür.
 */
export function scaleAdSetBudgets(adSets: ReadonlyArray<AdSetBudgetRow>, newTotalCents: number): Map<string, number> {
  const result = new Map<string, number>();
  if (adSets.length === 0) return result;
  const total = Math.max(0, Math.round(newTotalCents));
  const weights = adSets.map((a) => Math.max(0, a.dailyBudget ?? 0));
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const effective = weightSum > 0 ? weights : adSets.map(() => 1);
  const effSum = effective.reduce((s, w) => s + w, 0);
  const exact = effective.map((w) => (total * w) / effSum);
  const floors = exact.map(Math.floor);
  let remainder = total - floors.reduce((s, v) => s + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder--;
  }
  adSets.forEach((a, i) => result.set(a.id, floors[i] ?? 0));
  return result;
}

/** Tutarı `parts` eşit paya böler (minor unit; kalan kuruşlar baştaki paylara; toplam korunur). */
export function splitEvenly(totalCents: number, parts: number): number[] {
  if (parts <= 0) return [];
  const total = Math.max(0, Math.round(totalCents));
  const base = Math.floor(total / parts);
  const remainder = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

export type BudgetPushLevel = "campaign" | "adset" | "none";

/**
 * Yayındaki kampanyanın bütçesini Meta'ya yazar.
 * - CBO: kampanya `daily_budget`.
 * - ABO: bütçe ad set'lerdedir; kampanyaya bütçe yazmak Meta'da yapıyı CBO'ya çevirir, bu yüzden her
 *   Meta ad set'i orantılı payını alır. Meta'da henüz ad set yoksa Meta'da değişecek bütçe yoktur
 *   (`none`); yerel paylar yayın sırasında kullanılır.
 * Ad set payları dönülür (yerel kayıt güncellemesi için). Bir ad set güncellemesi başarısız olursa
 * önceden güncellenenler eski değerlerine geri alınmaya çalışılır (en iyi çaba) ve hata yukarı fırlar.
 */
export async function pushBudgetToMeta(input: {
  meta: Pick<MetaClientLike, "updateBudget">;
  token: string;
  metaCampaignId: string;
  plan: unknown;
  adSets: ReadonlyArray<AdSetBudgetRow>;
  newDailyCents: number;
}): Promise<{ level: BudgetPushLevel; adSetBudgets: Map<string, number> }> {
  if (isAdSetBudgetPlan(input.plan)) {
    const shares = scaleAdSetBudgets(input.adSets, input.newDailyCents);
    const published = input.adSets.filter((a) => a.metaAdSetId);
    if (published.length === 0) return { level: "none", adSetBudgets: shares };
    const done: AdSetBudgetRow[] = [];
    try {
      for (const adSet of published) {
        const result = await input.meta.updateBudget(
          { entityType: "adset", entityId: adSet.metaAdSetId!, dailyBudgetCents: shares.get(adSet.id) ?? 0 },
          input.token,
        );
        if (!result.success) throw new Error("Meta ad set bütçe güncellemesi başarısız.");
        done.push(adSet);
      }
    } catch (error) {
      for (const adSet of done) {
        if (adSet.dailyBudget == null) continue;
        try {
          await input.meta.updateBudget(
            { entityType: "adset", entityId: adSet.metaAdSetId!, dailyBudgetCents: adSet.dailyBudget },
            input.token,
          );
        } catch {
          console.error(`[campaign-budget] ad set bütçesi geri alınamadı: ${adSet.metaAdSetId}`);
        }
      }
      throw error;
    }
    return { level: "adset", adSetBudgets: shares };
  }
  const result = await input.meta.updateBudget(
    { entityType: "campaign", entityId: input.metaCampaignId, dailyBudgetCents: input.newDailyCents },
    input.token,
  );
  if (!result.success) throw new Error("Meta bütçe güncellemesi başarısız.");
  return { level: "campaign", adSetBudgets: new Map() };
}
