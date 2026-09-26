import { prisma, type Prisma } from "@admedic/database";
import {
  checkPolicy,
  DEFAULT_POLICY_RULES,
  type PolicyRuleDefinition,
  type PolicyResult,
} from "@admedic/policy";

/**
 * Migration ile kurulan üç çekirdek kural (ADR-0008). Biri eksikse kural seti
 * bozuk kabul edilir ve kontrol fail-closed hata verir (sessiz fallback yok).
 */
export const BOOTSTRAP_POLICY_RULE_KEYS = DEFAULT_POLICY_RULES.map((r) => r.key);

/**
 * Kural setinin taze anlık görüntüsü: her çağrı veritabanından okur (süreç içi
 * önbellek YOK — submit/approve/publish/activate güncel kuralları görmelidir).
 * `tx` verilirse aynı transaction istemcisi kullanılır.
 */
export async function effectivePolicyRules(
  tx?: Prisma.TransactionClient,
): Promise<readonly PolicyRuleDefinition[]> {
  const db = tx ?? prisma;
  const rows = await db.policyRule.findMany({
    select: {
      key: true,
      version: true,
      matcher: true,
      phrases: true,
      risk: true,
      reason: true,
      suggestion: true,
      active: true,
    },
  });
  // Anahtar başına en yüksek sürüm geçerlidir (pasif sürüm dahil; eski aktif sürüm dirilmez).
  const latest = new Map<string, PolicyRuleDefinition>();
  for (const row of rows) {
    const prev = latest.get(row.key);
    if (!prev || row.version > prev.version) latest.set(row.key, row);
  }
  const missing = BOOTSTRAP_POLICY_RULE_KEYS.filter((key) => !latest.has(key));
  if (missing.length > 0) {
    throw new Error(
      `policy_rules tablosunda çekirdek kural eksik: ${missing.join(", ")}. Migration'ları uygulayın.`,
    );
  }
  return [...latest.values()];
}

/**
 * Geri uyumluluk: önbellek kaldırıldığı için işlem yok. Kural yönetim rotaları
 * çağırmaya devam edebilir.
 */
export function invalidatePolicyRuleCache() {
  /* önbellek yok */
}

export async function checkPolicyWithRules(
  text: string,
  bannedPhrases: string[] = [],
  tx?: Prisma.TransactionClient,
): Promise<PolicyResult> {
  const rules = await effectivePolicyRules(tx);
  return checkPolicy(text, bannedPhrases, rules);
}

export { DEFAULT_POLICY_RULES };
