"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  BriefSchema,
  DraftSchema,
  type DraftContent,
  type Brief,
} from "@admedic/llm";
import { checkPolicy } from "@admedic/policy";
import { api, labels } from "../_lib/client-api";
import { rtlFor } from "../_lib/creative-lang";

type Saved = {
  id: string;
  version: number;
  status: string;
  content: DraftContent;
  experimentId: string | null;
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
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const canEdit = ["OWNER", "ADMIN", "MEDIA_BUYER"].includes(role);
  const canApprove = ["OWNER", "ADMIN"].includes(role);
  const policy = draft
    ? checkPolicy(
        draft.variants
          .map((v) => `${v.headline}\n${v.text}\n${v.cta}\n${v.description ?? ""}`)
          .join("\n"),
      )
    : null;

  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "İşlem başarısız.");
    } finally {
      setBusy(false);
    }
  }
  async function generate(form: FormData) {
    await work(async () => {
      const brief = BriefSchema.safeParse({
        clinic: form.get("clinic"),
        service: form.get("service"),
        market: form.get("market"),
        language: form.get("language"),
        budget: Number(form.get("budget")),
        duration: Number(form.get("duration")),
      });
      if (!brief.success)
        throw new Error("Lütfen brif alanlarını kontrol edin.");
      const result = await api<{ content: DraftContent }>(
        "/api/studio/generate",
        "POST",
        brief.data,
      );
      setDraft(result.content);
      setDirty(true);
      setNotice("AI varyantları hazır. İçeriği inceleyip kaydedin.");
    });
  }
  async function startManual(form: FormData) {
    await work(async () => {
      const brief = BriefSchema.safeParse({
        clinic: form.get("clinic"),
        service: form.get("service"),
        market: form.get("market"),
        language: form.get("language"),
        budget: Number(form.get("budget")),
        duration: Number(form.get("duration")),
      });
      if (!brief.success)
        throw new Error("Lütfen brif alanlarını kontrol edin.");
      setDraft({
        ...brief.data,
        variants: [
          { headline: "", text: "", cta: "" },
          { headline: "", text: "", cta: "" },
        ],
      });
      setDirty(true);
      setNotice(
        "Manuel taslak açıldı. Her varyantın başlığını, metnini ve CTA alanını doldurun.",
      );
    });
  }
  async function save() {
    if (!draft) return;
    await work(async () => {
      const parsed = DraftSchema.safeParse(draft);
      if (!parsed.success)
        throw new Error(
          "Başlık, metin ve CTA alanlarını doldurun; uzunluk sınırlarını kontrol edin.",
        );
      if (saved) {
        await api(`/api/studio/${saved.id}`, "PATCH", {
          action: "edit",
          version: saved.version,
          content: parsed.data,
        });
        const { draft: updated } = await api<{ draft: Saved }>(
          `/api/studio/${saved.id}`,
        );
        setSaved({ ...updated, experimentId: saved.experimentId });
      } else {
        const result = await api<{ draft: Saved }>("/api/studio", "POST", {
          content: parsed.data,
        });
        setSaved({ ...result.draft, experimentId: null });
        router.replace(`/studio?id=${result.draft.id}`);
      }
      setDirty(false);
      setNotice("Taslak klinik kütüphanesine kaydedildi.");
    });
  }
  async function transition(
    action: "submit" | "approve" | "reject" | "experiment",
  ) {
    if (!saved || dirty) return;
    await work(async () => {
      const result = await api<{ experimentId?: string }>(
        `/api/studio/${saved.id}`,
        "PATCH",
        { action, version: saved.version },
      );
      if (result.experimentId) {
        router.push(`/tests/${result.experimentId}`);
        return;
      }
      const { draft: updated } = await api<{ draft: Saved }>(
        `/api/studio/${saved.id}`,
      );
      setSaved({ ...updated, experimentId: saved.experimentId });
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
      setDirty(true);
      setNotice(
        "Eski yerel taslak açıldı. Klinik kütüphanesine kaydetmek için Kaydet'e basın.",
      );
    } catch {
      setError("Bu tarayıcıda geçerli eski taslak bulunamadı.");
    }
  }
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
          <span>TR · EN · DE · RU · AR · FR · NL · PL</span>
          <span>Claude ile üretim</span>
          <span>{saved ? labels[saved.status] : "Yeni taslak"}</span>
        </div>
      </header>
      <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
        <section className="studio-card self-start">
          <div className="section-kicker">01 — REKLAM BRİFİ</div>
          <h2>Ne tanıtıyoruz?</h2>
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
                    <option value="TR">Türkçe</option>
                    <option value="EN">English</option>
                    <option value="DE">Deutsch</option>
                    <option value="RU">Русский</option>
                    <option value="AR">العربية</option>
                    <option value="FR">Français</option>
                    <option value="NL">Nederlands</option>
                    <option value="PL">Polski</option>
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="field">
                  Toplam bütçe (€)
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
                Metinleri kendim yazacağım
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
          <p className="mt-4 text-xs leading-5 text-slate-500">
            Brif değişiklikleri üretim düğmesine bastığınızda uygulanır. AI
            çağrısı sunucudaki sağlayıcı anahtarını kullanır. Hasta bilgisi
            girmeyin.
          </p>
          <Link href="/library" className="mt-5 block text-sm text-violet-600">
            ← Reklam kütüphanesi
          </Link>
        </section>
        <section className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="section-kicker">02 — REKLAM ÖNİZLEMESİ</div>
              <h2 className="text-xl font-semibold">
                Aynı hedef. İki farklı başlık.
              </h2>
            </div>
            <span className="status-pill">
              {dirty
                ? "Kaydedilmemiş değişiklikler"
                : saved
                  ? labels[saved.status]
                  : "Taslak"}
            </span>
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
              <h2>Bir sonraki kampanyanız burada başlıyor</h2>
              <p className="mt-3 max-w-sm text-sm leading-6 text-slate-500">
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
                        <p className="text-xs text-slate-400">
                          Sponsorlu · Önizleme
                        </p>
                      </div>
                    </div>
                    <div
                      dir={rtlFor(draft.language)}
                      className={`ad-art ${i ? "ad-art-b" : ""}`}
                    >
                      <span>
                        {draft.market} · {draft.language}
                      </span>
                      <strong>{draft.service}</strong>
                      <small>Görsel yer tutucu</small>
                    </div>
                    <div className="space-y-4 p-5">
                      {(["headline", "text", "description", "cta"] as const).map((key) => (
                        <label className="field" key={key}>
                          {key === "headline"
                            ? "Başlık"
                            : key === "text"
                              ? "Reklam metni"
                              : key === "description"
                                ? "Link açıklaması"
                                : "CTA"}
                          <textarea
                            disabled={busy || !canEdit}
                            dir={rtlFor(draft.language)}
                            rows={key === "text" ? 4 : key === "description" ? 2 : 2}
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
                    </div>
                  </article>
                ))}
              </div>
              {(draft.instantForm || draft.whatsapp) && (
                <div className="studio-card">
                  <div className="section-kicker">LEAD TOPLAMA UZANTILARI</div>
                  {draft.instantForm && (
                    <div className="mt-3 rounded-xl bg-slate-50 p-4 text-sm">
                      <strong dir={rtlFor(draft.language)}>Instant Form</strong>
                      <p className="mt-1" dir={rtlFor(draft.language)}>
                        Sorular: {draft.instantForm.questions.join(" · ")}
                      </p>
                    </div>
                  )}
                  {draft.whatsapp && (
                    <div className="mt-3 rounded-xl bg-emerald-50 p-4 text-sm">
                      <strong dir={rtlFor(draft.language)}>WhatsApp karşılama</strong>
                      <p className="mt-1" dir={rtlFor(draft.language)}>
                        {draft.whatsapp.welcome}
                      </p>
                    </div>
                  )}
                </div>
              )}
              <div className="studio-card">
                <div className="section-kicker">
                  İÇERİK KONTROLÜ · {policy?.version}
                </div>
                <h2>
                  {policy?.risk === "HIGH"
                    ? "Düzeltilmesi gereken ifadeler var"
                    : "Kural kontrolünde eşleşme yok"}
                </h2>
                {policy?.findings.map((f) => (
                  <div
                    key={f.rule}
                    className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-800"
                  >
                    <strong>{f.reason}</strong>
                    <p className="mt-1">{f.suggestion}</p>
                  </div>
                ))}
                <p className="mt-3 text-xs leading-5 text-slate-500">
                  Otomatik kontrol sınırlı bir ifade taramasıdır; Meta onayını
                  garanti etmez. İçerik değişiklikleri önceki onayı sıfırlar.
                </p>
              </div>
              <div className="studio-card">
                <div className="section-kicker">TEST PLANI & ONAY</div>
                <h2>%50 A / %50 B bütçe dağılımı</h2>
                <p className="mt-2 text-sm text-slate-500">
                  {draft.duration} gün · Toplam €{draft.budget.toFixed(2)} ·
                  Varyant başına günlük €
                  {(draft.budget / draft.duration / 2).toFixed(2)}
                </p>
                <p className="mt-2 text-xs text-slate-500">
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
                        disabled={busy || policy?.risk === "HIGH"}
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
