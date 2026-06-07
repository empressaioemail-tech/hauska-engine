/**
 * Federal accessibility standards — Layer 1 product-baseline corpora.
 *
 * Ingested via Path PDF + RawPdfAdapter under the synthetic
 * `federal-accessibility-standards` tenant (ADR-019 model-code-tier:
 * national standards, not jurisdiction-specific). Public DOJ/HUD
 * documents are hosted in full with `public-free` accessPolicy.
 */

import type { PdfNormalizeOptions } from "@hauska-engine/corpus/adapters";

/** Shared tenant for federal accessibility standard editions. */
export const FEDERAL_ACCESSIBILITY_TENANT = "federal-accessibility-standards";

export const ADA_2010_EDITION_LABEL =
  "2010 ADA Standards for Accessible Design";
export const ADA_2010_PDF_URL =
  "https://www.ada.gov/assets/pdfs/2010-design-standards.pdf";

export const FHA_DESIGN_MANUAL_EDITION_LABEL =
  "Fair Housing Act Design Manual (April 1998)";
/** Canonical HUD URL; mirrors also exist on huduser.gov and wbdg.org. */
export const FHA_DESIGN_MANUAL_PDF_URL =
  "https://www.huduser.gov/portal/publications/PDF/FAIRHOUSING/fairfull.pdf";
/** Working mirror when huduser.gov blocks automated fetch. */
export const FHA_DESIGN_MANUAL_PDF_MIRROR_URL =
  "https://www.wbdg.org/FFC/HUD/fairhousing.pdf";

export const FEDERAL_ACCESSIBILITY_NORMALIZE_OPTIONS: PdfNormalizeOptions = {
  headingConvention: "federal-accessibility",
};
