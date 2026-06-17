/**
 * Map briefing-source `layerKind` slugs to the briefing section that
 * cites them, per Spec 51 §2 / §1.2:
 *   - B (Threshold Issues): floodplain, wetland, soil, hazard layers
 *   - C (Regulatory Gates): zoning, setback, overlay layers
 *   - D (Site Infrastructure): water, sewer, electric, road layers
 *   - E (Buildable Envelope): parcel, topography, terrain, buildable
 *   - F (Neighboring Context): neighboring-context, adjacent-parcels,
 *     parcel-neighbors
 *
 * Sections A and G cite nothing (Spec 51 §2 — A is the executive
 * summary, G is the next-step checklist). The mapping is intentionally
 * permissive: an unknown `layerKind` slug falls through into a
 * `general` bucket the prompt surfaces under "uncategorized sources"
 * so the engine can still cite them somewhere rather than dropping
 * them on the floor.
 */

import type { BriefingSourceInput } from "./types";

/** Section letters that may cite briefing-sources (per Spec 51 §2). */
export const SECTIONS_WITH_SOURCE_CITATIONS = ["b", "c", "d", "e", "f"] as const;
export type SourceCitingSection = (typeof SECTIONS_WITH_SOURCE_CITATIONS)[number];

/** Sections that never cite anything (Spec 51 §2). */
export const SECTIONS_WITH_NO_CITATIONS = ["a", "g"] as const;

/**
 * Return the section letter (`b`/`c`/`d`/`e`/`f`) that owns a given
 * `layerKind`, or `general` when the slug doesn't map to one of the
 * five citing sections. The mapping uses substring matches so a new
 * federal adapter that emits e.g. `fema-flood-base` lands in section
 * B without a code change here.
 */
export function categorizeLayerKind(
  layerKind: string,
): SourceCitingSection | "general" {
  const lk = layerKind.toLowerCase();
  // B — threshold environmental hazards.
  if (
    lk.includes("flood") ||
    lk.includes("wetland") ||
    lk.includes("soil") ||
    lk.includes("hazard") ||
    lk.includes("snow-load") ||
    lk.includes("seismic")
  ) {
    return "b";
  }
  // C — regulatory gates (zoning + overlays).
  if (
    lk.includes("zoning") ||
    lk.includes("setback") ||
    lk.includes("overlay") ||
    lk.includes("historic") ||
    lk.includes("zone")
  ) {
    return "c";
  }
  // D — site infrastructure utilities.
  if (
    lk.includes("water") ||
    lk.includes("sewer") ||
    lk.includes("electric") ||
    lk.includes("gas") ||
    lk.includes("utility") ||
    lk.includes("road") ||
    lk.includes("street") ||
    lk.includes("transit")
  ) {
    return "d";
  }
  // E — buildable envelope inputs.
  if (
    lk.includes("parcel") &&
    !lk.includes("neighbor") &&
    !lk.includes("adjacent")
  ) {
    return "e";
  }
  if (
    lk.includes("terrain") ||
    lk.includes("topo") ||
    lk.includes("contour") ||
    lk.includes("buildable")
  ) {
    return "e";
  }
  // F — neighboring context.
  if (
    lk.includes("neighbor") ||
    lk.includes("adjacent") ||
    lk.includes("nearby")
  ) {
    return "f";
  }
  return "general";
}

/**
 * Group input sources by the section that should cite them. Returns a
 * record with one bucket per section letter + a `general` bucket for
 * uncategorized layers; every bucket is always present (possibly
 * empty) so callers don't need defensive null checks.
 */
export function groupSourcesBySection(
  sources: ReadonlyArray<BriefingSourceInput>,
): Record<SourceCitingSection | "general", BriefingSourceInput[]> {
  const buckets: Record<
    SourceCitingSection | "general",
    BriefingSourceInput[]
  > = {
    b: [],
    c: [],
    d: [],
    e: [],
    f: [],
    general: [],
  };
  for (const s of sources) {
    buckets[categorizeLayerKind(s.layerKind)].push(s);
  }
  return buckets;
}

/**
 * Build the displayLabel used inside `{{atom|briefing-source|<id>|<label>}}`
 * tokens. Picks the most informative of `provider`/`layerKind` so the
 * inline-reference renderer has something readable to surface.
 */
export function citationLabel(source: BriefingSourceInput): string {
  if (source.provider && source.provider.trim().length > 0) {
    return source.provider.trim();
  }
  return source.layerKind;
}
