"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { api, defaultAccountCurrency } from "../_lib/client-api";
import { formatMoney, formatPercent, formatRoas } from "../_lib/format";
import { optimizationRuleText, policyMatcherLabel, policyRiskStyle, policyRuleName, ruleActiveStyle } from "../_lib/labels";
import { Badge, Card, EmptyState, PageHeader, SectionHeading } from "../_components/ui";
const OBJECTIVE_LABEL: Record<string, string> = {
  MAX_ROAS: "Maksimum ROAS",
  MAX_REVENUE: "Maksimum gelir",
  MAX_PROFIT: "Maksimum kâr",
  MIN_CPA: "Minimum CPA",
  MAX_PURCHASES_BUDGET: "Bütçe içinde maksimum satın alma",
  TARGET_ROAS: "Hedef ROAS",
  TARGET_CPA: "Hedef CPA",
};
const MODE_LABEL: Record<string, string> = {
  OBSERVE: "Gözlem",
  APPROVAL: "Onaylı",
  AUTOPILOT: "Otopilot",
  SHADOW: "Gölge",
};
interface PolicyRule {
  id: string; key: string; version: number; matcher: string; phrases: string[];
  risk: string; reason: string; suggestion: string; active: boolean;
}
interface OptimizationPolicy {
  enabled: boolean; objective: string; mode: string;
  minDailyBudgetCents: number; maxDailyBudgetCents: number | null;
  campaignDailyMaxCents: number | null; accountDailyMaxCents: number | null; accountMonthlyMaxCents: number | null;
  maxIncreasePct: number; maxDecreasePct: number; maxChangePer24hPct: number; minHoursBetweenChanges: number;
  targetRoas: number; maxCpaCents: number | null; updatedAt: string;
}
interface OptimizationRule { id: string; name: string; version: string; active: boolean; description: string | null; workspaceId: string | null }

/** Yükleme hatası boş liste gibi gösterilmez (İÇ-3): ne olduğu + "Tekrar dene". */
function LoadError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p className="font-medium">{title}</p>
      {message && <p className="mt-1">{message}</p>}
      <button type="button" className="secondary-button mt-3" onClick={onRetry}>
        Tekrar dene
      </button>
    </div>
  );
}

export default function PoliciesPage() {
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [policy, setPolicy] = useState<OptimizationPolicy | null>(null);
  const [optRules, setOptRules] = useState<OptimizationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [currency, setCurrency] = useState("EUR");
  async function load() {
    setLoading(true);
    setRulesError(null);
    setPolicyError(null);
    try {
      const data = await api<{ rules: PolicyRule[]; canEdit: boolean }>("/api/policy-rules");
      setRules(data.rules);
      setCanEdit(Boolean(data.canEdit));
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : "");
    }
    try {
      const data = await api<{ optimizationPolicy: OptimizationPolicy | null; optimizationRules: OptimizationRule[] }>("/api/policies");
      setPolicy(data.optimizationPolicy);
      setOptRules(data.optimizationRules ?? []);
    } catch (e) {
      setPolicyError(e instanceof Error ? e.message : "");
    }
    setLoading(false);
  }
  useEffect(() => {
    load();
    void defaultAccountCurrency().then(setCurrency);
  }, []);
  const money = (cents: number | null) => (cents !== null ? formatMoney(cents, currency) : "tanımlı değil");
  const enabled = policy ? ruleActiveStyle(policy.enabled) : null;
  return (
    <div className="space-y-8">
      <PageHeader
        title="Politika ve bütçe koruma"
        description="Reklam metinleri önce içerik kurallarıyla, ardından AI değerlendirmesiyle kontrol edilir; bütçe koruma sınırları aşağıda listelenir."
        crumbs={[{ label: "Ayarlar" }]}
      />
      <Card>
        <SectionHeading
          title="İçerik kuralları (salt okunur)"
          description="Tüm çalışma alanlarında geçerli, sürümlü içerik kuralları: garanti vaadi, önce/sonra karşılaştırması, kişisel özellik ve ifade listeleri. Kliniğe özel yasaklı ifadeler klinik profilinden gelir."
          action={<Link href="/policy-rules" className="shrink-0 whitespace-nowrap text-xs font-medium text-violet-700 hover:underline">{canEdit ? "Kuralları yönet" : "Sürüm geçmişi"}</Link>}
        />
        {loading ? (
          <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
        ) : rulesError !== null ? (
          <LoadError title="İçerik kuralları yüklenemedi." message={rulesError} onRetry={() => void load()} />
        ) : rules.length === 0 ? (
          <EmptyState message="Henüz içerik kuralı yok. Kurallar eklendiğinde reklam metinleri yayından önce bu kurallarla kontrol edilir." />
        ) : (
          <div className="space-y-3">
            {rules.map((r) => {
              const active = ruleActiveStyle(r.active);
              const risk = policyRiskStyle(r.risk);
              return (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{policyRuleName(r.key)} <span className="ml-1 text-xs font-normal text-muted">{policyMatcherLabel(r.matcher)}</span></p>
                    <p className="text-xs text-muted">{r.reason}</p>
                    {r.matcher === "PHRASES_V1" && r.phrases.length > 0 && <p className="text-xs text-muted">İfadeler: {r.phrases.join(", ")}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={active.tone}>{active.label}</Badge>
                    <Badge tone={risk.tone}>{risk.label}</Badge>
                    <span className="text-xs text-muted">{r.version}. sürüm</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <Card>
        <SectionHeading title="Optimizasyon politikası" description="Bütçe koruma sınırları ve AI önerilerinin çalışma modu. İçerik kontrolüyle ilgili değildir." />
        {loading ? (
          <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
        ) : policyError !== null ? (
          <LoadError title="Optimizasyon politikası yüklenemedi." message={policyError} onRetry={() => void load()} />
        ) : !policy ? (
          <EmptyState message="Bu çalışma alanı için optimizasyon politikası tanımlı değil. Bütçe koruma sınırlarını tanımlatmak için yöneticinize başvurun." />
        ) : (
          <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
            <p>Durum: {enabled && <Badge tone={enabled.tone}>{enabled.label}</Badge>}</p>
            <p>Çalışma modu: <strong className="font-medium text-slate-900">{MODE_LABEL[policy.mode] ?? "Diğer"}</strong></p>
            <p>Optimizasyon hedefi: {OBJECTIVE_LABEL[policy.objective] ?? "Diğer"} · Hedef ROAS: {formatRoas(policy.targetRoas)}</p>
            <p>Günlük bütçe aralığı: {formatMoney(policy.minDailyBudgetCents, currency)} – {policy.maxDailyBudgetCents !== null ? formatMoney(policy.maxDailyBudgetCents, currency) : "üst sınır yok"}</p>
            <p>Kampanya günlük üst sınırı: {money(policy.campaignDailyMaxCents)}</p>
            <p>
              Ajanın hesap günlük / aylık harcama sınırı: {money(policy.accountDailyMaxCents)} / {money(policy.accountMonthlyMaxCents)}
              <span className="block text-xs text-muted">Kuruluşun aylık üst sınırından ayrıdır; o sınır Yeni kampanya ekranında belirlenir.</span>
            </p>
            <p>Tek seferde bütçe değişimi: en fazla +{formatPercent(policy.maxIncreasePct)} / −{formatPercent(policy.maxDecreasePct)}; 24 saatte en fazla {formatPercent(policy.maxChangePer24hPct)}</p>
            <p>Değişiklikler arasında en az {policy.minHoursBetweenChanges} saat · En yüksek CPA: {money(policy.maxCpaCents)}</p>
          </div>
        )}
        {!loading && policyError === null && optRules.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-semibold text-muted">Optimizasyon kuralları</p>
            {optRules.map((r) => {
              const active = ruleActiveStyle(r.active);
              return (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-2.5">
                  {(() => {
                    const text = optimizationRuleText(r.name, r.description);
                    return (
                      <div className="min-w-0">
                        <p className="text-sm text-slate-900">{text.name}</p>
                        {text.description && <p className="text-xs text-muted">{text.description}</p>}
                      </div>
                    );
                  })()}
                  <div className="flex items-center gap-2">
                    <Badge tone={active.tone}>{active.label}</Badge>
                    {!r.workspaceId && <span className="text-xs text-muted">Tüm çalışma alanları</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
