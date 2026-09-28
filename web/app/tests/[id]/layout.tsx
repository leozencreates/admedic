import { sectionMetadata } from "../../_lib/page-meta";

export const generateMetadata = () => sectionMetadata("title.testDetail");

export default function TestDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
