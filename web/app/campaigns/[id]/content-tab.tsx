"use client";
import { useId, useState } from "react";
import { Card, SectionHeading } from "../../_components/ui";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  DraftPicker,
  LINK_TEXT,
  methodName,
  type CampaignData,
  type StudioDraftRow,
} from "../../_lib/campaign-ui";
import { languageName } from "../../_lib/labels";
import type { CampaignAction } from "./types";

interface ContentEditor { selected: string[]; landingUrl: string }

/** Hazırlığın düzenlenebildiği iş akışı durumları (planlayıcıdaki satır hazırlığıyla aynı). */
const PREP_STATUSES = ["DRAFT", "REJECTED", "IN_REVIEW", "APPROVED"];

/**
 * İçerik ve görsel: onaylı reklam içeriği + açılış sayfası bağlama, görsel yükleme/önizleme ve
 * Meta'ya yüklemeden önce tamamlanması gerekenler. Düzenleme yalnızca DRAFT/REJECTED ve düzenleyen rollerde.
 */
export function ContentTab({
  campaign: c,
  canEdit,
  busy,
  approvedDrafts,
  onSaveContent,
  onUploadImage,
}: {
  campaign: CampaignData;
  canEdit: boolean;
  busy: CampaignAction | null;
  approvedDrafts: StudioDraftRow[];
  /** Başarılıysa `true` döner (düzenleyici kapanır). */
  onSaveContent: (draftIds: string[], landingUrl: string) => Promise<boolean>;
  onUploadImage: (file: File | undefined) => void;
}) {
  const [editor, setEditor] = useState<ContentEditor | null>(null);
  const draftsLabelId = useId();
  const editable = ["DRAFT", "REJECTED"].includes(c.workflowStatus) && canEdit;
  const method = c.plan?.conversionMethod ?? "";

  if (!c.plan || !PREP_STATUSES.includes(c.workflowStatus)) {
    return (
      <Card>
        <SectionHeading title="İçerik ve görsel" />
        <p className="text-sm text-ink-2">
          {!c.plan
            ? "Bu kampanya planlayıcıyla oluşturulmadı; reklam içeriği ve görsel bu panelden bağlanmaz."
            : "Kampanya Meta'ya yüklendi; reklam içeriği ve görsel artık bu panelden değiştirilemez."}
        </p>
        {c.content && (
          <p className="mt-2 text-sm text-ink-2">
            Bağlı içerik: {c.content.drafts.map((d) => `${d.name} (${languageName(d.language)})`).join(", ")}
            {c.content.landingUrl ? ` · ${c.content.landingUrl}` : ""}
          </p>
        )}
        {c.imageUrl && (
          <p className="mt-2 text-sm">
            <a href={c.imageUrl} target="_blank" rel="noreferrer" className={LINK_TEXT}>
              Görseli önizle<span className="sr-only"> (yeni sekmede açılır)</span>
            </a>
          </p>
        )}
      </Card>
    );
  }

  async function save() {
    if (!editor) return;
    if (await onSaveContent(editor.selected, editor.landingUrl)) setEditor(null);
  }

  return (
    <Card>
      <SectionHeading title="İçerik ve görsel" description="Meta'ya yüklenecek reklam içeriği, açılış sayfası ve görsel." />
      <div className="space-y-4 text-sm text-ink-2">
        <section aria-labelledby={`${draftsLabelId}-h`} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`${draftsLabelId}-h`} className="font-medium text-ink">
              Reklam içeriği:
            </h3>
            {c.content ? (
              <span>
                {c.content.drafts.map((d) => `${d.name} (${languageName(d.language)})`).join(", ")}
                {c.content.landingUrl ? ` · ${c.content.landingUrl}` : ""}
              </span>
            ) : (
              <span className="text-rose-700">bağlanmadı</span>
            )}
            {editable && !editor && (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setEditor({ selected: c.content?.drafts.map((d) => d.draftId) ?? [], landingUrl: c.content?.landingUrl ?? "" })}
                className={LINK_TEXT}
              >
                {c.content ? "İçeriği değiştir" : "Onaylı içerik seç"}
              </button>
            )}
          </div>
          {editor && (
            <div className="space-y-3 rounded-md border border-line bg-subtle p-3">
              <p id={draftsLabelId} className="text-xs font-medium text-ink">
                Onaylı reklam içerikleri
              </p>
              <DraftPicker
                drafts={approvedDrafts}
                selected={editor.selected}
                onToggle={(id) =>
                  setEditor({ ...editor, selected: editor.selected.includes(id) ? editor.selected.filter((x) => x !== id) : [...editor.selected, id] })
                }
                neededLanguages={c.plan?.languages ?? []}
                labelId={draftsLabelId}
              />
              {method === "landing_form" && (
                <label className="field">
                  Açılış sayfası adresi
                  <input
                    type="url"
                    inputMode="url"
                    placeholder="https://…"
                    value={editor.landingUrl}
                    onChange={(e) => setEditor({ ...editor, landingUrl: e.target.value })}
                  />
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={save} disabled={Boolean(busy)} className={BTN_PRIMARY}>
                  {busy === "content" ? "Bağlanıyor…" : "İçeriği bağla"}
                </button>
                <button type="button" onClick={() => setEditor(null)} className={BTN_SECONDARY}>
                  Vazgeç
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-ink">Görsel:</h3>
          {c.imageHash ? (
            c.imageUrl ? (
              <span>
                yüklendi ·{" "}
                <a href={c.imageUrl} target="_blank" rel="noreferrer" className={LINK_TEXT}>
                  Görseli önizle<span className="sr-only"> (yeni sekmede açılır)</span>
                </a>
              </span>
            ) : (
              <span>yüklendi</span>
            )
          ) : (
            <span className="text-rose-700">yüklenmedi</span>
          )}
          {editable && (
            <>
              {/* Dosya alanı `sr-only`: klavyeyle Tab ile ulaşılır; görünen etiket düğme gibi davranır. */}
              <label
                className={`${BTN_SECONDARY} relative cursor-pointer focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-2 ${busy ? "pointer-events-none opacity-50" : ""}`}
              >
                {busy === "image" ? "Görsel yükleniyor…" : c.imageHash ? "Görseli değiştir" : "Görsel yükle"}
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  className="sr-only"
                  disabled={Boolean(busy)}
                  onChange={(e) => {
                    onUploadImage(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
              <span className="text-xs text-ink-3">JPEG veya PNG, en fazla 3 MB</span>
            </>
          )}
        </section>

        {method && <p className="text-ink-3">Dönüşüm yöntemi: {methodName(method)}</p>}
        {c.readiness && c.readiness.reasons.length > 0 && (
          <div>
            <p className="font-medium text-rose-800">Meta&apos;ya yüklemeden önce tamamlanması gerekenler:</p>
            <ul className="list-inside list-disc text-rose-700">
              {c.readiness.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {c.readiness && c.readiness.warnings.length > 0 && (
          <ul className="list-inside list-disc text-amber-800">
            {c.readiness.warnings.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {c.readiness?.ready && <p className="text-emerald-800">Hazırlık tamam: kampanya Meta&apos;ya eksiksiz yüklenebilir.</p>}
      </div>
    </Card>
  );
}
