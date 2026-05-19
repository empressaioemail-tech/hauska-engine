/**
 * Map legacy `code_atom_sources.source_name` values onto a hauska-engine
 * `sourceAdapter` identifier.
 *
 * Per the recon's provenance-honesty trade-off, migrated atoms get a
 * `legacy/` prefix so they don't masquerade as native Stream 1A
 * ingestion. When a jurisdiction is re-ingested via the live
 * `MunicodeHtmlAdapter` / `ECode360Adapter` etc., the new atoms carry
 * the unprefixed adapter name; content-hash dedup folds them in
 * cleanly, and the per-atom `sourceAdapter` field records which path
 * each atom came in via.
 */

export const LEGACY_SOURCE_ADAPTER_MAP: Record<string, string> = {
  // Bastrop Code of Ordinances on Municode (JSON envelope, in-process scrape).
  bastrop_municode: "legacy/bastrop-municode",
  // Grand County IRC R301.2(1) HTML one-off page.
  grand_county_html: "legacy/grand-county-html-r301",
  // Grand County IWUIC PDF.
  grand_county_pdf: "legacy/grand-county-pdf-iwuic",
  // Grand County Land Use Code on codepublishing.com.
  grand_county_landuse_html: "legacy/code-publishing-html-landuse",
};

export function resolveSourceAdapter(sourceName: string): string {
  return LEGACY_SOURCE_ADAPTER_MAP[sourceName] ?? `legacy/${sourceName}`;
}
