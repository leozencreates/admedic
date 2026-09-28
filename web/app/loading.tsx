export default function Loading() {
  return (
    <div className="space-y-5" role="status" aria-label="Sayfa yükleniyor">
      {/* Kompakt sayfa başlığı iskeleti (K6-B): başlık + tek satır açıklama; tanıtım bandı yok. */}
      <div className="space-y-2">
        <div className="h-7 w-56 animate-pulse rounded-lg bg-slate-200/60" />
        <div className="h-4 w-80 max-w-full animate-pulse rounded-lg bg-slate-200/60" />
      </div>
      <div className="grid grid-cols-2 gap-5">
        <div className="h-64 animate-pulse rounded-3xl bg-white" />
        <div className="h-64 animate-pulse rounded-3xl bg-white" />
      </div>
      <p className="text-sm text-muted">Çalışma alanı yükleniyor…</p>
    </div>
  );
}
