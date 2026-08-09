/**
 * `building-footprint` COUNTY PLANNER — pure, no database access.
 *
 * ADR-029 absence shapes:
 * - County-coverage absent when adapter is honest-absence OR ML bbox is empty.
 * - Per-parcel absent when ML source exists but spatial join finds nothing.
 */

import { isUsablePropId, normalizeForJoin } from "@hauska-engine/atoms";

import {
  ML_EMPTY_BBOX_PROVENANCE_SCOPE,
} from "./constants.js";
import { joinFootprintsToParcels } from "./spatial-join.js";
import { resolveFootprintRoute } from "./resolve-footprint-route.js";
import type {
  CountyBuildingFootprintPlan,
  FootprintAdapterKind,
  MlFootprintFeature,
  ParcelFootprintInput,
  PlannedBuildingFootprint,
} from "./types.js";

const HONEST_ABSENCE_PROVENANCE = [
  "cad-footprint-rest probe",
  "county-gis-footprint-rest probe",
  "microsoft-global-ml-building-footprints",
  "no queryable footprint source after good-faith probe",
] as const;

export function planCountyBuildingFootprints(
  parcels: ReadonlyArray<ParcelFootprintInput>,
  footprints: ReadonlyArray<MlFootprintFeature>,
  opts: {
    countyFips: string;
    footprintAdapterKind?: FootprintAdapterKind | null;
    provenanceScope?: ReadonlyArray<string>;
  },
): CountyBuildingFootprintPlan {
  const route = resolveFootprintRoute({
    footprintAdapterKind: opts.footprintAdapterKind,
  });
  const planned: PlannedBuildingFootprint[] = [];
  let skippedUnusableKey = 0;
  let skippedNoRing = 0;

  if (route.adapterKind === "honest-absence") {
    planned.push({
      outcome: "county-coverage-absent",
      provenanceScope: opts.provenanceScope ?? [...HONEST_ABSENCE_PROVENANCE],
    });
    return finalizePlan({
      countyFips: opts.countyFips,
      route,
      parcelsRead: parcels.length,
      featuresRead: footprints.length,
      mlEmptyBbox: true,
      planned,
      skippedUnusableKey,
      skippedNoRing,
      joinStats: {
        footprintsJoined: 0,
        orphanRejected: 0,
        parcelsWithFootprint: 0,
        parcelsAbsentSentinel: 0,
      },
    });
  }

  if (footprints.length === 0) {
    planned.push({
      outcome: "county-coverage-absent",
      provenanceScope: opts.provenanceScope ?? [...ML_EMPTY_BBOX_PROVENANCE_SCOPE],
    });
    return finalizePlan({
      countyFips: opts.countyFips,
      route,
      parcelsRead: parcels.length,
      featuresRead: 0,
      mlEmptyBbox: true,
      planned,
      skippedUnusableKey,
      skippedNoRing,
      joinStats: {
        footprintsJoined: 0,
        orphanRejected: 0,
        parcelsWithFootprint: 0,
        parcelsAbsentSentinel: 0,
      },
    });
  }

  const joinParcels = [];
  const seenKeys = new Set<string>();

  for (const parcel of parcels) {
    if (!isUsablePropId(parcel.parcelKey)) {
      skippedUnusableKey += 1;
      continue;
    }
    const parcelKey = normalizeForJoin(parcel.parcelKey);
    if (seenKeys.has(parcelKey)) continue;
    seenKeys.add(parcelKey);

    if (!parcel.ring || parcel.ring.length < 4) {
      skippedNoRing += 1;
      planned.push({
        outcome: "absent-per-parcel",
        parcelKey,
        absenceKind: "no-footprint-feature",
        reason: `no usable parcel ring for ${opts.countyFips}:${parcelKey}`,
      });
      continue;
    }

    joinParcels.push({
      parcelNodeId: `${opts.countyFips}:${parcelKey}`,
      propId: parcelKey,
      fips: opts.countyFips,
      ring: parcel.ring,
    });
  }

  const join = joinFootprintsToParcels(joinParcels, [...footprints]);

  for (const record of joinParcels) {
    const parcelKey = record.propId;
    const joined = join.byParcel.get(record.parcelNodeId);
    if (joined && joined.length > 0) {
      for (const j of joined) {
        planned.push({
          outcome: "present",
          parcelKey,
          footprintId: j.footprintId,
          mlFeatureId: j.mlFeatureId,
          ring: j.ring,
          structureRole: j.structureRole,
          overlapRatio: j.overlapRatio,
          ...(j.flag ? { flag: j.flag } : {}),
        });
      }
    } else {
      planned.push({
        outcome: "absent-per-parcel",
        parcelKey,
        absenceKind: "no-footprint-feature",
        reason:
          "ml-spatial-join-below-50pct-overlap-threshold — no qualifying ML footprint for parcel",
      });
    }
  }

  return finalizePlan({
    countyFips: opts.countyFips,
    route,
    parcelsRead: parcels.length,
    featuresRead: footprints.length,
    mlEmptyBbox: false,
    planned,
    skippedUnusableKey,
    skippedNoRing,
    joinStats: {
      footprintsJoined: join.footprintsJoined,
      orphanRejected: join.orphanRejected,
      parcelsWithFootprint: join.parcelsWithFootprint,
      parcelsAbsentSentinel: join.parcelsAbsentSentinel,
    },
  });
}

function finalizePlan(input: {
  countyFips: string;
  route: CountyBuildingFootprintPlan["route"];
  parcelsRead: number;
  featuresRead: number;
  mlEmptyBbox: boolean;
  planned: PlannedBuildingFootprint[];
  skippedUnusableKey: number;
  skippedNoRing: number;
  joinStats: CountyBuildingFootprintPlan["joinStats"];
}): CountyBuildingFootprintPlan {
  const present = input.planned.filter((p) => p.outcome === "present").length;
  const absentPerParcel = input.planned.filter(
    (p) => p.outcome === "absent-per-parcel",
  ).length;
  const countyCoverageAbsent = input.planned.filter(
    (p) => p.outcome === "county-coverage-absent",
  ).length;

  return {
    countyFips: input.countyFips,
    route: input.route,
    parcelsRead: input.parcelsRead,
    featuresRead: input.featuresRead,
    mlEmptyBbox: input.mlEmptyBbox,
    planned: input.planned,
    joinStats: input.joinStats,
    counts: {
      present,
      absentPerParcel,
      countyCoverageAbsent,
      skippedUnusableKey: input.skippedUnusableKey,
      skippedNoRing: input.skippedNoRing,
    },
  };
}
