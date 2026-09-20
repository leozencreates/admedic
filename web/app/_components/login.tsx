"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../_lib/client-api";
export function Login() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(data: FormData) {
    setBusy(true);
    setError("");
    try {
      await api("/api/session", "POST", Object.fromEntries(data));
      router.push("/library");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Giriş başarısız.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">ÇALIŞMA ALANINIZA HOŞ GELDİNİZ</span>
        <h1>İyi fikirler, aynı yerde.</h1>
        <p>
          Reklamlarınızı, ekibinizin onaylarını ve deney sonuçlarını tek yerde
          yönetin.
        </p>
      </header>
      <section className="studio-card">
        <h2>Oturum açın</h2>
        <form action={login} className="mt-6 space-y-4">
          <label className="field">
            E-posta
            <input
              name="email"
              type="email"
              autoComplete="username"
              maxLength={254}
              required
            />
          </label>
          <label className="field">
            Parola
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={256}
              required
            />
          </label>
          <label className="field">
            Çalışma alanı ID
            <input
              name="workspace"
              autoComplete="off"
              maxLength={100}
              required
            />
          </label>
          <button disabled={busy} className="primary-button w-full">
            {busy ? "Giriş yapılıyor…" : "Çalışma alanına gir →"}
          </button>
          <p role="alert" className="text-sm text-rose-600">
            {error}
          </p>
        </form>
        <details className="mt-6 text-xs leading-6 text-slate-500">
          <summary className="cursor-pointer">
            İlk kurulumu mu yapıyorsunuz?
          </summary>
          <p>
            Sunucuda BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD ve BOOTSTRAP_CLINIC
            ortam değişkenlerini ayarlayıp{" "}
            <code>pnpm --filter @admedic/web user:create</code> çalıştırın.
            Komut çalışma alanı ID'sini verir. Kurulum adımları:
            docs/ad-studio.md.
          </p>
        </details>
      </section>
    </div>
  );
}
