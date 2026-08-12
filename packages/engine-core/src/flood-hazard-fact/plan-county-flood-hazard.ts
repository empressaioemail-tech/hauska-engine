/**
 * `flood-hazard-fact` COUNTY PLANNER.
 *
 * Empty zone index → typed per-parcel absence (`no-flood-coverage`).
 * Outside every mapped zone → PRESENT with inSFHA=false (Zone X by omission).
 *
 * The parcel-selection and record-assembly halves are exported separately so a
 * PostGIS-backed resolver produces identical plan records to the JS path
 * without re-implementing the dedupe, absence, and SFHA rules.
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

/** A parcel that survived key normalization and dedupe, in plan order. */
export interface PlannableParcel {
  parcelKey: string;
  centroid: LngLat | null;
}

export interface PlannableParcelSelection {
  items: PlannableParcel[];
  skippedUnusableKey: number;
  parcelsRead: number;
}

/** The zone attributes a resolved point-in-polygon hit contributes to a record. */
export interface ResolvedFloodZone {
  fldZone: string | null;
  zoneSubty: string | null;
  sfhaTf: string | null;
  staticBfe: number | null;
  sourceVintage?: string | null;
}

/**
 * Normalize + dedupe parcel keys. Both plan backends consume this so the
 * skipped-key and first-key-wins rules cannot drift between them.
 */
export function selectPlannableParcels(
  parcels: ReadonlyArray<FloodParcelInput>,
): PlannableParcelSelection {
  const items: PlannableParcel[] = [];
  const seen = new Set<string>();
  let skippedUnusableKey = 0;

  for (const parcel of parcels) {
    const key = parcel.parcelKey?.trim() ?? "";
    if (!key || /^0+$/.test(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ parcelKey: key, centroid: parcel.centroid });
  }

  return { items, skippedUnusableKey, parcelsRead: parcels.length };
}

export function hasUsableCentroid(parcel: PlannableParcel): boolean {
  return Boolean(
    parcel.centroid &&
      Number.isFinite(parcel.centroid[0]) &&
      Number.isFinite(parcel.centroid[1]),
  );
}

/**
 * Turn a selection plus per-parcel resolved zones into the county plan.
 *
 * `resolvedZones` is index-aligned with `selection.items`; a null entry means
 * the point fell outside every mapped zone (Zone X by omission).
 */
export function assembleCountyFloodHazardPlan(
  selection: PlannableParcelSelection,
  resolvedZones: ReadonlyArray<ResolvedFloodZone | null>,
  opts: { countyFips: string; zonesIndexed: number },
): CountyFloodHazardPlan {
  const emptyZoneIndex = opts.zonesIndexed === 0;
  const planned: PlannedFloodHazard[] = [];
  let presentInSfha = 0;
  let presentOutside = 0;

  for (let i = 0; i < selection.items.length; i++) {
    const parcel = selection.items[i]!;
    const key = parcel.parcelKey;

    if (emptyZoneIndex) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-flood-coverage",
        reason: `empty NFHL zone index for county ${opts.countyFips} — no S_FLD_HAZ_AR features available to evaluate`,
      });
      continue;
    }

    if (!hasUsableCentroid(parcel)) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-flood-coverage",
        reason: `no usable geocode/centroid for ${opts.countyFips}:${key}`,
      });
      continue;
    }

    const hit = resolvedZones[i] ?? null;
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
    zonesIndexed: opts.zonesIndexed,
    parcelsRead: selection.parcelsRead,
    emptyZoneIndex,
    planned,
    counts: {
      present: planned.filter((p) => p.outcome === "present").length,
      presentInSfha,
      presentOutside,
      absent: planned.filter((p) => p.outcome === "absent").length,
      skippedUnusableKey: selection.skippedUnusableKey,
    },
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

  const selection = selectPlannableParcels(parcels);
  const resolved: Array<ResolvedFloodZone | null> = new Array(
    selection.items.length,
  ).fill(null);

  if (!emptyZoneIndex) {
    for (let i = 0; i < selection.items.length; i++) {
      const parcel = selection.items[i]!;
      if (!hasUsableCentroid(parcel)) continue;
      resolved[i] = zoneAtPoint(parcel.centroid![0], parcel.centroid![1]);
    }
  }

  return assembleCountyFloodHazardPlan(selection, resolved, {
    countyFips: opts.countyFips,
    zonesIndexed: zones.length,
  });
}
