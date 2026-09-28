import { EDIT_ROLES, requirePageActor } from "../_lib/auth";
import { Library } from "../_components/library";
export default async function LibraryPage() {
  const actor = await requirePageActor();
  return <Library canCreate={EDIT_ROLES.includes(actor.role)} />;
}
