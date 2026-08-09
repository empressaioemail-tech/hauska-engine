/**
 * Microsoft Global ML Building Footprints loader (bbox filter).
 */

import { readFileSync } from "node:fs";

import { bboxContainsRing } from "./geo.js";
import { GLOBAL_ML_REPO_URL } from "./constants.js";
import type { BboxWgs84, MlFootprintFeature, RingLngLat } from "./types.js";

export interface LoadMlFootprintsOptions {
  bbox: BboxWgs84;
  fixturePath?: string;
  zipPath?: string;
}

function parseGeoJsonFootprints(
  raw: unknown,
  bbox: BboxWgs84,
): MlFootprintFeature[] {
  const fc = raw as {
    features?: Array<{
      geometry?: { type?: string; coordinates?: unknown };
      properties?: Record<string, unknown>;
      id?: string | number;
    }>;
  };
  const out: MlFootprintFeature[] = [];
  for (const feat of fc.features ?? []) {
    const geom = feat.geometry;
    if (geom?.type !== "Polygon" || !Array.isArray(geom.coordinates)) continue;
    const coords = geom.coordinates as RingLngLat[];
    const outer = coords[0];
    if (!outer || outer.length < 4) continue;
    const ring: RingLngLat = outer.map(([lng, lat]) => [lng, lat]);
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
    if (!bboxContainsRing(bbox, ring)) continue;
    const id =
      feat.properties?.id ?? feat.id ?? `ml-${out.length}`;
    out.push({
      footprintId: String(id),
      ring,
    });
  }
  return out;
}

export async function loadMlFootprintsForBbox(
  options: LoadMlFootprintsOptions,
): Promise<{ features: MlFootprintFeature[]; sourceLabel: string }> {
  const { bbox, fixturePath, zipPath } = options;

  if (fixturePath) {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    return {
      features: parseGeoJsonFootprints(raw, bbox),
      sourceLabel: `fixture:${fixturePath}`,
    };
  }

  if (zipPath) {
    throw new Error(
      `zipPath set but streaming Texas.geojson.zip not implemented; ` +
        `pre-clip to GeoJSON and pass --fixture. zip=${zipPath}`,
    );
  }

  return {
    features: [],
    sourceLabel: `none (${GLOBAL_ML_REPO_URL} — pass --fixture for dry-run join)`,
  };
}
