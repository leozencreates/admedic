import { guardedSection, sectionMetadata } from "../_lib/page-meta";

export const generateMetadata = () => sectionMetadata("nav.billing");
export default guardedSection("/billing");
