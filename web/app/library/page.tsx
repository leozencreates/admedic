import { requirePageActor } from "../_lib/auth";
import { Library } from "../_components/library";
export default async function LibraryPage() {
  await requirePageActor();
  return <Library />;
}
