import { prisma, type Prisma } from "@admedic/database";
import {
  checkPolicy,
  DEFAULT_POLICY_RULES,
  type PolicyRuleDefinition,
  type PolicyResult,
} from "@admedic/policy";

let cachedRules: PolicyRuleDefinition[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5000;

export async function effectivePolicyRules(
  tx?: Prisma.TransactionClient,
): Promise<readonly PolicyRuleDefinition[]> {
  const now = Date.now();
  if (cachedRules && now - cachedAt < CACHE_TTL_MS) return cachedRules;
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
  const latest = new Map<string, PolicyRuleDefinition>();
  for (const row of rows) {
    const prev = latest.get(row.key);
    if (!prev || row.version > prev.version) latest.set(row.key, row);
  }
  const byKey = new Map(latest);
  const rules = [...new Map(
    [...byKey.values()].map((r) => [r.key, r]),
  ).values()];
  if (rules.length === 0) {
    throw new Error("policy_rules tablosunda aktif kural bulunamadı.");
  }
  cachedRules = rules;
  cachedAt = now;
  return rules;
}

export function invalidatePolicyRuleCache() {
  cachedRules = null;
  cachedAt = 0;
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