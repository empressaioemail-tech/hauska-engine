/**
 * Footprint ↔ parcel spatial join (ingest spec §4.1).
 *
 * Primary attach: intersection area / footprint area >= 50%.
 * Straddle: overlap in (10%, 50%) with structureRole unknown.
 * Reject: overlap < 10%.
 */

import polygonClipping from "polygon-clipping";

import {
  PRIMARY_OVERLAP_MIN,
  STRADDLE_OVERLAP_MIN,
} from "./constants.js";
import type {
  FootprintJoinResult,
  MlFootprintFeature,
  ParcelRecord,
  RingLngLat,
} from "./types.js";

const EARTH_RADIUS_M = 6_378_137;

function ringCentroid(ring: RingLngLat): { lng: number; lat: number } {
  let sx = 0;
  let sy = 0;
  const n = ring.length;
  for (const [lng, lat] of ring) {
    sx += lng;
    sy += lat;
  }
  return { lng: sx / n, lat: sy / n };
}

function projectRing(
  ring: RingLngLat,
  origin: { lng: number; lat: number },
): Array<[number, number]> {
  const latRad = (origin.lat * Math.PI) / 180;
  const mPerDegLng = (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(latRad);
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  return ring.map(([lng, lat]) => [
    (lng - origin.lng) * mPerDegLng,
    (lat - origin.lat) * mPerDegLat,
  ]);
}

function closeRing(coords: Array<[number, number]>): polygonClipping.Ring {
  if (coords.length === 0) return [];
  const ring: polygonClipping.Ring = coords.map(([x, y]) => [x, y]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function ringAreaM2(ring: polygonClipping.Ring): number {
  if (ring.length < 4) return 0;
  const open = ring.slice(0, -1);
  let a = 0;
  for (let i = 0; i < open.length; i++) {
    const p = open[i]!;
    const q = open[(i + 1) % open.length]!;
    a += p[0]! * q[1]! - q[0]! * p[1]!;
  }
  return Math.abs(a) / 2;
}

function polygonAreaM2(polygon: polygonClipping.Polygon): number {
  if (polygon.length === 0) return 0;
  const outer = ringAreaM2(polygon[0]!);
  let holes = 0;
  for (let i = 1; i < polygon.length; i++) {
    holes += ringAreaM2(polygon[i]!);
  }
  return Math.max(0, outer - holes);
}

function multiPolygonAreaM2(mp: polygonClipping.MultiPolygon): number {
  return mp.reduce((sum, poly) => sum + polygonAreaM2(poly), 0);
}

export function footprintParcelOverlapRatio(
  footprintRing: RingLngLat,
  parcelRing: RingLngLat,
): number {
  const origin = ringCentroid(footprintRing);
  const fp = projectRing(footprintRing, origin);
  const par = projectRing(parcelRing, origin);
  const fpPoly: polygonClipping.Polygon = [closeRing(fp)];
  const parPoly: polygonClipping.Polygon = [closeRing(par)];
  const fpArea = polygonAreaM2(fpPoly);
  if (fpArea < 1e-6) return 0;
  const inter = polygonClipping.intersection(fpPoly, parPoly);
  if (!inter || inter.length === 0) return 0;
  return multiPolygonAreaM2(inter) / fpArea;
}

export function classifyOverlapRatio(ratio: number): {
  attach: boolean;
  structureRole: FootprintJoinResult["structureRole"];
  flag?: "straddle-review";
} {
  if (ratio >= PRIMARY_OVERLAP_MIN) {
    return { attach: true, structureRole: "primary" };
  }
  if (ratio >= STRADDLE_OVERLAP_MIN) {
    return { attach: true, structureRole: "unknown", flag: "straddle-review" };
  }
  return { attach: false, structureRole: "unknown" };
}

export interface JoinFootprintsResult {
  byParcel: Map<string, FootprintJoinResult[]>;
  footprintsJoined: number;
  orphanRejected: number;
  parcelsWithFootprint: number;
  parcelsAbsentSentinel: number;
}

interface RingBbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

function ringBbox(ring: RingLngLat): RingBbox {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

// ~0.01deg ~= 1km at Texas latitudes -- small enough that a real building
// footprint's bbox spans one or two cells, large enough that even a large
// rural parcel spans a modest, bounded number of cells.
const GRID_CELL_DEG = 0.01;

function cellRange(bbox: RingBbox): { x0: number; x1: number; y0: number; y1: number } {
  return {
    x0: Math.floor(bbox.minLng / GRID_CELL_DEG),
    x1: Math.floor(bbox.maxLng / GRID_CELL_DEG),
    y0: Math.floor(bbox.minLat / GRID_CELL_DEG),
    y1: Math.floor(bbox.maxLat / GRID_CELL_DEG),
  };
}

function bboxesOverlap(a: RingBbox, b: RingBbox): boolean {
  return a.minLng <= b.maxLng && a.maxLng >= b.minLng && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

/**
 * Bucket parcels into a coarse lng/lat grid so a footprint only needs to be
 * checked against parcels that could plausibly overlap it, instead of every
 * parcel in the county. This is a pure performance prefilter, not a change
 * in semantics: a real polygon overlap requires the two rings' bounding
 * boxes to overlap first (a necessary, not sufficient, condition), so a
 * parcel sharing no grid cell with a footprint's bbox is mathematically
 * guaranteed to have zero overlap with it -- results are identical to the
 * brute-force O(footprints x parcels) scan this replaces, just without
 * computing real polygon-clipping intersections for pairs that are nowhere
 * near each other (measured: this was the dominant cost, not the geometry
 * math itself -- a 63k-parcel x 25k-footprint county was 1.6B polygon-
 * clipping calls before this prefilter).
 */
function buildParcelGridIndex(
  parcels: ReadonlyArray<ParcelRecord>,
): Map<string, Array<{ parcel: ParcelRecord; bbox: RingBbox }>> {
  const grid = new Map<string, Array<{ parcel: ParcelRecord; bbox: RingBbox }>>();
  for (const parcel of parcels) {
    const bbox = ringBbox(parcel.ring);
    const { x0, x1, y0, y1 } = cellRange(bbox);
    const entry = { parcel, bbox };
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(entry);
        else grid.set(key, [entry]);
      }
    }
  }
  return grid;
}

function candidateParcelsForFootprint(
  grid: Map<string, Array<{ parcel: ParcelRecord; bbox: RingBbox }>>,
  footprintBbox: RingBbox,
): ParcelRecord[] {
  const { x0, x1, y0, y1 } = cellRange(footprintBbox);
  const seen = new Set<ParcelRecord>();
  const out: ParcelRecord[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const bucket = grid.get(`${x}:${y}`);
      if (!bucket) continue;
      for (const { parcel, bbox } of bucket) {
        if (seen.has(parcel)) continue;
        if (!bboxesOverlap(footprintBbox, bbox)) continue;
        seen.add(parcel);
        out.push(parcel);
      }
    }
  }
  return out;
}

export function joinFootprintsToParcels(
  parcels: ParcelRecord[],
  footprints: MlFootprintFeature[],
): JoinFootprintsResult {
  const byParcel = new Map<string, FootprintJoinResult[]>();
  let footprintsJoined = 0;
  let orphanRejected = 0;
  const grid = buildParcelGridIndex(parcels);

  for (const fp of footprints) {
    let bestParcel: string | null = null;
    let bestRatio = 0;
    let bestClass: ReturnType<typeof classifyOverlapRatio> | null = null;

    const footprintBbox = ringBbox(fp.ring);
    const candidates = candidateParcelsForFootprint(grid, footprintBbox);
    for (const parcel of candidates) {
      const ratio = footprintParcelOverlapRatio(fp.ring, parcel.ring);
      const cls = classifyOverlapRatio(ratio);
      if (cls.attach && ratio > bestRatio) {
        bestRatio = ratio;
        bestParcel = parcel.parcelNodeId;
        bestClass = cls;
      }
    }

    if (bestParcel && bestClass) {
      const existing = byParcel.get(bestParcel) ?? [];
      const footprintId =
        existing.length === 0 ? "primary" : `accessory-${existing.length}`;
      const entry: FootprintJoinResult = {
        footprintId,
        mlFeatureId: fp.footprintId,
        overlapRatio: Math.round(bestRatio * 10000) / 10000,
        structureRole:
          existing.length === 0 ? "primary" : bestClass.structureRole,
        ring: fp.ring,
        ...(bestClass.flag ? { flag: bestClass.flag } : {}),
      };
      existing.push(entry);
      byParcel.set(bestParcel, existing);
      footprintsJoined += 1;
    } else {
      orphanRejected += 1;
    }
  }

  const parcelsWithFootprint = byParcel.size;
  const parcelsAbsentSentinel = parcels.length - parcelsWithFootprint;

  return {
    byParcel,
    footprintsJoined,
    orphanRejected,
    parcelsWithFootprint,
    parcelsAbsentSentinel,
  };
}
