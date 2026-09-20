import { Experiment } from "../_components/experiment";

export default async function ExperimentsPage({
  searchParams,
}: {
  searchParams: Promise<{ duration?: string }>;
}) {
  const params = await searchParams;
  const duration = Number(params.duration);
  return (
    <Experiment
      initialDuration={
        Number.isSafeInteger(duration) && duration >= 1 && duration <= 90
          ? duration
          : 7
      }
    />
  );
}
