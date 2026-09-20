import { WhatsappSettingsPanel } from "@/components/WhatsappSettingsPanel";

export const dynamic = "force-dynamic";

export default async function WhatsappPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">WhatsApp Entegrasyonu</h1>
        <p className="text-sm text-zinc-500">
          Agent&apos;ın lead&apos;lere otomatik mesaj gönderme ayarları
        </p>
      </div>
      <WhatsappSettingsPanel />
    </div>
  );
}