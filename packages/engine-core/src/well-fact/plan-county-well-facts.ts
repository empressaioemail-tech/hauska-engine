/**
 * `well-fact` COUNTY PLANNER â€” RRC surface wells on or near parcels.
 *
 * THE LOAD-BEARING SEMANTIC: the buyer question is whether a well is ON or
 * NEAR the property, not whether a centroid falls inside the polygon. Each
 * well-parcel association is one planned atom; parcels with none get a typed
 * absence. On-parcel takes precedence over near-parcel for the same well.
 */

import {
  distancePointToPolygonMeters,
  expandBBox,
  haversineMeters,
  metersToLatDegrees,
  metersToLngDegrees,
  pointInGeoJson,
  type LngLat,
} from "./geo.js";
import {
  buildApiNumber14,
  deriveOrphanedFlag,
  resolveWellStatus,
  resolveWellType,
} from "./symnum.js";
import type { RrcWellFeature } from "./fetch-wells.js";

export const WELL_FACT_PROXIMITY_RADIUS_METERS = 152;

export interface WellParcelInput {
  parcelKey: string;
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface PlannedPresentWellFact {
  outcome: "present";
  parcelKey: string;
  wellKey: string;
  apiNumber14: string;
  wellStatus: ReturnType<typeof resolveWellStatus>;
  wellType: ReturnType<typeof resolveWellType>;
  orphaned: boolean;
  surfaceLocation: { lng: number; lat: number };
  parcelRelation: "on-parcel" | "near-parcel";
  proximityRadiusMeters: number;
  proximityDistanceMeters: number;
}

export interface PlannedAbsentWellFact {
  outcome: "absent";
  parcelKey: string;
  absenceKind: "no-well-on-or-near";
  reason: string;
}

export type PlannedWellFact = PlannedPresentWellFact | PlannedAbsentWellFact;

export interface CountyWellFactPlan {
  countyFips: string;
  proximityRadiusMeters: number;
  wellsIndexed: number;
  parcelsRead: number;
  planned: ReadonlyArray<PlannedWellFact>;
  counts: {
    present: number;
    absent: number;
    onParcel: number;
    nearParcel: number;
    skippedUnusableKey: number;
    absentByKind: Record<"no-well-on-or-near", number>;
  };
}

function isUsableParcelKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed.length > 0 && !/^0+$/.test(trimmed);
}

function wellPoint(w: RrcWellFeature): LngLat {
  return [w.lng, w.lat];
}

function wellsNearParcelBBox(
  wells: ReadonlyArray<RrcWellFeature>,
  parcel: WellParcelInput,
  radiusM: number,
): RrcWellFeature[] {
  const midLat = (parcel.southLat + parcel.northLat) / 2;
  const latBuf = metersToLatDegrees(radiusM);
  const lngBuf = metersToLngDegrees(radiusM, midLat);
  const expanded = expandBBox(
    {
      westLng: parcel.westLng,
      southLat: parcel.southLat,
      eastLng: parcel.eastLng,
      northLat: parcel.northLat,
    },
    Math.max(latBuf, lngBuf),
  );
  return wells.filter(
    (w) =>
      w.lng >= expanded.westLng &&
      w.lng <= expanded.eastLng &&
      w.lat >= expanded.southLat &&
      w.lat <= expanded.northLat,
  );
}

export function planCountyWellFacts(
  parcels: ReadonlyArray<WellParcelInput>,
  wells: ReadonlyArray<RrcWellFeature>,
  opts: { countyFips: string; proximityRadiusMeters?: number },
): CountyWellFactPlan {
  const radius = opts.proximityRadiusMeters ?? WELL_FACT_PROXIMITY_RADIUS_METERS;
  const planned: PlannedWellFact[] = [];
  let onParcel = 0;
  let nearParcel = 0;
  let skippedUnusableKey = 0;
  const absentByKind = { "no-well-on-or-near": 0 };
  const seenParcelKeys = new Set<string>();

  for (const parcel of parcels) {
    const key = parcel.parcelKey?.trim() ?? "";
    if (!isUsableParcelKey(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    if (seenParcelKeys.has(key)) continue;
    seenParcelKeys.add(key);

    const candidates = wellsNearParcelBBox(wells, parcel, radius);
    const hits: PlannedPresentWellFact[] = [];

    for (const well of candidates) {
      const pt = wellPoint(well);
      const on = pointInGeoJson(pt[0], pt[1], parcel.geometry);
      const distM = on ? 0 : distancePointToPolygonMeters(pt, parcel.geometry);
      if (!on && distM > radius) continue;

      const apiNumber14 = buildApiNumber14(well.api);
      const wellKey = apiNumber14;
      const wellStatus = resolveWellStatus(
        well.symnum,
        well.gisSymbolDescription,
      );
      hits.push({
        outcome: "present",
        parcelKey: key,
        wellKey,
        apiNumber14,
        wellStatus,
        wellType: resolveWellType(well.symnum, well.gisSymbolDescription),
        orphaned: deriveOrphanedFlag(well.symnum, wellStatus),
        surfaceLocation: { lng: well.lng, lat: well.lat },
        parcelRelation: on ? "on-parcel" : "near-parcel",
        proximityRadiusMeters: radius,
        proximityDistanceMeters: on ? 0 : distM,
      });
    }

    if (hits.length === 0) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-well-on-or-near",
        reason: `no Texas RRC surface well on or within ${radius} m of parcel geometry`,
      });
      absentByKind["no-well-on-or-near"] += 1;
      continue;
    }

    hits.sort((a, b) => a.wellKey.localeCompare(b.wellKey));
    for (const hit of hits) {
      planned.push(hit);
      if (hit.parcelRelation === "on-parcel") onParcel += 1;
      else nearParcel += 1;
    }
  }

  const present = planned.filter((p) => p.outcome === "present").length;
  const absent = planned.filter((p) => p.outcome === "absent").length;

  return {
    countyFips: opts.countyFips,
    proximityRadiusMeters: radius,
    wellsIndexed: wells.length,
    parcelsRead: parcels.length,
    planned,
    counts: {
      present,
      absent,
      onParcel,
      nearParcel,
      skippedUnusableKey,
      absentByKind,
    },
  };
}

/** Unit-test helper: distance between well and parcel for assertions. */
export function wellParcelDistanceMeters(
  well: RrcWellFeature,
  parcel: WellParcelInput,
): number {
  const pt = wellPoint(well);
  if (pointInGeoJson(pt[0], pt[1], parcel.geometry)) return 0;
  return distancePointToPolygonMeters(pt, parcel.geometry);
}

export { haversineMeters };

