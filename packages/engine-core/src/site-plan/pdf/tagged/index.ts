/**
 * Tagged-PDF layer (Revised Section 508, 504.2.2). Additive and opt-in: no
 * module outside this directory imports it, and the default site-plan and
 * dossier exports are byte-for-byte what they were before it existed.
 */
export {
  ContentStreamRefusal,
  groupGlyphRuns,
  parseContentStream,
  rewriteContentStream,
  type RewriteResult,
  type Segment,
  type TextBlock,
} from "./content-stream.js";
export {
  READING_ORDER_BAND_PT,
  countReadingOrderInversions,
  orderForReading,
  type Positioned,
} from "./reading-order.js";
export { tagPdfBytes, type TagPdfOptions, type TagPdfResult } from "./tag-pdf.js";
export {
  SITE_PLAN_LANGUAGE,
  emitTaggedPdfSitePlan,
  sitePlanDocumentTitle,
  type TaggedSitePlanResult,
} from "./emit-site-plan.js";
