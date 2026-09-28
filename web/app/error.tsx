"use client";
import Link from "next/link";

/**
 * Bölüm hata sınırı. `retry` segmenti sunucudan yeniden ister (Next 16.3; `reset` yalnızca
 * durumu temizler, sunucu hatasında aynı hatayı yeniden gösterirdi). Sunucu hatalarında
 * `digest` günlükteki kaydı bulmaya yarar; kullanıcı yöneticisine bu kodu iletebilir.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <section className="studio-card mx-auto max-w-xl py-12 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">Bu sayfa yüklenemedi</h1>
      <p role="alert" className="my-4 text-sm leading-6 text-muted">
        İşlem tamamlanamadı. Birkaç dakika sonra tekrar deneyin; sorun sürerse yöneticinize
        {error?.digest ? (
          <>
            {" "}şu kodu iletin: <code className="font-mono text-slate-900">{error.digest}</code>.
          </>
        ) : (
          " bildirin."
        )}
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <button type="button" onClick={() => retry()} className="primary-button">
          Tekrar dene
        </button>
        <Link href="/" className="secondary-button">
          Bugün sayfasına dön
        </Link>
      </div>
    </section>
  );
}
