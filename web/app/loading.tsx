export default function Loading() {
  return (
    <div className="space-y-5" role="status" aria-label="Sayfa yükleniyor">
      <div className="h-48 animate-pulse rounded-3xl bg-violet-100" />
      <div className="grid grid-cols-2 gap-5">
        <div className="h-64 animate-pulse rounded-3xl bg-white" />
        <div className="h-64 animate-pulse rounded-3xl bg-white" />
      </div>
      <p className="text-sm text-slate-500">Çalışma alanı yükleniyor…</p>
    </div>
  );
}
