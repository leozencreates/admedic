import { guardedSection, sectionMetadata } from "../_lib/page-meta";

export const generateMetadata = () => sectionMetadata("nav.experiments");
export default guardedSection("/experiments");
