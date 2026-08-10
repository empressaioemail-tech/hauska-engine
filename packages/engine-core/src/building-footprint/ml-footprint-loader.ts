/**
 * Microsoft Global ML Building Footprints loader (bbox filter).
 *
 * HOLD-1 close: stream Texas.geojson.zip partition with NFHL backpressure
 * (high-water 32). Peak RSS is bounded by queue + one parsed feature, not
 * the 3 GB FeatureCollection.
 */

import { readFileSync } from "node:fs";

import { bboxContainsRing } from "./geo.js";
import { GLOBAL_ML_REPO_URL, GLOBAL_ML_TEXAS_ZIP_URL } from "./constants.js";
import { ensureTexasMlZipCached } from "./ml-texas-zip-cache.js";
import { streamTexasMlFeatures } from "./ml-texas-feature-stream.js";
import type { GeoJsonFeatureLike } from "./stream-geojson-seq-backpressure.js";
import type { BboxWgs84, MlFootprintFeature, RingLngLat } from "./types.js";

export interface LoadMlFootprintsOptions {
  bbox: BboxWgs84;
  fixturePath?: string;
  zipPath?: string;
  cacheDir?: string;
  /** When true, count/stream only — do not accumulate bbox matches (metro probe). */
  probeOnly?: boolean;
}

export interface LoadMlFootprintsResult {
  features: MlFootprintFeature[];
  sourceLabel: string;
  partitionsStreamed: number;
  featuresScanned: number;
  featuresRead: number;
  peakQueueDepth: number;
}

function parseGeoJsonFootprintFeature(
  feat: GeoJsonFeatureLike,
  seq: number,
): MlFootprintFeature | null {
  const geom = feat.geometry;
  if (geom?.type !== "Polygon" || !Array.isArray(geom.coordinates)) return null;
  const coords = geom.coordinates as RingLngLat[];
  const outer = coords[0];
  if (!outer || outer.length < 4) return null;
  const ring: RingLngLat = outer.map(([lng, lat]) => [lng, lat]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  const id = feat.properties?.id ?? feat.id ?? `ml-${seq}`;
  return {
    footprintId: String(id),
    ring,
  };
}

function parseGeoJsonFootprints(
  raw: unknown,
  bbox: BboxWgs84,
): MlFootprintFeature[] {
  const fc = raw as {
    features?: GeoJsonFeatureLike[];
  };
  const out: MlFootprintFeature[] = [];
  for (const feat of fc.features ?? []) {
    const parsed = parseGeoJsonFootprintFeature(feat, out.length);
    if (!parsed) continue;
    if (!bboxContainsRing(bbox, parsed.ring)) continue;
    out.push(parsed);
  }
  return out;
}

export async function loadMlFootprintsForBbox(
  options: LoadMlFootprintsOptions,
): Promise<LoadMlFootprintsResult> {
  const { bbox, fixturePath, zipPath, cacheDir, probeOnly = false } = options;

  if (fixturePath) {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    const features = parseGeoJsonFootprints(raw, bbox);
    return {
      features,
      sourceLabel: `fixture:${fixturePath}`,
      partitionsStreamed: 0,
      featuresScanned: features.length,
      featuresRead: features.length,
      peakQueueDepth: 0,
    };
  }

  let resolvedZip = zipPath;
  if (!resolvedZip) {
    const cached = await ensureTexasMlZipCached({ cacheDir });
    resolvedZip = cached.zipPath;
  }

  const features: MlFootprintFeature[] = [];
  let featuresScanned = 0;
  let featuresRead = 0;
  let peakQueueDepth = 0;

  for await (const feat of streamTexasMlFeatures({
    zipPath: resolvedZip,
    onQueueDepth: (d) => {
      if (d > peakQueueDepth) peakQueueDepth = d;
    },
  })) {
    featuresScanned += 1;
    const parsed = parseGeoJsonFootprintFeature(feat, featuresScanned);
    if (!parsed) continue;
    if (!bboxContainsRing(bbox, parsed.ring)) continue;
    featuresRead += 1;
    if (!probeOnly) {
      features.push(parsed);
    }
  }

  return {
    features,
    sourceLabel: `ml-zip:${resolvedZip} (${GLOBAL_ML_TEXAS_ZIP_URL})`,
    partitionsStreamed: 1,
    featuresScanned,
    featuresRead,
    peakQueueDepth,
  };
}

export async function probeMlFootprintsForBbox(
  options: Omit<LoadMlFootprintsOptions, "probeOnly">,
): Promise<LoadMlFootprintsResult> {
  return loadMlFootprintsForBbox({ ...options, probeOnly: true });
}

/** @deprecated use loadMlFootprintsForBbox return shape */
export function emptyMlLoaderFallback(): {
  features: MlFootprintFeature[];
  sourceLabel: string;
} {
  return {
    features: [],
    sourceLabel: `none (${GLOBAL_ML_REPO_URL} — pass --fixture for dry-run join)`,
  };
}
