import Link from "next/link";
import { connection } from "next/server";
import { Card, IntroPanel, PageHeader, SectionHeading } from "../_components/ui";
import { requirePageActor } from "../_lib/auth";
import { configChecks, endToEndChecks } from "../_lib/go-live";
import { CheckList } from "./check-list";
import { MetaCheck } from "./meta-check";

/**
 * Canlıya geçiş (ADR-0023): sunucu yapılandırması, Meta bağlantısının canlı denetimi ve gerçek hesapta
 * uçtan uca kanıtlar. Yalnızca hesap sahibi (menü ve API).
 */
export default async function GoLivePage() {
  await connection();
  const actor = await requirePageActor("/go-live");
  if (actor.role !== "OWNER")
    return (
      <div className="space-y-6">
        <PageHeader title="Canlıya geçiş" />
        <IntroPanel title="Bu sayfa yalnızca hesap sahibine açık">
          Canlıya geçiş denetimi sunucu ayarlarını ve Meta bağlantısını inceler; hesap sahibi kullanır.
        </IntroPanel>
      </div>
    );
  const [config, e2e] = await Promise.all([configChecks(), endToEndChecks(actor.orgId)]);
  const blockers = config.filter((c) => c.status === "fail").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Canlıya geçiş"
        description={
          blockers
            ? `Canlıya geçmeden önce giderilmesi gereken ${blockers} engel var.`
            : "Sunucu ayarları hazır. Meta bağlantısını denetleyin ve uçtan uca denemeyi tamamlayın."
        }
        crumbs={[{ label: "Ayarlar" }]}
      />

      <Card>
        <SectionHeading
          title="1. Sunucu ayarları"
          description="Ortam değişkenlerinin varlığı ve biçimi denetlenir; değerleri gösterilmez."
        />
        <CheckList checks={config} />
      </Card>

      <Card>
        <SectionHeading
          title="2. Meta bağlantısı"
          description="Erişim anahtarı, izinler, reklam hesapları ve sayfa, piksel, WhatsApp eşlemeleri canlı olarak okunur."
        />
        <MetaCheck />
      </Card>

      <Card>
        <SectionHeading
          title="3. Uçtan uca deneme"
          description="Gerçek hesapta sırayla yapılır. Kampanya kapalı (PAUSED) yüklenir; etkinleştirilmedikçe harcama olmaz."
        />
        {e2e.live ? (
          <CheckList checks={e2e.checks} />
        ) : (
          <p className="text-sm text-ink-2">
            Deneme modunda gerçek olaylar oluşmaz; bu adımlar canlı modda izlenir.
          </p>
        )}
        <p className="mt-3 text-sm text-ink-2">
          Adımların ayrıntısı: <Link className="text-link" href="/meta-connections">Meta bağlantıları</Link>,{" "}
          <Link className="text-link" href="/campaign-planner">Yeni kampanya</Link>,{" "}
          <Link className="text-link" href="/leads">Lead&apos;ler</Link>. Kurulum kılavuzu depoda{" "}
          <code>docs/runbook.md</code>.
        </p>
      </Card>
    </div>
  );
}
