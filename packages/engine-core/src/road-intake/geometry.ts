/**
 * v1 road geometry: centerline + assumed-per-class ROW offset edges (27c).
 * Honest approximate — provenance marks assumption, not survey ROW.
 */

import type { GeoCoord, RoadCenterline } from "@hauska-engine/atoms";

const FEET_TO_METERS = 0.3048;
const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

function normalize2d(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len < 1e-12) return [0, 0];
  return [x / len, y / len];
}

function offsetPoint(
  lng: number,
  lat: number,
  dxM: number,
  dyM: number,
): GeoCoord {
  const dLng = dxM / metersPerDegLng(lat);
  const dLat = dyM / METERS_PER_DEG_LAT;
  return [lng + dLng, lat + dLat];
}

/**
 * Offset a polyline left/right by half the assumed ROW width (feet).
 * Uses local equirectangular metric frame per segment.
 */
export function buildRowEdgesFromCenterline(
  centerline: ReadonlyArray<GeoCoord>,
  assumedWidthFt: number,
): { leftEdge: RoadCenterline; rightEdge: RoadCenterline } {
  if (centerline.length < 2) {
    throw new Error("centerline requires at least 2 vertices");
  }
  const halfM = (assumedWidthFt / 2) * FEET_TO_METERS;
  const left: GeoCoord[] = [];
  const right: GeoCoord[] = [];

  for (let i = 0; i < centerline.length; i++) {
    const [lng, lat] = centerline[i]!;
    let tangent: [number, number];
    if (i === 0) {
      const [lng1, lat1] = centerline[i + 1]!;
      tangent = normalize2d(
        (lng1 - lng) * metersPerDegLng(lat),
        (lat1 - lat) * METERS_PER_DEG_LAT,
      );
    } else if (i === centerline.length - 1) {
      const [lng0, lat0] = centerline[i - 1]!;
      tangent = normalize2d(
        (lng - lng0) * metersPerDegLng(lat),
        (lat - lat0) * METERS_PER_DEG_LAT,
      );
    } else {
      const [lng0, lat0] = centerline[i - 1]!;
      const [lng1, lat1] = centerline[i + 1]!;
      tangent = normalize2d(
        (lng1 - lng0) * metersPerDegLng(lat),
        (lat1 - lat0) * METERS_PER_DEG_LAT,
      );
    }
    const normalLeft: [number, number] = [-tangent[1], tangent[0]];
    left.push(
      offsetPoint(lng, lat, normalLeft[0] * halfM, normalLeft[1] * halfM),
    );
    right.push(
      offsetPoint(lng, lat, -normalLeft[0] * halfM, -normalLeft[1] * halfM),
    );
  }

  return {
    leftEdge: { type: "LineString", coordinates: left },
    rightEdge: { type: "LineString", coordinates: right },
  };
}

/** Midpoint attach point for digital-twin-ready reference graph. */
export function defaultAttachPoint(
  centerline: ReadonlyArray<GeoCoord>,
): import("@hauska-engine/atoms").RoadAttachPoint {
  const mid = centerline[Math.floor(centerline.length / 2)]!;
  return {
    kind: "infra-slot",
    refKey: "centerline-mid",
    position: mid,
    note: "Digital-twin attach point — no infra atoms in R1 scope",
  };
}
