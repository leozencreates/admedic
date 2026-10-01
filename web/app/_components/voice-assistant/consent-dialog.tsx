"use client";
import { Dialog } from "../dialog";
import { t, type Language } from "../../_lib/i18n";

/**
 * İlk kullanım aydınlatma ve izin diyaloğu (ADR-0028 §4): ses ve metnin yapay zekâ tarafından, üçüncü taraf
 * ElevenLabs'te işlendiği söylenir. Kabul edilince izin hem tarayıcıda (kullanıcı başına) hem denetim kaydında tutulur.
 */
export function ConsentDialog({
  open,
  lang,
  assistantName,
  busy,
  onAccept,
  onCancel,
}: {
  open: boolean;
  lang: Language;
  assistantName: string;
  busy: boolean;
  onAccept: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={t("assistant.consent.title", lang)}
      description={<p>{t("assistant.consent.intro", lang).replace("{name}", assistantName)}</p>}
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel} autoFocus>
            {t("assistant.consent.cancel", lang)}
          </button>
          <button type="button" className="primary-button" disabled={busy} onClick={onAccept}>
            {t("assistant.consent.accept", lang)}
          </button>
        </>
      }
    >
      <ul className="va-consent__list">
        <li>{t("assistant.consent.processing", lang)}</li>
        <li>{t("assistant.consent.storage", lang)}</li>
        <li>{t("assistant.consent.pii", lang)}</li>
        <li>{t("assistant.consent.limits", lang)}</li>
      </ul>
    </Dialog>
  );
}
