"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "../_lib/client-api";
export function Account() {
  const pathname = usePathname();
  const router = useRouter();
  const [actor, setActor] = useState<{
    workspaceName: string;
    role: string;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ actor: typeof actor }>("/api/session")
      .then((data) => {
        if (active) setActor(data.actor);
      })
      .catch(() => {
        if (active) setActor(null);
      });
    return () => {
      active = false;
    };
  }, [pathname]);
  async function logout() {
    try {
      await api("/api/session", "DELETE");
      setActor(null);
      router.push("/login");
      router.refresh();
    } catch {
      setError("Çıkış yapılamadı. Tekrar deneyin.");
    }
  }
  return (
    <div className="border-t border-white/10 pt-5 text-xs text-slate-400">
      {actor ? (
        <>
          <p className="text-sm text-white">{actor.workspaceName}</p>
          <p className="my-2">{actor.role}</p>
          <button onClick={logout} className="text-violet-300">
            Oturumu kapat →
          </button>
        </>
      ) : (
        <Link href="/login" className="text-violet-300">
          Oturum aç →
        </Link>
      )}
      <p role="alert">{error}</p>
    </div>
  );
}
