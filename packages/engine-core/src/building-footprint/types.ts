/**
 * Site-layer types for building-footprint county writer (ADR-029).
 */

export interface BboxWgs84 {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export type FootprintSourceTier =
  | "cad-authoritative"
  | "city-gis-authoritative"
  | "ml-derived"
  | "absent";

export type FootprintAdapterKind =
  | "cad-footprint-rest"
  | "cad-footprint-bulk"
  | "city-gis-footprint-rest"
  | "ml-global-building-footprints"
  | "ml-overture-buildings"
  | "honest-absence";

export type RingLngLat = Array<[number, number]>;

export interface ParcelRecord {
  parcelNodeId: string;
  propId: string;
  fips: string;
  ring: RingLngLat;
}

export interface MlFootprintFeature {
  footprintId: string;
  ring: RingLngLat;
}

export interface FootprintJoinResult {
  footprintId: string;
  mlFeatureId: string;
  overlapRatio: number;
  structureRole: "primary" | "accessory" | "unknown";
  ring: RingLngLat;
  flag?: "straddle-review";
}

export interface FootprintRoute {
  adapterKind: FootprintAdapterKind;
  sourceTier: FootprintSourceTier;
  sourceUrl: string;
}

export interface ParcelFootprintInput {
  parcelKey: string;
  ring: RingLngLat | null;
}

export interface PlannedPresentBuildingFootprint {
  outcome: "present";
  parcelKey: string;
  footprintId: string;
  mlFeatureId: string;
  ring: RingLngLat;
  structureRole: "primary" | "accessory" | "unknown";
  overlapRatio: number;
  flag?: "straddle-review";
}

/**
 * Which of the three distinct staged-join causes produced a per-parcel
 * absence (P-158). `absenceKind` stays the single contract-level value
 * ("no-footprint-feature", owned by @empressaio/atom-contract); this field
 * is the engine-local detail carrying the evidence a reader needs to tell
 * the three apart, since "reason" alone is prose. Staged path only --
 * undefined on the legacy ML-zip/fixture path (plan-county-building-
 * footprints.ts), which never had this ambiguity resolved and is out of
 * this change's scope.
 */
export type StagedFootprintJoinOutcome =
  | { kind: "no-candidate-in-envelope" }
  | { kind: "overlap-below-threshold"; bestOverlapRatio: number }
  | {
      kind: "attached-to-neighbour";
      neighbourParcelKey: string;
      ownOverlapRatio: number;
      neighbourOverlapRatio: number;
    };

export interface PlannedPerParcelFootprintAbsence {
  outcome: "absent-per-parcel";
  parcelKey: string;
  absenceKind: "no-footprint-feature";
  reason: string;
  joinOutcome?: StagedFootprintJoinOutcome;
}

export interface PlannedCountyFootprintCoverageAbsence {
  outcome: "county-coverage-absent";
  provenanceScope: ReadonlyArray<string>;
}

export type PlannedBuildingFootprint =
  | PlannedPresentBuildingFootprint
  | PlannedPerParcelFootprintAbsence
  | PlannedCountyFootprintCoverageAbsence;

export interface CountyBuildingFootprintPlan {
  countyFips: string;
  route: FootprintRoute;
  parcelsRead: number;
  featuresRead: number;
  mlEmptyBbox: boolean;
  planned: ReadonlyArray<PlannedBuildingFootprint>;
  joinStats: {
    footprintsJoined: number;
    orphanRejected: number;
    parcelsWithFootprint: number;
    parcelsAbsentSentinel: number;
  };
  counts: {
    present: number;
    absentPerParcel: number;
    countyCoverageAbsent: number;
    skippedUnusableKey: number;
    skippedNoRing: number;
  };
}
