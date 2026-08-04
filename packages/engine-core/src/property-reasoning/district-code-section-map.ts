/**
 * Per-jurisdiction static map: district code -> code-section AtomInputRefs.
 *
 * Distinct from `setbackTable` (dimensional VALUE source). This map cites
 * the NARRATIVE code sections that define a district's requirements and
 * permitted-use table, for provenance display on the zoning-fact atom
 * (WDLL district-requirements citation, 2026-08). Absence of an entry is
 * always honest-absence — no atom fields invented for unmapped jurisdictions
 * or districts.
 *
 * Keyed by JurisdictionDescriptor.key (e.g. "bastrop_tx"), not
 * jurisdictionTenant, which varies by data domain within a jurisdiction.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { AtomInputRef } from "@empressaio/atom-contract/property";

export interface DistrictCodeSectionRefs {
  /** Narrative code section defining the district's dimensional/use character. */
  districtRequirements: AtomInputRef;
  /** Narrative code section holding the district's permitted-use table. */
  permittedUseTable: AtomInputRef;
}

function codeSectionRef(entityId: string): AtomInputRef {
  return {
    atomDid: buildAtomDid("code-section", entityId).raw,
    role: "rule",
    entityType: "code-section",
  };
}

/**
 * bastrop_tx — Bastrop Development Code (Ord. 2026-06), current adopted
 * edition `bastrop_tx-bdc-2026-adopted`. Both sections verified present in
 * services/retrieval-api/corpus/snapshot.json (entityIds
 * `bastrop_tx-bdc-2026-adopted/14-02-003` "District Requirements" and
 * `bastrop_tx-bdc-2026-adopted/14-02-008` "Table of Permitted Uses").
 * District roster is the full layer-23 ZoneTypeClass enumeration
 * (packages/adapters/src/local/setbacks/bastrop-per-parcel-record.ts
 * BASTROP_ZONE_TYPE_CLASS) — every district the per-parcel record can stamp,
 * not only the districts with flat Euclidean setback scalars.
 */
const BASTROP_TX_DISTRICT_REQUIREMENTS = codeSectionRef(
  "bastrop_tx-bdc-2026-adopted/14-02-003",
);
const BASTROP_TX_PERMITTED_USE_TABLE = codeSectionRef(
  "bastrop_tx-bdc-2026-adopted/14-02-008",
);

const BASTROP_TX_DISTRICT_CODES: ReadonlyArray<string> = [
  "P/OS",
  "RR",
  "SF-1",
  "SF-2",
  "SF-3",
  "MU",
  "GC",
  "PI",
  "IND",
  "PDD",
];

const BASTROP_TX_MAP: Readonly<Record<string, DistrictCodeSectionRefs>> =
  Object.fromEntries(
    BASTROP_TX_DISTRICT_CODES.map((code) => [
      code,
      {
        districtRequirements: BASTROP_TX_DISTRICT_REQUIREMENTS,
        permittedUseTable: BASTROP_TX_PERMITTED_USE_TABLE,
      },
    ]),
  );

/**
 * elgin_tx — Elgin Code of Ordinances (current supplement), edition
 * `elgin_tx/elgin-code-of-ordinances-current-supplement` (entityId uses a
 * SLASH between jurisdiction and edition slug — confirmed against the live
 * corpus; this differs from bastrop_tx's BDC edition, which uses a DASH
 * separator (`bastrop_tx-bdc-2026-adopted`). Verified present in
 * services/retrieval-api/corpus/snapshot.json: 266 elgin_tx code-section
 * atoms, DID-grep-verified 2026-08-03 onboarding pass).
 *
 * Structural difference from bastrop_tx: Elgin's Chapter 46 gives EACH
 * district its OWN "Uses permitted" section (46-231, 46-263, 46-301, 46-332,
 * 46-362, 46-390, 46-416, 46-440) rather than one shared permitted-use table
 * (Bastrop's single 14-02-008) — so permittedUseTable is per-district here,
 * not a single shared ref reused across all codes. districtRequirements
 * points at each district's own "Area regulations" section (46-233, 46-265,
 * 46-303, 46-333, 46-363, 46-391, 46-417, 46-441). District roster is the 8
 * districts named in Sec. 46-203 (R-1..R-4, C-1..C-3, I) — the same roster
 * carried on the ELGIN_REGISTRY_ROW railPerParcel.districtValueByPrefix keys
 * (registry/jurisdiction-registry.ts), using the canonical "R-4" name (the
 * GIS layer's "A" domain value is a registry-row-level Zone_Code mapping
 * concern, not a code-section-citation concern — this map is keyed on the
 * canonical district code).
 */
function elginCodeSectionRef(sectionNumber: string): AtomInputRef {
  return codeSectionRef(
    `elgin_tx/elgin-code-of-ordinances-current-supplement/${sectionNumber}`,
  );
}

const ELGIN_TX_MAP: Readonly<Record<string, DistrictCodeSectionRefs>> = {
  "R-1": {
    districtRequirements: elginCodeSectionRef("46-233"),
    permittedUseTable: elginCodeSectionRef("46-231"),
  },
  "R-2": {
    districtRequirements: elginCodeSectionRef("46-265"),
    permittedUseTable: elginCodeSectionRef("46-263"),
  },
  "R-3": {
    districtRequirements: elginCodeSectionRef("46-303"),
    permittedUseTable: elginCodeSectionRef("46-301"),
  },
  "R-4": {
    districtRequirements: elginCodeSectionRef("46-333"),
    permittedUseTable: elginCodeSectionRef("46-332"),
  },
  "C-1": {
    districtRequirements: elginCodeSectionRef("46-363"),
    permittedUseTable: elginCodeSectionRef("46-362"),
  },
  "C-2": {
    districtRequirements: elginCodeSectionRef("46-391"),
    permittedUseTable: elginCodeSectionRef("46-390"),
  },
  "C-3": {
    districtRequirements: elginCodeSectionRef("46-417"),
    permittedUseTable: elginCodeSectionRef("46-416"),
  },
  I: {
    districtRequirements: elginCodeSectionRef("46-441"),
    permittedUseTable: elginCodeSectionRef("46-440"),
  },
};

/** Jurisdiction key -> district code -> code-section refs. Seed: bastrop_tx, elgin_tx. */
const DISTRICT_CODE_SECTION_MAP: Readonly<
  Record<string, Readonly<Record<string, DistrictCodeSectionRefs>>>
> = {
  bastrop_tx: BASTROP_TX_MAP,
  elgin_tx: ELGIN_TX_MAP,
};

/**
 * Look up district code-section refs for a jurisdiction. Returns undefined
 * for any unmapped jurisdiction or district — callers must emit exactly as
 * if no map existed (no invented refs).
 */
export function lookupDistrictCodeSectionRefs(
  jurisdictionKey: string,
  districtCode: string,
): DistrictCodeSectionRefs | undefined {
  const jurisdictionMap = DISTRICT_CODE_SECTION_MAP[jurisdictionKey];
  if (!jurisdictionMap) return undefined;
  return jurisdictionMap[districtCode.trim()];
}
