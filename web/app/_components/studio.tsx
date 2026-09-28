"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BriefSchema,
  DraftSchema,
  BRIEF_LANGUAGES,
  LANGUAGE_LABELS,
  META_CTA_TYPES,
  CTA_LABELS,
  DEFAULT_CTA,
  type DraftContent,
  type Brief,
} from "@admedic/llm";
import { checkPolicy } from "@admedic/policy";
import { api, defaultAccountCurrency, UNREACHABLE_MESSAGE } from "../_lib/client-api";
import { rtlFor } from "../_lib/creative-lang";
import { formatMoneyUnits } from "../_lib/format";
import { languageName, policyRiskStyle, studioStatusStyle, type StatusStyle } from "../_lib/labels";
import type { StudioPolicy } from "../_lib/studio-service";
import { Badge } from "./ui";

type Saved = {
  id: string;
  version: number;
  status: string;
  content: DraftContent;
  policy: StudioPolicy | null;
  experimentId: string | null;
};
type PatchResult = {
  ok: boolean;
  status: number;
  data: { error?: string; experimentId?: string; policyWarning?: StudioPolicy };
};
/** PATCH yanıtının gövdesi (422 `policyWarning` dahil) okunabilsin diye `api()` yerine doğrudan fetch. */
async function patchDraft(id: string, payload: unknown): Promise<PatchResult> {
  let response: Response;
  try {
    response = await fetch(`/api/studio/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(UNREACHABLE_MESSAGE);
  }
  const data = (await response.json().catch(() => ({}))) as PatchResult["data"];
  return { ok: response.ok, status: response.status, data };
}
/** İşlem sunucudan hata metni gelmeden başarısız olduğunda. */
const FAILED = "İşlem tamamlanamadı. Tekrar deneyin.";
const RISK_HEADING: Record<string, string> = {
  HIGH: "Yüksek risk: düzeltilmesi gereken ifadeler var",
  MEDIUM: "Orta risk: uyarıyla onaya gönderilebilir",
  LOW: "Düşük risk: kurallarla eşleşen ifade yok",
};
export function Studio({
  initial,
  role,
}: {
  initial: Saved | null;
  role: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftContent | null>(
    initial?.content ?? null,
  );
  const [brief, setBrief] = useState<Brief>(
    initial?.content ?? {
      clinic: "",
      service: "",
      market: "",
      language: "TR",
      budget: 700,
      duration: 7,
    },
  );
  const [saved, setSaved] = useState(initial);
  /** Sunucu politika sonucu (kural + LLM); istemci yeniden hesaplamaz. */
  const [policy, setPolicy] = useState<StudioPolicy | null>(initial?.policy ?? null);
  const [ackWarning, setAckWarning] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** Bütçe ve test tutarları varsayılan reklam hesabının para biriminde (yoksa EUR). */
  const [currency, setCurrency] = useState("EUR");
  useEffect(() => {
    void defaultAccountCurrency().then(setCurrency);
  }, []);
  const canEdit = ["OWNER", "ADMIN", "MEDIA_BUYER"].includes(role);
  const canApprove = ["OWNER", "ADMIN"].includes(role);
  // Kaydedilmemiş metin için yalnızca anlık ön tarama (varsayılan kurallar); karar sunucu sonucudur.
  const preview =
    dirty && draft
      ? checkPolicy(
          [
            ...draft.variants.flatMap((v) => [v.headline, v.text, v.cta, v.description ?? ""]),
            ...(draft.instantForm?.questions ?? []),
            draft.whatsapp?.welcome ?? "",
          ].join("\n"),
        )
      : null;
  const llm = policy?.llm ?? null;
  const llmAssessment = llm && !("error" in llm) ? llm : null;

  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : FAILED);
    } finally {
      setBusy(false);
    }
  }
  function briefFrom(form: FormData) {
    const parsed = BriefSchema.safeParse({
      clinic: form.get("clinic"),
      service: form.get("service"),
      market: form.get("market"),
      language: form.get("language"),
      budget: Number(form.get("budget")),
      duration: Number(form.get("duration")),
    });
    if (!parsed.success)
      throw new Error("Brif alanlarını kontrol edin: tüm alanlar dolu olmalı; bütçe ve süre geçerli bir sayı olmalı.");
    return parsed.data;
  }
  async function generate(form: FormData) {
    await work(async () => {
      const result = await api<{ content: DraftContent; policy: StudioPolicy }>(
        "/api/studio/generate",
        "POST",
        briefFrom(form),
      );
      setDraft(result.content);
      setPolicy(result.policy);
      setAckWarning(false);
      setDirty(true);
      setNotice("AI varyantları hazır. İçeriği inceleyip kaydedin.");
    });
  }
  async function startManual(form: FormData) {
    await work(async () => {
      setDraft({
        ...briefFrom(form),
        variants: [
          { headline: "", text: "", cta: DEFAULT_CTA },
          { headline: "", text: "", cta: DEFAULT_CTA },
        ],
      });
      setPolicy(null);
      setDirty(true);
      setNotice(
        "Boş taslak açıldı. Her varyantın başlığını, reklam metnini ve eylem düğmesini doldurun.",
      );
    });
  }
  async function refresh(id: string, experimentId: string | null) {
    const { draft: updated } = await api<{ draft: Saved }>(`/api/studio/${id}`);
    setSaved({ ...updated, experimentId });
    setPolicy(updated.policy ?? null);
  }
  async function save() {
    if (!draft) return;
    await work(async () => {
      const parsed = DraftSchema.safeParse(draft);
      if (!parsed.success)
        throw new Error(
          "Her varyantın başlık, reklam metni ve eylem düğmesi alanlarını doldurun; uzunluk sınırlarını aşmayın.",
        );
      if (saved) {
        const result = await patchDraft(saved.id, {
          action: "edit",
          version: saved.version,
          content: parsed.data,
        });
        if (!result.ok) throw new Error(result.data.error ?? FAILED);
        await refresh(saved.id, saved.experimentId);
      } else {
        const result = await api<{ draft: Saved }>("/api/studio", "POST", {
          content: parsed.data,
        });
        setSaved({ ...result.draft, experimentId: null });
        setPolicy(result.draft.policy ?? null);
        router.replace(`/studio?id=${result.draft.id}`);
      }
      setAckWarning(false);
      setDirty(false);
      setNotice("Taslak reklam kütüphanesine kaydedildi; içerik kontrolü yenilendi.");
    });
  }
  async function transition(
    action: "submit" | "approve" | "reject" | "experiment",
  ) {
    if (!saved || dirty) return;
    await work(async () => {
      const result = await patchDraft(saved.id, {
        action,
        version: saved.version,
        ...(action === "submit" && ackWarning ? { acknowledgeWarning: true } : {}),
      });
      if (!result.ok) {
        if (result.data.policyWarning) setPolicy(result.data.policyWarning);
        throw new Error(result.data.error ?? FAILED);
      }
      if (result.data.experimentId) {
        router.push(`/tests/${result.data.experimentId}`);
        return;
      }
      await refresh(saved.id, saved.experimentId);
      setAckWarning(false);
      setNotice("Taslak durumu güncellendi.");
    });
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "reklam-taslagi.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  function importLocal() {
    try {
      const data = DraftSchema.parse(
        JSON.parse(localStorage.getItem("ad-studio-draft-v1") ?? "null"),
      );
      setDraft(data);
      setBrief(data);
      setPolicy(null);
      setDirty(true);
      setNotice(
        "Bu tarayıcıdaki eski taslak açıldı. Reklam kütüphanesine kaydetmek için Kaydet'e basın.",
      );
    } catch {
      setError("Bu tarayıcıda geçerli eski taslak bulunamadı.");
    }
  }
  const submitBlocked = busy || policy?.risk === "HIGH" || (policy?.risk === "MEDIUM" && !ackWarning);
  // Önizleme başlığındaki durum: kaydedilmemiş değişiklik bir eylem bekler (amber).
  const headerStatus: StatusStyle = dirty
    ? { label: "Kaydedilmemiş değişiklikler", tone: "amber" }
    : saved
      ? studioStatusStyle(saved.status)
      : { label: "Taslak", tone: "gray" };
  const contentLang = draft ? draft.language.toLowerCase() : undefined;
  return (
    <div className="space-y-7">
      <header className="studio-hero">
        <span className="eyebrow">AI KREATİF STÜDYO / 01</span>
        <h1>Bir fikir. Sekiz dil. Yeni olasılıklar.</h1>
        <p>
          Klinik ve hedef pazarınıza göre reklam metinleri hazırlayın, inceleyin
          ve test planına dönüştürün.
        </p>
        <div className="hero-tags">
          <span>{BRIEF_LANGUAGES.join(" · ")}</span>
          <span>{saved ? studioStatusStyle(saved.status).label : "Yeni taslak"}</span>
        </div>
      </header>
      <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
        <section className="studio-card self-start">
          <div className="section-kicker">Adım 1 — Reklam brifi</div>
          <h2>Ne tanıtmak istiyorsunuz?</h2>
          <form action={generate} className="mt-6 space-y-4">
            <fieldset disabled={busy || !canEdit} className="space-y-4">
              <label className="field">
                Klinik adı
                <input
                  name="clinic"
                  required
                  maxLength={100}
                  value={brief.clinic}
                  onChange={(e) =>
                    setBrief({ ...brief, clinic: e.target.value })
                  }
                  placeholder="Klinik adı"
                />
              </label>
              <label className="field">
                Hizmet / işlem
                <input
                  name="service"
                  required
                  maxLength={100}
                  value={brief.service}
                  onChange={(e) =>
                    setBrief({ ...brief, service: e.target.value })
                  }
                  placeholder="Örn. diş implantı"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="field">
                  Hedef pazar
                  <input
                    name="market"
                    required
                    maxLength={80}
                    value={brief.market}
                    onChange={(e) =>
                      setBrief({ ...brief, market: e.target.value })
                    }
                    placeholder="Almanya"
                  />
                </label>
                <label className="field">
                  Reklam dili
                  <select
                    name="language"
                    value={brief.language}
                    onChange={(e) =>
                      setBrief({
                        ...brief,
                        language: e.target.value as Brief["language"],
                      })
                    }
                  >
                    {BRIEF_LANGUAGES.map((code) => (
                      <option key={code} value={code} lang={code.toLowerCase()}>
                        {LANGUAGE_LABELS[code]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="field">
                  Toplam bütçe ({currency})
                  <input
                    name="budget"
                    type="number"
                    min="1"
                    max="1000000"
                    step="0.01"
                    value={Number.isNaN(brief.budget) ? "" : brief.budget}
                    onChange={(e) =>
                      setBrief({ ...brief, budget: e.target.valueAsNumber })
                    }
                    required
                  />
                </label>
                <label className="field">
                  Süre (gün)
                  <input
                    name="duration"
                    type="number"
                    min="1"
                    max="90"
                    value={Number.isNaN(brief.duration) ? "" : brief.duration}
                    onChange={(e) =>
                      setBrief({ ...brief, duration: e.target.valueAsNumber })
                    }
                    required
                  />
                </label>
              </div>
              <button className="primary-button w-full" type="submit">
                {busy ? "İşleniyor…" : "✦ AI ile varyantları hazırla"}
              </button>
              <button
                className="secondary-button w-full"
                type="submit"
                formAction={startManual}
              >
                Boş taslakla başla
              </button>
              <button
                className="secondary-button w-full"
                type="button"
                onClick={importLocal}
              >
                Eski tarayıcı taslağını içe aktar
              </button>
            </fieldset>
          </form>
          <p className="mt-4 text-xs leading-5 text-muted">
            Brif değişiklikleri üretim düğmesine bastığınızda uygulanır. Hasta
            bilgisi girmeyin.
          </p>
          <Link href="/library" className="mt-5 block text-sm text-violet-600">
            ← Reklam kütüphanesi
          </Link>
        </section>
        <section className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="section-kicker">Adım 2 — Reklam önizlemesi</div>
              <h2 className="text-xl font-semibold">
                Aynı hedef. İki farklı başlık.
              </h2>
            </div>
            <Badge tone={headerStatus.tone}>{headerStatus.label}</Badge>
          </div>
          {busy && (
            <div role="status" className="studio-card animate-pulse">
              İşlem sürüyor, lütfen bekleyin…
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"
            >
              {error}
            </div>
          )}
          {!draft ? (
            <div className="studio-card flex min-h-80 flex-col items-center justify-center text-center">
              <div className="mb-5 rounded-2xl bg-violet-50 p-5 text-3xl text-violet-600">
                ✦
              </div>
              <h2>Bir sonraki reklamınız burada başlıyor</h2>
              <p className="mt-3 max-w-sm text-sm leading-6 text-muted">
                Brifi doldurun. AI'ın ürettiği iki düzenlenebilir reklam kartı
                burada görünecek.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                {draft.variants.map((v, i) => (
                  <article className="ad-preview" key={i}>
                    <div dir={rtlFor(draft.language)} className="flex items-center gap-3 p-5">
                      <span className="variant-marker">{i ? "B" : "A"}</span>
                      <div>
                        <p className="font-semibold">{draft.clinic}</p>
                        <p className="text-xs text-muted">
                          Sponsorlu · Önizleme
                        </p>
                      </div>
                    </div>
                    <div
                      dir={rtlFor(draft.language)}
                      className={`ad-art ${i ? "ad-art-b" : ""}`}
                    >
                      <span>
                        {draft.market} · {languageName(draft.language)}
                      </span>
                      <strong>{draft.service}</strong>
                      <small>Görsel yer tutucu</small>
                    </div>
                    <div className="space-y-4 p-5">
                      {(["headline", "text", "description"] as const).map((key) => (
                        <label className="field" key={key}>
                          {key === "headline"
                            ? "Başlık"
                            : key === "text"
                              ? "Reklam metni"
                              : "Bağlantı açıklaması"}
                          <textarea
                            disabled={busy || !canEdit}
                            dir={rtlFor(draft.language)}
                            lang={contentLang}
                            rows={key === "text" ? 4 : 2}
                            maxLength={key === "text" ? 2000 : key === "description" ? 500 : 150}
                            value={v[key] ?? ""}
                            onChange={(e) => {
                              setDraft({
                                ...draft,
                                variants: draft.variants.map((item, index) =>
                                  index === i
                                    ? { ...item, [key]: e.target.value }
                                    : item,
                                ) as DraftContent["variants"],
                              });
                              setDirty(true);
                            }}
                          />
                        </label>
                      ))}
                      <label className="field">
                        Eylem düğmesi
                        <select
                          disabled={busy || !canEdit}
                          value={v.cta}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              variants: draft.variants.map((item, index) =>
                                index === i ? { ...item, cta: e.target.value } : item,
                              ) as DraftContent["variants"],
                            });
                            setDirty(true);
                          }}
                        >
                          {!(META_CTA_TYPES as readonly string[]).includes(v.cta) && (
                            <option value={v.cta}>
                              {v.cta ? `${v.cta} (serbest metin)` : "Seçin…"}
                            </option>
                          )}
                          {META_CTA_TYPES.map((cta) => (
                            <option key={cta} value={cta}>
                              {CTA_LABELS[cta]}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </article>
                ))}
              </div>
              {(draft.instantForm || draft.whatsapp) && (
                <div className="studio-card">
                  <div className="section-kicker">Lead toplama</div>
                  {draft.instantForm && (
                    <div className="mt-3 rounded-xl bg-slate-50 p-4 text-sm">
                      <strong dir={rtlFor(draft.language)}>Anında Form</strong>
                      <p className="mt-1">
                        Sorular:{" "}
                        <span dir={rtlFor(draft.language)} lang={contentLang}>{draft.instantForm.questions.join(" · ")}</span>
                      </p>
                    </div>
                  )}
                  {draft.whatsapp && (
                    <div className="mt-3 rounded-xl bg-emerald-50 p-4 text-sm">
                      <strong dir={rtlFor(draft.language)}>WhatsApp karşılama mesajı</strong>
                      <p className="mt-1" dir={rtlFor(draft.language)} lang={contentLang}>
                        {draft.whatsapp.welcome}
                      </p>
                    </div>
                  )}
                </div>
              )}
              <div className="studio-card">
                <div className="section-kicker">İçerik kontrolü</div>
                <h2>
                  {policy
                    ? RISK_HEADING[policy.risk] ?? policyRiskStyle(policy.risk).label
                    : "İçerik kontrolü için taslağı kaydedin"}
                </h2>
                {policy?.findings.map((f) => (
                  <div
                    key={f.rule}
                    className={`mt-3 rounded-xl p-3 text-sm ${
                      f.risk === "MEDIUM" ? "bg-amber-50 text-amber-800" : "bg-rose-50 text-rose-800"
                    }`}
                  >
                    <strong>{f.reason}</strong>
                    <p className="mt-1">{f.suggestion}</p>
                  </div>
                ))}
                {policy && (
                  <div className="mt-3 rounded-xl border border-slate-200 p-3 text-sm">
                    {llmAssessment ? (
                      <>
                        <p>
                          <strong>AI değerlendirmesi:</strong> {policyRiskStyle(llmAssessment.risk).label} — {llmAssessment.reason}
                        </p>
                        {llmAssessment.correctedCopy && (
                          <p className="mt-2 text-slate-700" dir={rtlFor(draft.language)}>
                            <span className="font-medium">Düzeltilmiş öneri:</span>{" "}
                            <span lang={contentLang}>{llmAssessment.correctedCopy}</span>
                          </p>
                        )}
                      </>
                    ) : llm && "error" in llm ? (
                      <p className="text-amber-700">
                        {`AI değerlendirmesi bu sefer yapılamadı; karar kural kontrolüne göre verildi${
                          policy.ruleRisk
                            ? ` (kural kontrolü: ${policyRiskStyle(policy.ruleRisk).label.toLocaleLowerCase("tr")})`
                            : ""
                        }.`}
                      </p>
                    ) : (
                      <p className="text-muted">
                        AI değerlendirmesi kullanılmıyor; karar kural kontrolüne göre verildi.
                      </p>
                    )}
                  </div>
                )}
                {policy?.risk === "MEDIUM" && saved && !dirty && canEdit && ["DRAFT", "REJECTED"].includes(saved.status) && (
                  <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    <p>
                      Orta riskli ifadeler Meta incelemesinde reddedilebilir. Yine de onaya göndermek
                      için uyarıyı onaylayın; bu onay denetim kaydına yazılır.
                    </p>
                    <label className="mt-2 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={ackWarning}
                        onChange={(e) => setAckWarning(e.target.checked)}
                        disabled={busy}
                      />
                      Uyarıyı okudum, yine de onaya gönder
                    </label>
                  </div>
                )}
                {preview && preview.risk !== "LOW" && (
                  <div className="mt-3 rounded-xl border border-dashed border-amber-300 p-3 text-xs text-amber-800">
                    Ön tarama (kaydedilmemiş metin): {preview.findings.map((f) => f.reason).join(" · ")} —
                    kaydettiğinizde tam içerik kontrolü esas alınır.
                  </div>
                )}
                <p className="mt-3 text-xs leading-5 text-muted">
                  Otomatik kontrol sınırlı bir ifade taramasıdır; Meta onayını
                  garanti etmez. İçerik değişiklikleri önceki onayı sıfırlar.
                </p>
              </div>
              <div className="studio-card">
                <div className="section-kicker">Test planı ve onay</div>
                <h2>%50 A / %50 B bütçe dağılımı</h2>
                <p className="mt-2 text-sm text-muted">
                  {draft.duration} gün · Toplam{" "}
                  {formatMoneyUnits(draft.budget, currency)} · Varyant başına günlük{" "}
                  {formatMoneyUnits(draft.budget / draft.duration / 2, currency, { precise: true })}
                </p>
                <p className="mt-2 text-xs text-muted">
                  18+ hedefleme, ayrık rastgele kitleler ve tek değişken:
                  başlık. İçerik onayı Meta yayını değildir.
                </p>
                <div className="mt-5 flex flex-wrap gap-3">
                  {canEdit && (
                    <button
                      className="primary-button"
                      disabled={busy || (!dirty && !!saved)}
                      onClick={save}
                    >
                      Kaydet
                    </button>
                  )}
                  <button className="secondary-button" onClick={download}>
                    JSON indir
                  </button>
                  {saved &&
                    !dirty &&
                    canEdit &&
                    ["DRAFT", "REJECTED"].includes(saved.status) && (
                      <button
                        className="secondary-button"
                        disabled={submitBlocked}
                        onClick={() => transition("submit")}
                      >
                        Onaya gönder
                      </button>
                    )}
                  {saved?.status === "IN_REVIEW" && !dirty && canApprove && (
                    <>
                      <button
                        className="primary-button"
                        disabled={busy || policy?.risk === "HIGH"}
                        onClick={() => transition("approve")}
                      >
                        İçeriği onayla
                      </button>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => transition("reject")}
                      >
                        Düzeltme iste
                      </button>
                    </>
                  )}
                  {saved?.status === "APPROVED" &&
                    !dirty &&
                    canEdit &&
                    !saved.experimentId && (
                      <button
                        className="primary-button"
                        disabled={busy}
                        onClick={() => transition("experiment")}
                      >
                        A/B deneyi oluştur →
                      </button>
                    )}
                  {saved?.experimentId && (
                    <Link
                      className="secondary-button"
                      href={`/tests/${saved.experimentId}`}
                    >
                      Kayıtlı deneye git →
                    </Link>
                  )}
                </div>
                {dirty && saved && (
                  <p className="mt-3 text-xs text-amber-700">
                    Onay işlemleri için önce değişiklikleri kaydedin.
                  </p>
                )}
              </div>
            </>
          )}
          <p role="status" className="text-sm text-violet-700">
            {notice}
          </p>
        </section>
      </div>
    </div>
  );
}
