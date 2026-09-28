import { EDIT_ROLES, requirePageActor } from "../_lib/auth";
import { TestLibrary } from "../_components/test-library";
export default async function TestsPage() {
  const actor = await requirePageActor();
  return <TestLibrary canCreate={EDIT_ROLES.includes(actor.role)} />;
}
