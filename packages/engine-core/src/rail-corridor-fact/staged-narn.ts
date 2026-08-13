/**
 * Load L15 staged NTAD NARN / crossings JSON (same ArcGIS feature shape
 * as the live fetch). Fail closed if the file is missing.
 */
import { existsSync, readFileSync } from "node:fs";

import { mapNetToClass, mapNetToStatus, type GradeCrossingFeature, type RailCorridorFeature } from "./ntad-source.js";
import { lineStringsFromGeoJson } from "./geo.js";

function segmentBboxFromGeometry(geometry: unknown): {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
} | null {
  const lines = lineStringsFromGeoJson(geometry);
  const coords: number[] = [];
  if (lines.length === 0) {
    const geo = geometry as { paths?: unknown } | null;
    if (Array.isArray(geo?.paths)) {
      for (const path of geo.paths) {
        if (!Array.isArray(path)) continue;
        for (const c of path) {
          if (Array.isArray(c) && c.length >= 2) coords.push(Number(c[0]), Number(c[1]));
        }
      }
    }
  } else {
    for (const line of lines) {
      for (const [lng, lat] of line) coords.push(lng, lat);
    }
  }
  if (coords.length < 4) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let i = 0; i < coords.length; i += 2) {
    const lng = coords[i]!;
    const lat = coords[i + 1]!;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

export function loadStagedNtadCorridors(path: string): RailCorridorFeature[] {
  if (!existsSync(path)) {
    throw new Error(`RAIL_STAGED_NARN_MISSING: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as {
    countyFips?: string;
    features?: Array<{ attributes?: Record<string, unknown>; geometry?: unknown }>;
  };
  const out: RailCorridorFeature[] = [];
  for (const f of raw.features ?? []) {
    const a = f.attributes ?? {};
    const objectId = String(a.OBJECTID ?? a.objectid ?? out.length);
    const net = typeof a.NET === "string" ? a.NET : null;
    const bb = segmentBboxFromGeometry(f.geometry);
    if (!bb) continue;
    out.push({
      segmentId: objectId,
      net,
      status: mapNetToStatus(net),
      corridorClass: mapNetToClass(net),
      rrowner1: typeof a.RROWNER1 === "string" ? a.RROWNER1 : null,
      subdiv: typeof a.SUBDIV === "string" ? a.SUBDIV : null,
      geometry: f.geometry,
      ...bb,
    });
  }
  return out;
}

export function loadStagedNtadCrossings(path: string): GradeCrossingFeature[] {
  if (!existsSync(path)) {
    throw new Error(`RAIL_STAGED_CROSSINGS_MISSING: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as {
    features?: Array<{ attributes?: Record<string, unknown> }>;
  };
  const out: GradeCrossingFeature[] = [];
  for (const f of raw.features ?? []) {
    const a = f.attributes ?? {};
    const crossingId = String(a.CrossingID ?? "").trim();
    const lng = Number(a.Longitude);
    const lat = Number(a.Latitude ?? a.LATITUDE);
    if (!crossingId || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push({ crossingId, lng, lat });
  }
  return out;
}
