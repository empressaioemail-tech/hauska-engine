/**
 * `rail-corridor-fact` COUNTY PLANNER.
 *
 * Evaluates parcel boundary rings against NTAD NARN line segments within
 * bufferMeters. Outside buffer → PRESENT nearRailCorridor=false. Empty corridor
 * index after successful fetch → same (no rail in county AOI). Missing geometry
 * → typed absence no-parcel-geometry.
 */

import {
  RAIL_CORRIDOR_DEFAULT_BUFFER_METERS,
  type RailCorridorAtGradeCrossing,
  type RailCorridorClass,
  type RailCorridorStatus,
} from "@empressaio/atom-contract/property";

import {
  expandBbox,
  lineStringsFromGeoJson,
  minEdgeToLineDistanceMeters,
  minPointToParcelEdgeMeters,
  ringBbox,
  ringsFromGeoJson,
  type BBox,
  type LngLat,
} from "./geo.js";
import type { GradeCrossingFeature, RailCorridorFeature } from "./ntad-source.js";

export interface RailParcelInput {
  parcelKey: string;
  geometry: unknown | null;
}

export interface PlannedPresentRailCorridor {
  outcome: "present";
  parcelKey: string;
  nearRailCorridor: boolean;
  bufferMeters: number;
  corridorStatus?: RailCorridorStatus;
  corridorClass?: RailCorridorClass;
  nearestCorridorDistanceMeters?: number;
  atGradeCrossings?: ReadonlyArray<RailCorridorAtGradeCrossing>;
}

export interface PlannedAbsentRailCorridor {
  outcome: "absent";
  parcelKey: string;
  absenceKind: "no-rail-coverage" | "no-parcel-geometry";
  reason: string;
  bufferMeters: number;
}

export type PlannedRailCorridor =
  | PlannedPresentRailCorridor
  | PlannedAbsentRailCorridor;

export interface CountyRailCorridorPlan {
  countyFips: string;
  bufferMeters: number;
  corridorsIndexed: number;
  crossingsIndexed: number;
  sourceFetchFailed: boolean;
  parcelsRead: number;
  planned: ReadonlyArray<PlannedRailCorridor>;
  counts: {
    present: number;
    presentNear: number;
    presentOutside: number;
    absent: number;
    skippedUnusableKey: number;
  };
}

const STATUS_RANK: Record<RailCorridorStatus, number> = {
  active: 0,
  abandoned: 1,
  "rail-trail": 2,
};

function filterCorridorsByBbox(
  corridors: ReadonlyArray<RailCorridorFeature>,
  bbox: BBox,
): RailCorridorFeature[] {
  return corridors.filter(
    (c) =>
      c.eastLng >= bbox.westLng &&
      c.westLng <= bbox.eastLng &&
      c.northLat >= bbox.southLat &&
      c.southLat <= bbox.northLat,
  );
}

function evaluateNearCorridor(
  parcelRings: ReadonlyArray<ReadonlyArray<LngLat>>,
  bufferMeters: number,
  corridors: ReadonlyArray<RailCorridorFeature>,
): {
  near: boolean;
  nearestMeters: number;
  status?: RailCorridorStatus;
  corridorClass?: RailCorridorClass;
} {
  let nearest = Number.POSITIVE_INFINITY;
  let bestStatus: RailCorridorStatus | undefined;
  let bestClass: RailCorridorClass | undefined;

  const parcelBbox = parcelRings.map(ringBbox).find(Boolean);
  if (!parcelBbox) {
    return { near: false, nearestMeters: Number.POSITIVE_INFINITY };
  }
  const queryBbox = expandBbox(parcelBbox, bufferMeters);
  const candidates = filterCorridorsByBbox(corridors, queryBbox);

  for (const corridor of candidates) {
    const lines = lineStringsFromGeoJson(corridor.geometry);
    const dist = minEdgeToLineDistanceMeters(parcelRings, lines);
    if (dist < nearest) {
      nearest = dist;
      bestStatus = corridor.status;
      bestClass = corridor.corridorClass;
    } else if (
      Math.abs(dist - nearest) < 0.5 &&
      bestStatus &&
      STATUS_RANK[corridor.status] < STATUS_RANK[bestStatus]
    ) {
      bestStatus = corridor.status;
      bestClass = corridor.corridorClass;
    }
  }

  return {
    near: nearest <= bufferMeters,
    nearestMeters: nearest,
    ...(nearest <= bufferMeters
      ? { status: bestStatus, corridorClass: bestClass }
      : {}),
  };
}

function crossingsNearParcel(
  parcelRings: ReadonlyArray<ReadonlyArray<LngLat>>,
  bufferMeters: number,
  crossings: ReadonlyArray<GradeCrossingFeature>,
): RailCorridorAtGradeCrossing[] {
  const hits: RailCorridorAtGradeCrossing[] = [];
  for (const x of crossings) {
    const dist = minPointToParcelEdgeMeters([x.lng, x.lat], parcelRings);
    if (dist <= bufferMeters) {
      hits.push({
        crossingId: x.crossingId,
        distanceMeters: Math.round(dist * 10) / 10,
      });
    }
  }
  hits.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return hits;
}

export function planCountyRailCorridor(
  parcels: ReadonlyArray<RailParcelInput>,
  corridors: ReadonlyArray<RailCorridorFeature>,
  crossings: ReadonlyArray<GradeCrossingFeature>,
  opts: {
    countyFips: string;
    bufferMeters?: number;
    sourceFetchFailed?: boolean;
  },
): CountyRailCorridorPlan {
  const bufferMeters = opts.bufferMeters ?? RAIL_CORRIDOR_DEFAULT_BUFFER_METERS;
  const sourceFetchFailed = opts.sourceFetchFailed === true;
  const planned: PlannedRailCorridor[] = [];
  let skippedUnusableKey = 0;
  let presentNear = 0;
  let presentOutside = 0;
  const seen = new Set<string>();

  for (const parcel of parcels) {
    const key = parcel.parcelKey?.trim() ?? "";
    if (!key || /^0+$/.test(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    const rings = parcel.geometry ? ringsFromGeoJson(parcel.geometry) : [];
    if (rings.length === 0) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-parcel-geometry",
        reason: `no usable parcel ring geometry for ${opts.countyFips}:${key}`,
        bufferMeters,
      });
      continue;
    }

    if (sourceFetchFailed) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-rail-coverage",
        reason: `NTAD NARN source fetch failed for county ${opts.countyFips} — cannot evaluate corridor proximity`,
        bufferMeters,
      });
      continue;
    }

    const evalResult = evaluateNearCorridor(rings, bufferMeters, corridors);
    if (!evalResult.near) {
      planned.push({
        outcome: "present",
        parcelKey: key,
        nearRailCorridor: false,
        bufferMeters,
      });
      presentOutside += 1;
      continue;
    }

    const atGradeCrossings = crossingsNearParcel(rings, bufferMeters, crossings);
    planned.push({
      outcome: "present",
      parcelKey: key,
      nearRailCorridor: true,
      bufferMeters,
      corridorStatus: evalResult.status,
      corridorClass: evalResult.corridorClass,
      nearestCorridorDistanceMeters:
        Math.round(evalResult.nearestMeters * 10) / 10,
      ...(atGradeCrossings.length > 0 ? { atGradeCrossings } : {}),
    });
    presentNear += 1;
  }

  return {
    countyFips: opts.countyFips,
    bufferMeters,
    corridorsIndexed: corridors.length,
    crossingsIndexed: crossings.length,
    sourceFetchFailed,
    parcelsRead: parcels.length,
    planned,
    counts: {
      present: planned.filter((p) => p.outcome === "present").length,
      presentNear,
      presentOutside,
      absent: planned.filter((p) => p.outcome === "absent").length,
      skippedUnusableKey,
    },
  };
}
