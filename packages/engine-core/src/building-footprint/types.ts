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

export interface PlannedPerParcelFootprintAbsence {
  outcome: "absent-per-parcel";
  parcelKey: string;
  absenceKind: "no-footprint-feature";
  reason: string;
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
