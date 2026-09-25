"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, labels } from "../_lib/client-api";
import { rtlFor } from "../_lib/creative-lang";
type Item = {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  content: {
    language: string;
    market: string;
    variants: { headline: string }[];
  };
  policy: { risk: string };
  experiment: { id: string } | null;
};
export function Library() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      setItems((await api<{ drafts: Item[] }>("/api/studio")).drafts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const filtered = items.filter(
    (d) =>
      (!status || d.status === status) &&
      d.name.toLocaleLowerCase("tr").includes(query.toLocaleLowerCase("tr")),
  );
  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">KREATİF KÜTÜPHANESİ</span>
        <h1>Her fikir bir sonraki teste hazır.</h1>
        <p>
          Taslakları düzenleyin, içerik kontrollerini inceleyin ve ekibinizle
          onaylayın.
        </p>
        <Link href="/studio" className="primary-button mt-5">
          ✦ Yeni reklam oluştur
        </Link>
      </header>
      <div className="grid grid-cols-3 gap-3">
        {[
          ["Toplam taslak", items.length],
          [
            "Onay bekleyen",
            items.filter((x) => x.status === "IN_REVIEW").length,
          ],
          ["Onaylanan", items.filter((x) => x.status === "APPROVED").length],
        ].map(([label, value]) => (
          <div className="studio-card" key={label}>
            <p className="section-kicker">{label}</p>
            <strong className="text-3xl">{loading ? "—" : value}</strong>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="field flex-1">
          Reklam ara
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Klinik veya hizmet adı…"
          />
        </label>
        <label className="field">
          Durum
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tüm durumlar</option>
            {["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED"].map((s) => (
              <option key={s} value={s}>
                {labels[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? (
        <div className="studio-card animate-pulse" role="status">
          Kütüphane yükleniyor…
        </div>
      ) : error ? (
        <div className="studio-card" role="alert">
          <p>{error}</p>
          <button className="secondary-button mt-4" onClick={load}>
            Tekrar dene
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="studio-card py-12 text-center">
          <h2>
            {items.length
              ? "Filtreye uygun taslak yok"
              : "İlk kampanyanızla başlayın"}
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            Kaydettiğiniz reklamlar ve onay durumları burada görünecek.
          </p>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <article className="studio-card space-y-4" key={item.id}>
              <div className="flex items-center justify-between">
                <span className="status-pill">{labels[item.status]}</span>
                <span className="text-xs text-slate-400">
                  {item.content.language} · {item.content.market}
                </span>
              </div>
              <h2>{item.name}</h2>
              <p
                className="text-sm text-slate-500"
                dir={rtlFor(item.content.language)}
              >
                {item.content.variants[0]?.headline}
              </p>
              <div className="border-t border-slate-100 pt-4 text-xs text-slate-500">
                {item.policy.risk === "HIGH"
                  ? "İçerik düzeltmesi gerekli"
                  : "Kural kontrolünde eşleşme yok"}{" "}
                · {new Date(item.updatedAt).toLocaleDateString("tr-TR")}
              </div>
              <div className="flex gap-3">
                <Link href={`/studio?id=${item.id}`} className="primary-button">
                  İncele →
                </Link>
                {item.experiment && (
                  <Link
                    href={`/tests/${item.experiment.id}`}
                    className="secondary-button"
                  >
                    Deneye git
                  </Link>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-400">
        Son güncellenen en fazla 100 taslak gösterilir.
      </p>
    </div>
  );
}
