/**
 * Vendored copy of hauska-factory's closed parcel-record rail set
 * (`src/lib/parcel-record-engine/rail-keys.js`), pinned to a SHA per P-152
 * dispatch step 2: "read the rail list from the factory's rail-keys.js at
 * a pinned SHA and carry that SHA in the response; never hand-author the
 * list."
 *
 * Vendored, not hand-authored: this array is a verbatim copy of
 * `PARCEL_RECORD_RAIL_KEYS` (in registry declaration order) read directly
 * from hauska-factory `origin/main` at the pin below. Re-vendor by reading
 * the same file at a new hauska-factory SHA and updating both the array
 * and `PARCEL_RECORD_RAIL_REGISTRY_SHA` together — never edit one without
 * the other.
 */

export const PARCEL_RECORD_RAIL_REGISTRY_SHA =
  "217b7dd7eb3a1b2f72f3a72d333008079f71fcaf";

export const PARCEL_RECORD_RAIL_REGISTRY_SOURCE_PATH =
  "src/lib/parcel-record-engine/rail-keys.js";

export type ParcelRecordRailGrain = "scalar" | "companion";

export interface ParcelRecordRailMeta {
  key: string;
  grain: ParcelRecordRailGrain;
  group: string;
}

/** Verbatim order + shape of hauska-factory's PARCEL_RECORD_RAIL_META at the pinned SHA. */
export const PARCEL_RECORD_RAIL_META: readonly ParcelRecordRailMeta[] = [
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
  { key: "legalDescription", grain: "scalar", group: "cad" },
  { key: "exemptionCodes", grain: "scalar", group: "cad" },
  { key: "countyFips", grain: "scalar", group: "jurisdiction" },
  { key: "cityLimits", grain: "scalar", group: "jurisdiction" },
  { key: "etjStatus", grain: "scalar", group: "jurisdiction" },
  { key: "schoolDistrict", grain: "scalar", group: "jurisdiction" },
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
  { key: "maxImperviousCoverPct", grain: "scalar", group: "zoning-envelope" },
  { key: "treeProtection", grain: "scalar", group: "zoning-envelope" },
  { key: "setbackRules", grain: "companion", group: "companion" },
  { key: "wells", grain: "companion", group: "companion" },
  { key: "pipelines", grain: "companion", group: "companion" },
  { key: "permits", grain: "companion", group: "companion" },
  { key: "easements", grain: "companion", group: "companion" },
  { key: "buildingFootprint", grain: "companion", group: "companion" },
  { key: "specialDistricts", grain: "companion", group: "companion" },
  { key: "flood", grain: "companion", group: "companion" },
  { key: "owner", grain: "companion", group: "companion" },
  { key: "valueHistory", grain: "companion", group: "companion" },
  { key: "salesHistory", grain: "companion", group: "companion" },
  { key: "publicRecordRefs", grain: "companion", group: "companion" },
  { key: "ossf", grain: "companion", group: "companion" },
  { key: "utilityService", grain: "companion", group: "companion" },
  { key: "agValuation", grain: "companion", group: "companion" },
  { key: "mineralRights", grain: "companion", group: "companion" },
  { key: "hoaDeedRestrictions", grain: "companion", group: "companion" },
  { key: "overlayDistricts", grain: "companion", group: "companion" },
  { key: "parcelGeometry", grain: "companion", group: "spine" },
  { key: "roads", grain: "companion", group: "spine" },
  { key: "terrain", grain: "companion", group: "spine" },
  { key: "railCorridor", grain: "companion", group: "spine" },
] as const;

export const PARCEL_RECORD_RAIL_KEYS: readonly string[] =
  PARCEL_RECORD_RAIL_META.map((r) => r.key);

export const PARCEL_RECORD_RAIL_COUNT = PARCEL_RECORD_RAIL_KEYS.length;
