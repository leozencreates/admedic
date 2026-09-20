"use client";
import Link from "next/link";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="studio-card mx-auto max-w-xl py-12 text-center">
      <h2>Bu sayfa yüklenemedi</h2>
      <p className="my-4 text-sm text-slate-500">
        Kayıt bulunamamış veya veritabanı bağlantısı kesilmiş olabilir.
      </p>
      <div className="flex justify-center gap-3">
        <button onClick={reset} className="primary-button">
          Tekrar dene
        </button>
        <Link href="/library" className="secondary-button">
          Kütüphaneye dön
        </Link>
      </div>
    </section>
  );
}
