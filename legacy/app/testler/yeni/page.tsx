import { CreateTestForm } from "@/components/CreateTestForm";

export const dynamic = "force-dynamic";

export default async function YeniTestPage({
  searchParams,
}: {
  searchParams: Promise<{ kampanya?: string }>;
}) {
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Yeni A/B Testi</h1>
        <p className="text-sm text-zinc-500">
          Varyantlar eşit bütçeyle başlar; agent ROAS&apos;a göre bütçeyi kazanan
          varyanta kaydırır.
        </p>
      </div>
      <CreateTestForm initialCampaignId={sp.kampanya ?? undefined} />
    </div>
  );
}