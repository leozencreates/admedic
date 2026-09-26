import { Studio } from "../_components/studio";
import { requirePageActor } from "../_lib/auth";
import { getDraft, type StudioPolicy } from "../_lib/studio-service";
import { DraftSchema } from "@admedic/llm";

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const actor = await requirePageActor();
  const { id } = await searchParams;
  const draft = id ? await getDraft(actor, id) : null;
  return (
    <Studio
      key={id ?? "new"}
      role={actor.role}
      initial={
        draft
          ? {
              id: draft.id,
              version: draft.version,
              status: draft.status,
              content: DraftSchema.parse(draft.content),
              // Sunucu politika sonucu (kural + LLM) istemcide yeniden hesaplanmaz.
              policy: (draft.policy as unknown as StudioPolicy | null) ?? null,
              experimentId: draft.experiment?.id ?? null,
            }
          : null
      }
    />
  );
}
