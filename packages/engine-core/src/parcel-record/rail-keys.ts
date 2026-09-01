/**
 * Closed parcel-record rail set — derived, not hand-authored.
 *
 * Sources (2026-09-01 PARCEL-RECORD card):
 *   - Tier1FacetPayload / BaseFacts (LDT nodeFacetBakeTier1Cli.ts)
 *   - Tier2EnvelopeFacet (LDT nodeFacetBakeTier2.ts)
 *   - COUNTY_RAIL_DECLARATION (LDT countyRailDimension.ts) — parcel grain, not county grid
 *   - CAD-SERVE-RECONCILE close (_inbox/2026-09-01_cad-serve-reconcile_close.json)
 *   - Dispatch seed list (floor, not ceiling)
 *
 * Owner is EXCLUDED — public-free roll bodies stripped 2026-09-01; owner-fact is paid.
 * MUD is NOT a separate rail — specialDistricts carries MUD/PUD/WCID/etc.
 */

export const PARCEL_RECORD_RAIL_META = [
  // --- CAD and identity (dispatch seed + CAD-SERVE additions) ---
  { key: "apn", grain: "scalar", group: "cad" },
  { key: "situsAddress", grain: "scalar", group: "cad" },
  { key: "situsCity", grain: "scalar", group: "cad" },
  { key: "situsState", grain: "scalar", group: "cad" },
  { key: "situsZip", grain: "scalar", group: "cad" },
  { key: "landUseCode", grain: "scalar", group: "cad" },
  { key: "landUseDescription", grain: "scalar", group: "cad" },
  { key: "landUseSource", grain: "scalar", group: "cad" },
  { key: "landUseVintage", grain: "scalar", group: "cad" },
  { key: "acreageAcres", grain: "scalar", group: "cad" },
  { key: "acreageSqft", grain: "scalar", group: "cad" },
  { key: "acreageMethod", grain: "scalar", group: "cad" },
  { key: "yearBuilt", grain: "scalar", group: "cad" },
  { key: "marketValue", grain: "scalar", group: "cad" },
  { key: "assessedValue", grain: "scalar", group: "cad" },
  { key: "landValue", grain: "scalar", group: "cad" },
  { key: "improvementValue", grain: "scalar", group: "cad" },
  { key: "livingAreaSqft", grain: "scalar", group: "cad" },
  /** Added beyond dispatch seed — CAD-SERVE derivedFieldList. */
  { key: "legalDescription", grain: "scalar", group: "cad" },
  /** Added beyond dispatch seed — CAD-SERVE derivedFieldList. */
  { key: "exemptionCodes", grain: "scalar", group: "cad" },

  // --- Jurisdiction ---
  { key: "countyFips", grain: "scalar", group: "jurisdiction" },
  { key: "cityLimits", grain: "scalar", group: "jurisdiction" },
  { key: "etjStatus", grain: "scalar", group: "jurisdiction" },

  // --- Zoning and envelope (Tier1 zoning + Tier2 envelope fields) ---
  { key: "zoningDistrict", grain: "scalar", group: "zoning-envelope" },
  { key: "zoningJurisdictionKey", grain: "scalar", group: "zoning-envelope" },
  { key: "zoningProvenance", grain: "scalar", group: "zoning-envelope" },
  { key: "envelopeStatus", grain: "scalar", group: "zoning-envelope" },
  { key: "setbackFrontFt", grain: "scalar", group: "zoning-envelope" },
  { key: "setbackSideFt", grain: "scalar", group: "zoning-envelope" },
  { key: "setbackRearFt", grain: "scalar", group: "zoning-envelope" },
  { key: "setbackCornerFt", grain: "scalar", group: "zoning-envelope" },
  { key: "parcelAreaSqFt", grain: "scalar", group: "zoning-envelope" },
  { key: "buildableAreaSqFt", grain: "scalar", group: "zoning-envelope" },
  { key: "buildableAreaPct", grain: "scalar", group: "zoning-envelope" },
  { key: "maxLotCoveragePct", grain: "scalar", group: "zoning-envelope" },
  { key: "maxHeightFt", grain: "scalar", group: "zoning-envelope" },
  { key: "maxFootprintSqFt", grain: "scalar", group: "zoning-envelope" },
  { key: "citationUrl", grain: "scalar", group: "zoning-envelope" },
  { key: "envelopeDisclosure", grain: "scalar", group: "zoning-envelope" },
  { key: "edgeSignal", grain: "scalar", group: "zoning-envelope" },

  // --- Companion-bearing rails ---
  { key: "setbackRules", grain: "companion", group: "companion" },
  { key: "wells", grain: "companion", group: "companion" },
  { key: "pipelines", grain: "companion", group: "companion" },
  { key: "permits", grain: "companion", group: "companion" },
  { key: "easements", grain: "companion", group: "companion" },
  { key: "buildingFootprint", grain: "companion", group: "companion" },
  /** MUD/PUD/WCID/etc. — one rail; MUD is not duplicated. */
  { key: "specialDistricts", grain: "companion", group: "companion" },
  { key: "flood", grain: "companion", group: "companion" },

  // --- Added from county rail register (parcel serve shape, not the 14-column grid) ---
  /** County rail `geometry` / parcel-node spine. */
  { key: "parcelGeometry", grain: "companion", group: "spine" },
  /** County rail `roads` / road-node. */
  { key: "roads", grain: "companion", group: "spine" },
  /** parcel-terrain-model atom family. */
  { key: "terrain", grain: "companion", group: "spine" },
  /** County rail `rail-corridor` — railroad tracks, not RRC O&G. */
  { key: "railCorridor", grain: "companion", group: "spine" },
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

/** Scalar + envelope facet rails from Tier1/Tier2 serve shape. */
export const ZONING_ENVELOPE_RAIL_KEYS = PARCEL_RECORD_RAIL_META.filter(
  (r) => r.group === "zoning-envelope",
).map((r) => r.key) as readonly ParcelRecordRailKey[];

/**
 * Rails that are structurally not-applicable outside city limits (dispatch + ruling).
 * Zoning, setbacks (companion), edges, envelope — NOT wells/permits/flood/etc.
 */
export const UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS: readonly ParcelRecordRailKey[] = [
  ...ZONING_ENVELOPE_RAIL_KEYS,
  "setbackRules",
];

export const PARCEL_RECORD_RAIL_COUNT = PARCEL_RECORD_RAIL_KEYS.length;

/** Keys added beyond the dispatch card seed list. */
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
