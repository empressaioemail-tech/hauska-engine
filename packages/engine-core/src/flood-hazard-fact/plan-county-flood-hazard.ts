/**
 * `flood-hazard-fact` COUNTY PLANNER.
 *
 * Empty zone index → typed per-parcel absence (`no-flood-coverage`).
 * Outside every mapped zone → PRESENT with inSFHA=false (Zone X by omission).
 */

import {
  findZoneAtPoint,
  isSfhaFlag,
  type FloodZoneFeature,
  type LngLat,
} from "./geo.js";
import {
  buildFloodZoneGrid,
  findZoneAtPointWithGrid,
  type FloodZoneGrid,
} from "./flood-zone-grid.js";

export interface FloodParcelInput {
  parcelKey: string;
  /** WGS84 centroid [lng, lat]. Null → no-flood-coverage (no geocode). */
  centroid: LngLat | null;
}

export interface PlannedPresentFloodHazard {
  outcome: "present";
  parcelKey: string;
  inSpecialFloodHazardArea: boolean;
  floodZone: string | null;
  zoneSubtype: string | null;
  baseFloodElevation: number | null;
  sourceVintage?: string;
}

export interface PlannedAbsentFloodHazard {
  outcome: "absent";
  parcelKey: string;
  absenceKind: "no-flood-coverage";
  reason: string;
}

export type PlannedFloodHazard =
  | PlannedPresentFloodHazard
  | PlannedAbsentFloodHazard;

export interface CountyFloodHazardPlan {
  countyFips: string;
  zonesIndexed: number;
  parcelsRead: number;
  emptyZoneIndex: boolean;
  planned: ReadonlyArray<PlannedFloodHazard>;
  counts: {
    present: number;
    presentInSfha: number;
    presentOutside: number;
    absent: number;
    skippedUnusableKey: number;
  };
}

export function planCountyFloodHazard(
  parcels: ReadonlyArray<FloodParcelInput>,
  zones: ReadonlyArray<FloodZoneFeature>,
  opts: { countyFips: string; grid?: FloodZoneGrid | null },
): CountyFloodHazardPlan {
  const emptyZoneIndex = zones.length === 0;
  const grid =
    opts.grid !== undefined
      ? opts.grid
      : emptyZoneIndex
        ? null
        : buildFloodZoneGrid(zones);
  const zoneAtPoint = (lng: number, lat: number) =>
    grid
      ? findZoneAtPointWithGrid(lng, lat, grid, zones)
      : findZoneAtPoint(lng, lat, zones);
  const planned: PlannedFloodHazard[] = [];
  let skippedUnusableKey = 0;
  let presentInSfha = 0;
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

    if (emptyZoneIndex) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-flood-coverage",
        reason: `empty NFHL zone index for county ${opts.countyFips} — no S_FLD_HAZ_AR features available to evaluate`,
      });
      continue;
    }

    if (
      !parcel.centroid ||
      !Number.isFinite(parcel.centroid[0]) ||
      !Number.isFinite(parcel.centroid[1])
    ) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-flood-coverage",
        reason: `no usable geocode/centroid for ${opts.countyFips}:${key}`,
      });
      continue;
    }

    const hit = zoneAtPoint(
      parcel.centroid[0],
      parcel.centroid[1],
    );
    if (!hit) {
      planned.push({
        outcome: "present",
        parcelKey: key,
        inSpecialFloodHazardArea: false,
        floodZone: null,
        zoneSubtype: null,
        baseFloodElevation: null,
      });
      presentOutside += 1;
      continue;
    }

    const inSfha = isSfhaFlag(hit.sfhaTf);
    planned.push({
      outcome: "present",
      parcelKey: key,
      inSpecialFloodHazardArea: inSfha,
      floodZone: hit.fldZone,
      zoneSubtype: hit.zoneSubty,
      baseFloodElevation: hit.staticBfe,
      ...(hit.sourceVintage ? { sourceVintage: hit.sourceVintage } : {}),
    });
    if (inSfha) presentInSfha += 1;
    else presentOutside += 1;
  }

  return {
    countyFips: opts.countyFips,
    zonesIndexed: zones.length,
    parcelsRead: parcels.length,
    emptyZoneIndex,
    planned,
    counts: {
      present: planned.filter((p) => p.outcome === "present").length,
      presentInSfha,
      presentOutside,
      absent: planned.filter((p) => p.outcome === "absent").length,
      skippedUnusableKey,
    },
  };
}
