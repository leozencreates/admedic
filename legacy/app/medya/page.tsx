import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";
import { UploadMediaForm } from "@/components/UploadMediaForm";
import { DeleteMediaButton } from "@/components/DeleteMediaButton";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function MedyaPage() {
  const clinic = await getCurrentClinic();
  const assets = await prisma.mediaAsset.findMany({
    where: { clinicId: clinic.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Medya Kütüphanesi</h1>
        <p className="text-sm text-zinc-500">
          Kliniğin fotoğraf ve videoları — WhatsApp takibinde otomatik paylaşılır
        </p>
      </div>

      <div className="max-w-xl">
        <UploadMediaForm />
      </div>

      {assets.length === 0 ? (
        <p className="rounded-xl border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500">
          Henüz medya yok. Yukarıdan ilk görseli veya videoyu yükleyin.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {assets.map((a) => (
            <div
              key={a.id}
              className="overflow-hidden rounded-xl border border-zinc-200 bg-white"
            >
              <div className="aspect-video bg-zinc-100">
                {a.type === "VIDEO" ? (
                  <video src={a.url} className="h-full w-full object-cover" muted />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.url} alt={a.name} className="h-full w-full object-cover" />
                )}
              </div>
              <div className="p-3">
                <p className="truncate text-sm font-medium">{a.name}</p>
                <p className="text-xs text-zinc-500">
                  {a.type} · {formatDateTime(a.createdAt)}
                </p>
                <div className="mt-2 flex justify-between">
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-teal-700 hover:underline"
                  >
                    Aç
                  </a>
                  <DeleteMediaButton id={a.id} name={a.name} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}