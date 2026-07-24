/**
 * Site-topography contour derivation — pure compute lifted from cortex-api
 * `siteTopographyIngest.ts`. Contour ingest orchestration (DB/GCS/atom events)
 * stays in the cortex BFF.
 */

/// <reference path="./d3-contour.d.ts" />

import { contours as d3Contours } from "d3-contour";
import { fromArrayBuffer as geotiffFromArrayBuffer } from "geotiff";

export type BboxWgs84 = {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
};

type GeoJsonGeometry =
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "MultiLineString"; coordinates: [number, number][][] }
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

export interface ParsedDem {
  width: number;
  height: number;
  /** Row-major elevation values; nodata cells are NaN. */
  values: Float32Array;
  minElevation: number;
  maxElevation: number;
  nodataCount: number;
}

function gdalNodataValue(image: {
  getGDALNoData?: () => number | null;
  fileDirectory?: { GDAL_NODATA?: string | number };
}): number | null {
  const fromFn = image.getGDALNoData?.();
  if (typeof fromFn === "number" && Number.isFinite(fromFn)) return fromFn;
  const raw = image.fileDirectory?.GDAL_NODATA;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a USGS 3DEP (or compatible) GeoTIFF DEM. Nodata cells become NaN so
 * triangulation skips them — never written as elevation 0.0 (a ~150 m spike
 * below Central-TX ground when void fills leak through as zero).
 */
export async function parseDemBytes(bytes: Uint8Array): Promise<ParsedDem> {
  const tiff = await geotiffFromArrayBuffer(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  const image = await tiff.getImage();
  const rasters = await image.readRasters();
  const band0 = Array.isArray(rasters) ? rasters[0] : rasters;
  const width = image.getWidth();
  const height = image.getHeight();
  const total = width * height;
  const taggedNodata = gdalNodataValue(image);

  // Pass 1: classic / tagged nodata → NaN; collect land-like samples for median.
  const values = new Float32Array(total);
  const landSamples: number[] = [];
  for (let i = 0; i < total; i++) {
    const raw = Number((band0 as ArrayLike<number>)[i]);
    const isTagged = taggedNodata !== null && raw === taggedNodata;
    if (!Number.isFinite(raw) || raw <= -1e30 || isTagged) {
      values[i] = Number.NaN;
      continue;
    }
    values[i] = raw;
    if (raw > -500 && raw < 9000) landSamples.push(raw);
  }
  landSamples.sort((a, b) => a - b);
  const median =
    landSamples.length === 0
      ? NaN
      : landSamples[Math.floor(landSamples.length / 2)]!;

  // Pass 2: on clearly elevated land DEMs, treat exact 0.0 as void fill (not MSL).
  let nodataCount = 0;
  let min = Infinity;
  let max = -Infinity;
  const zeroIsNodata = Number.isFinite(median) && median > 20;
  for (let i = 0; i < total; i++) {
    let v = values[i]!;
    if (zeroIsNodata && v === 0) {
      values[i] = Number.NaN;
      v = Number.NaN;
    }
    if (!Number.isFinite(v)) {
      nodataCount++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    throw new Error(
      `DEM contained no finite elevation values (${nodataCount}/${total} cells nodata).`,
    );
  }
  return {
    width,
    height,
    values,
    minElevation: min,
    maxElevation: max,
    nodataCount,
  };
}

export function deriveContoursGeoJson(
  dem: ParsedDem,
  bbox: BboxWgs84,
  intervalMeters: number,
): {
  featureCollection: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      geometry: GeoJsonGeometry;
      properties: { elevationMeters: number };
    }>;
  };
  thresholds: number[];
} {
  const replaced = new Float64Array(dem.values.length);
  for (let i = 0; i < dem.values.length; i++) {
    const v = dem.values[i]!;
    // Sink nodata below the contour threshold range so d3-contour does not
    // draw spurious rings along nodata/finite boundaries (USGS nodata-fill bug).
    replaced[i] = Number.isFinite(v)
      ? v
      : dem.minElevation - intervalMeters * 2;
  }
  const startElev =
    Math.ceil(dem.minElevation / intervalMeters) * intervalMeters;
  const endElev =
    Math.floor(dem.maxElevation / intervalMeters) * intervalMeters;
  const thresholds: number[] = [];
  for (let v = startElev; v <= endElev; v += intervalMeters) {
    thresholds.push(v);
  }

  if (thresholds.length === 0) {
    return {
      featureCollection: { type: "FeatureCollection", features: [] },
      thresholds: [],
    };
  }

  const generator = d3Contours()
    .size([dem.width, dem.height])
    .thresholds(thresholds);
  const rawContours = generator(replaced as unknown as number[]);

  const dLng = (bbox.eastLng - bbox.westLng) / dem.width;
  const dLat = (bbox.northLat - bbox.southLat) / dem.height;
  function remapPair(pair: ArrayLike<number>): [number, number] {
    const px = pair[0]!;
    const py = pair[1]!;
    const lng = bbox.westLng + px * dLng;
    const lat = bbox.northLat - py * dLat;
    return [lng, lat];
  }

  const features = rawContours.map((c: { value: number; coordinates: unknown }) => {
    const remapped = (c.coordinates as unknown as number[][][][]).map(
      (polygon) => polygon.map((ring) => ring.map(remapPair)),
    );
    return {
      type: "Feature" as const,
      geometry: {
        type: "MultiPolygon",
        coordinates: remapped,
      } as GeoJsonGeometry,
      properties: { elevationMeters: c.value },
    };
  });

  return {
    featureCollection: { type: "FeatureCollection", features },
    thresholds,
  };
}
