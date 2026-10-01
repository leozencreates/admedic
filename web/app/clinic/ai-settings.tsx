"use client";
import { useEffect, useState } from "react";
import { api } from "../_lib/client-api";
import { Card, SectionHeading } from "../_components/ui";

interface AiSettings {
  voiceAutoCallEnabled: boolean;
  assistantExamplesEnabled: boolean;
}

/**
 * Yapay zekâ ayarları: otomatik sesli arama (ADR-0026) ve asistana örnek konuşmalar (ADR-0027).
 * İkisi de varsayılan olarak kapalıdır; yetki sunucuda denetlenir (otomatik aramayı yalnızca hesap sahibi açar).
 */
export function AiSettingsCard() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api<{ settings: AiSettings }>("/api/org/settings")
      .then((data) =>
        setSettings({
          voiceAutoCallEnabled: data.settings.voiceAutoCallEnabled === true,
          assistantExamplesEnabled: data.settings.assistantExamplesEnabled === true,
        }),
      )
      .catch(() => setError("Ayarlar yüklenemedi. Sayfayı yenileyin."));
  }, []);

  async function update(patch: Partial<AiSettings>) {
    if (!settings) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/org/settings", "PATCH", patch);
      setSettings({ ...settings, ...patch });
      setNotice("Ayar kaydedildi.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ayar kaydedilemedi. Tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionHeading
        title="Yapay zekâ ayarları"
        description="İki ayar da kapalı başlar. Açmadan önce hastalara verdiğiniz aydınlatma metninin bu kullanımları kapsadığından emin olun."
      />
      {settings ? (
        <div className="mt-4 space-y-4">
          <label className="flex items-start gap-3 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-1"
              checked={settings.voiceAutoCallEnabled}
              disabled={busy}
              onChange={(e) => void update({ voiceAutoCallEnabled: e.target.checked })}
            />
            <span>
              <span className="font-medium">Sesli asistan müsait lead&apos;leri kendiliğinden arasın</span>
              <span className="mt-1 block text-ink-2">
                Yalnızca telefonla aranma rızası kayıtlı, koordinatörün devralmadığı lead&apos;ler; lead&apos;in yerel
                saatiyle 09:00–20:00 arasında, en fazla 3 kez aranır. Kapalıyken arama yalnızca lead sayfasındaki
                düğmeyle başlar. Bu ayarı yalnızca hesap sahibi açabilir.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-1"
              checked={settings.assistantExamplesEnabled}
              disabled={busy}
              onChange={(e) => void update({ assistantExamplesEnabled: e.target.checked })}
            />
            <span>
              <span className="font-medium">Randevuya dönüşen Instagram konuşmaları asistana örnek olsun</span>
              <span className="mt-1 block text-ink-2">
                Karşılama asistanı, randevuyla sonuçlanan Instagram konuşmalarında ekibinizin yazdığı yanıtları üslup
                örneği olarak görür. Hastaların yazdıkları, adları ve iletişim bilgileri örneklere girmez.
              </span>
            </span>
          </label>
        </div>
      ) : !error ? (
        <p className="mt-4 text-sm text-muted">Yükleniyor…</p>
      ) : null}
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </p>
      )}
      <p role="status" className={notice ? "mt-3 text-sm text-emerald-800" : "sr-only"}>
        {notice}
      </p>
    </Card>
  );
}
