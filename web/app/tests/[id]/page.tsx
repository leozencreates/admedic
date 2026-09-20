import { requirePageActor } from "../../_lib/auth";
import { getExperiment } from "../../_lib/studio-service";
import { TestDetail } from "../../_components/test-detail";
import { DraftSchema } from "@admedic/llm";
import type { Metrics } from "../../_lib/experiment";
export default async function TestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requirePageActor();
  const experiment = await getExperiment(actor, (await params).id);
  return (
    <TestDetail
      initial={{
        id: experiment.id,
        version: experiment.version,
        status: experiment.status,
        elapsedDays: experiment.elapsedDays,
        metrics: experiment.metrics as Metrics[],
        snapshot: DraftSchema.parse(experiment.snapshot),
      }}
      canEdit={["OWNER", "ADMIN", "MEDIA_BUYER"].includes(actor.role)}
    />
  );
}
