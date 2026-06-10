/**
 * Site-topography contour derivation — pure compute lifted from cortex-api
 * `siteTopographyIngest.ts`. Contour ingest orchestration (DB/GCS/atom events)
 * stays in the cortex BFF.
 */

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
  const values = new Float32Array(total);
  let min = Infinity;
  let max = -Infinity;
  let nodataCount = 0;
  for (let i = 0; i < total; i++) {
    const raw = Number((band0 as ArrayLike<number>)[i]);
    if (!Number.isFinite(raw) || raw <= -1e30) {
      values[i] = Number.NaN;
      nodataCount++;
      continue;
    }
    values[i] = raw;
    if (raw < min) min = raw;
    if (raw > max) max = raw;
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
    replaced[i] = Number.isFinite(v) ? v : dem.minElevation;
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

  const features = rawContours.map((c) => {
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
