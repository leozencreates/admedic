import Link from "next/link";
import { IntroPanel, PageHeader } from "./ui";

/**
 * Rolün menüde görmediği sayfa doğrudan adresle açıldığında (ADR-0017 rol tablosu): çalışıyor gibi görünen
 * düğmeler yerine açıklama. Yetki API'de ayrıca denetlenir; bu yalnızca arayüz tutarlılığıdır.
 */
export function RoleRestricted({ title }: { title: string }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <IntroPanel
        title="Bu sayfa rolünüz için kapalı"
        action={
          <Link href="/" className="secondary-button">
            Ana sayfaya dön
          </Link>
        }
      >
        Rolünüzün bu sayfada yapabileceği bir iş yok. Erişmeniz gerekiyorsa hesap sahibinden ya da yöneticiden rolünüzü
        değiştirmesini isteyin.
      </IntroPanel>
    </div>
  );
}
