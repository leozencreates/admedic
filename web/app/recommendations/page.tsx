import { requirePageActor } from "../_lib/auth";
import { RecommendationLibrary } from "../_components/recommendation-library";
export default async function RecommendationsPage() {
  await requirePageActor();
  return <RecommendationLibrary />;
}
