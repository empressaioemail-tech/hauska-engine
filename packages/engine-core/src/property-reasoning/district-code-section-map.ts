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

/** Jurisdiction key -> district code -> code-section refs. Seed: bastrop_tx only. */
const DISTRICT_CODE_SECTION_MAP: Readonly<
  Record<string, Readonly<Record<string, DistrictCodeSectionRefs>>>
> = {
  bastrop_tx: BASTROP_TX_MAP,
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
