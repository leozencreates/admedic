import { requirePageActor } from "../_lib/auth";
import { TestLibrary } from "../_components/test-library";
export default async function TestsPage() {
  await requirePageActor();
  return <TestLibrary />;
}
