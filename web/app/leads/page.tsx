import { MessagesSquare } from "lucide-react";

/** Gelen kutusunda lead seçilmemişken sağ bölme (masaüstü). Telefonda bu bölme gizlidir; liste tam ekrandır. */
export default function LeadsIndexPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <MessagesSquare size={32} strokeWidth={1.5} aria-hidden="true" className="text-ink-3" />
      <p className="font-medium text-ink">Bir lead seçin</p>
      <p className="max-w-sm text-sm text-ink-2">
        Soldaki listeden bir lead seçtiğinizde konuşma ve lead bilgileri burada açılır. Yanıt bekleyenler en uzun
        bekleyenden başlayarak sıralanır.
      </p>
    </div>
  );
}
