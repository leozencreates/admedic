import { guardedSection, sectionMetadata } from "../_lib/page-meta";

export const generateMetadata = () => sectionMetadata("nav.recommendations");
export default guardedSection("/recommendations");
