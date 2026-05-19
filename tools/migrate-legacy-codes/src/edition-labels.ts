/**
 * Edition labels mirror the legacy `jurisdictions.ts` config so the
 * migrated atoms get human-readable edition strings.
 *
 * The tool reads the legacy code_atoms rows' `edition` text column,
 * but the canonical label lives in legacy's jurisdictions.ts. We
 * pin the labels here so the migration is deterministic against
 * whatever string the legacy ingestion happened to write.
 */

import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";

import { buildEditionEntityId } from "./transform.js";
import { buildEditionSlug } from "./slug.js";

export interface JurisdictionMeta {
  key: string;
  displayName: string;
  books: Array<{
    codeBook: string;
    edition: string;
    label: string;
  }>;
}

/**
 * Snapshot of legacy lib/codes/src/jurisdictions.ts. Embedded here so
 * the migration tool does not depend on the legacy workspace
 * package; refresh manually if legacy adds a fourth book.
 */
export const LEGACY_JURISDICTIONS: ReadonlyArray<JurisdictionMeta> = [
  {
    key: "grand_county_ut",
    displayName: "Grand County, UT (Moab)",
    books: [
      {
        codeBook: "IRC_R301_2_1",
        edition: "IRC 2021",
        label: "2021 IRC Table 301.2(1) — Climatic & Geographic Design Criteria",
      },
      {
        codeBook: "IWUIC",
        edition: "IWUIC 2006",
        label: "2006 International Wildland-Urban Interface Code",
      },
      {
        codeBook: "LAND_USE",
        edition: "Land Use Code (rev. 3/21)",
        label: "Grand County Land Use Code (rev. 3/21)",
      },
    ],
  },
  {
    key: "bastrop_tx",
    displayName: "Bastrop, TX",
    books: [
      {
        codeBook: "MUNI_CODE",
        edition: "Code of Ordinances (current supplement)",
        label: "City of Bastrop — Code of Ordinances",
      },
    ],
  },
];

export function buildEditionLabelMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const jurisdiction of LEGACY_JURISDICTIONS) {
    for (const book of jurisdiction.books) {
      const slug = buildEditionSlug(book.codeBook, book.edition);
      const editionId = buildEditionEntityId(jurisdiction.key, slug);
      map.set(`${jurisdiction.key}::${editionId}`, book.label);
    }
  }
  return map;
}

export function buildJurisdictionDisplayNames(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const jurisdiction of LEGACY_JURISDICTIONS) {
    map[jurisdiction.key] = jurisdiction.displayName;
  }
  return map;
}

/**
 * Best-effort edition-label fallback for sections whose
 * `(codeBook, edition)` tuple isn't in the snapshot above (e.g.
 * legacy added a fourth book that we haven't mirrored yet). Returns
 * the raw codeEditionId so we never crash; recommended to refresh
 * LEGACY_JURISDICTIONS instead of relying on the fallback long-term.
 */
export function resolveEditionLabel(
  section: CodeSectionAtomInstance,
  fallback: string,
): string {
  const key = `${section.jurisdictionTenant}::${section.codeEditionId}`;
  return buildEditionLabelMap().get(key) ?? fallback;
}
