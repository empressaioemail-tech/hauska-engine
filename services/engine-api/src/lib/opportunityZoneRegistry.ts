/**
 * Federal Opportunity Zone tract registry — CDFI/HUD designated tracts.
 *
 * Loads versioned GeoJSON from OZ_TRACT_DATA_PATH or the bundled
 * minimal fixture for CI. Runtime refresh via ingest script (cc-agent-C).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OZ_TRACT_LIST_VERSION =
  process.env.OZ_TRACT_LIST_VERSION ?? "oz-1.0";

export interface OzTractFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

interface OzTractCollection {
  type: "FeatureCollection";
  features: OzTractFeature[];
}

let cachedTracts: OzTractCollection | null = null;

function fixtureCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = process.env.OZ_TRACT_DATA_PATH?.trim();
  const paths = [
    envPath,
    join(here, "../../../data/opportunity-zones", `${OZ_TRACT_LIST_VERSION}.geojson`),
    join(process.cwd(), "data/opportunity-zones", `${OZ_TRACT_LIST_VERSION}.geojson`),
  ].filter((p): p is string => Boolean(p));
  return paths;
}

export function loadOzTractRegistry(): OzTractCollection {
  if (cachedTracts) return cachedTracts;
  const hit = fixtureCandidates().find((p) => existsSync(p));
  if (!hit) {
    return { type: "FeatureCollection", features: [] };
  }
  cachedTracts = JSON.parse(readFileSync(hit, "utf8")) as OzTractCollection;
  return cachedTracts;
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(
  lng: number,
  lat: number,
  geometry: OzTractFeature["geometry"],
): boolean {
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as number[][][];
    if (!rings[0]) return false;
    return pointInRing(lng, lat, rings[0]);
  }
  for (const poly of geometry.coordinates as number[][][][]) {
    if (poly[0] && pointInRing(lng, lat, poly[0])) return true;
  }
  return false;
}

export function lookupOpportunityZoneTract(input: {
  latitude: number;
  longitude: number;
}): {
  inOpportunityZone: boolean;
  tractGeoid: string | null;
  ozRound: string;
  tractListVersion: string;
  tractFeature: OzTractFeature | null;
} {
  const collection = loadOzTractRegistry();
  const round = OZ_TRACT_LIST_VERSION;

  for (const feature of collection.features) {
    if (
      pointInPolygonCoords(
        input.longitude,
        input.latitude,
        feature.geometry,
      )
    ) {
      return {
        inOpportunityZone: true,
        tractGeoid: String(feature.properties.geoid10 ?? feature.properties.GEOID10 ?? ""),
        ozRound: String(feature.properties.round ?? round),
        tractListVersion: round,
        tractFeature: feature,
      };
    }
  }

  return {
    inOpportunityZone: false,
    tractGeoid: null,
    ozRound: round,
    tractListVersion: round,
    tractFeature: null,
  };
}

/** TEST-ONLY */
export function __resetOzTractCacheForTests(): void {
  cachedTracts = null;
}
