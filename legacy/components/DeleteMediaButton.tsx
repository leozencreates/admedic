"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteMediaButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!confirm(`"${name}" silinsin mi?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/media/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Silinemedi");
      router.refresh();
    } catch {
      alert("Silme başarısız");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={remove}
      disabled={busy}
      className="text-xs text-red-600 hover:underline disabled:opacity-50"
    >
      Sil
    </button>
  );
}