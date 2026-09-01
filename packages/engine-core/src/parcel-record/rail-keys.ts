/**
 * Closed parcel-record rail set — derived, not hand-authored.
 *
 * v1 (52): PARCEL-RECORD card 2026-09-01.
 * v2 (65): decision 2026-09-01_parcel_record_rails_v2_template. Every aspired
 * data point gets a named rail now; declared-ahead rails stay unaccounted
 * until sourced. Access is written on every row — owner is paid-tier
 * explicitly, never inherited.
 */

import {
  OWNER_RAIL_ACCESS,
  PUBLIC_RAIL_ACCESS,
  type RailAccessPair,
} from "./access-pair.js";

export const PARCEL_RECORD_RAIL_META = [
  // --- CAD and identity (dispatch seed + CAD-SERVE additions) ---
  { key: "apn", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "situsAddress", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "situsCity", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "situsState", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "situsZip", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "landUseCode", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "landUseDescription", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "landUseSource", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "landUseVintage", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "acreageAcres", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "acreageSqft", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "acreageMethod", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "yearBuilt", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "marketValue", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "assessedValue", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "landValue", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "improvementValue", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "livingAreaSqft", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "legalDescription", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },
  { key: "exemptionCodes", grain: "scalar", group: "cad", access: PUBLIC_RAIL_ACCESS },

  // --- Jurisdiction ---
  { key: "countyFips", grain: "scalar", group: "jurisdiction", access: PUBLIC_RAIL_ACCESS },
  { key: "cityLimits", grain: "scalar", group: "jurisdiction", access: PUBLIC_RAIL_ACCESS },
  { key: "etjStatus", grain: "scalar", group: "jurisdiction", access: PUBLIC_RAIL_ACCESS },
  { key: "schoolDistrict", grain: "scalar", group: "jurisdiction", access: PUBLIC_RAIL_ACCESS },

  // --- Zoning and envelope (Tier1 zoning + Tier2 envelope fields) ---
  { key: "zoningDistrict", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "zoningJurisdictionKey", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "zoningProvenance", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "envelopeStatus", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "setbackFrontFt", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "setbackSideFt", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "setbackRearFt", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "setbackCornerFt", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "parcelAreaSqFt", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "buildableAreaSqFt", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "buildableAreaPct", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "maxLotCoveragePct", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "maxHeightFt", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "maxFootprintSqFt", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "citationUrl", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "envelopeDisclosure", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "edgeSignal", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "maxImperviousCoverPct", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },
  { key: "treeProtection", grain: "scalar", group: "zoning-envelope", access: PUBLIC_RAIL_ACCESS },

  // --- Companion-bearing rails ---
  { key: "setbackRules", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "wells", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "pipelines", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "permits", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "easements", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "buildingFootprint", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "specialDistricts", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "flood", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "owner", grain: "companion", group: "companion", access: OWNER_RAIL_ACCESS },
  { key: "valueHistory", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "salesHistory", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "publicRecordRefs", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "ossf", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "utilityService", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "agValuation", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "mineralRights", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "hoaDeedRestrictions", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },
  { key: "overlayDistricts", grain: "companion", group: "companion", access: PUBLIC_RAIL_ACCESS },

  // --- Added from county rail register (parcel serve shape, not the 14-column grid) ---
  { key: "parcelGeometry", grain: "companion", group: "spine", access: PUBLIC_RAIL_ACCESS },
  { key: "roads", grain: "companion", group: "spine", access: PUBLIC_RAIL_ACCESS },
  { key: "terrain", grain: "companion", group: "spine", access: PUBLIC_RAIL_ACCESS },
  { key: "railCorridor", grain: "companion", group: "spine", access: PUBLIC_RAIL_ACCESS },
] as const;

export type ParcelRecordRailKey =
  (typeof PARCEL_RECORD_RAIL_META)[number]["key"];

export type ScalarRailKey = Extract<
  (typeof PARCEL_RECORD_RAIL_META)[number],
  { grain: "scalar" }
>["key"];

export type CompanionRailKey = Extract<
  (typeof PARCEL_RECORD_RAIL_META)[number],
  { grain: "companion" }
>["key"];

export const PARCEL_RECORD_RAIL_KEYS: readonly ParcelRecordRailKey[] =
  PARCEL_RECORD_RAIL_META.map((r) => r.key);

export const PARCEL_RECORD_SCALAR_RAIL_KEYS = PARCEL_RECORD_RAIL_META.filter(
  (r) => r.grain === "scalar",
).map((r) => r.key) as ScalarRailKey[];

export const PARCEL_RECORD_COMPANION_RAIL_KEYS = PARCEL_RECORD_RAIL_META.filter(
  (r) => r.grain === "companion",
).map((r) => r.key) as CompanionRailKey[];

/** Scalar + envelope facet rails from Tier1/Tier2 serve shape, including v2 scalars. */
export const ZONING_ENVELOPE_RAIL_KEYS = PARCEL_RECORD_RAIL_META.filter(
  (r) => r.group === "zoning-envelope",
).map((r) => r.key) as readonly ParcelRecordRailKey[];

/**
 * Frozen at the v1 members. MUST NOT derive from ZONING_ENVELOPE_RAIL_KEYS —
 * the two v2 zoning-envelope scalars (maxImperviousCoverPct, treeProtection)
 * would silently join and become not-applicable on unincorporated parcels.
 * 17 v1 zoning-envelope rails + setbackRules.
 */
export const UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS: readonly ParcelRecordRailKey[] = [
  "zoningDistrict",
  "zoningJurisdictionKey",
  "zoningProvenance",
  "envelopeStatus",
  "setbackFrontFt",
  "setbackSideFt",
  "setbackRearFt",
  "setbackCornerFt",
  "parcelAreaSqFt",
  "buildableAreaSqFt",
  "buildableAreaPct",
  "maxLotCoveragePct",
  "maxHeightFt",
  "maxFootprintSqFt",
  "citationUrl",
  "envelopeDisclosure",
  "edgeSignal",
  "setbackRules",
];

/** The 13 rails declared ahead in v2. Start unaccounted everywhere. */
export const RAILS_V2_DECLARED_AHEAD: readonly ParcelRecordRailKey[] = [
  "owner",
  "valueHistory",
  "salesHistory",
  "publicRecordRefs",
  "ossf",
  "utilityService",
  "agValuation",
  "mineralRights",
  "hoaDeedRestrictions",
  "overlayDistricts",
  "schoolDistrict",
  "maxImperviousCoverPct",
  "treeProtection",
];

export const PARCEL_RECORD_RAIL_COUNT = PARCEL_RECORD_RAIL_KEYS.length;

/** Keys added beyond the v1 dispatch card seed list (v1 extras, not the v2 13). */
export const RAILS_ADDED_BEYOND_SEED: readonly ParcelRecordRailKey[] = [
  "situsState",
  "legalDescription",
  "exemptionCodes",
  "parcelGeometry",
  "roads",
  "terrain",
  "railCorridor",
  "setbackCornerFt",
  "envelopeStatus",
  "zoningProvenance",
] as const;

export function isCompanionRail(key: ParcelRecordRailKey): key is CompanionRailKey {
  return (PARCEL_RECORD_COMPANION_RAIL_KEYS as readonly string[]).includes(key);
}

export function isScalarRail(key: ParcelRecordRailKey): key is ScalarRailKey {
  return (PARCEL_RECORD_SCALAR_RAIL_KEYS as readonly string[]).includes(key);
}

export function railAccess(key: ParcelRecordRailKey): RailAccessPair {
  const row = PARCEL_RECORD_RAIL_META.find((r) => r.key === key);
  if (!row) {
    throw new Error(`parcel-record rail metadata missing for ${key}`);
  }
  return row.access;
}
