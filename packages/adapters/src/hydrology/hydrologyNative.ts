/**
 * Inline D8 hydrology engine — Phase 2D.2/2D.3 fallback when the
 * pysheds Python sidecar is unavailable (local dev, CI). Mirrors the
 * Python worker's JSON result shape so `siteDrainageIngest` can swap
 * backends without changing the atom payload.
 */

export interface BboxWgs84 {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: ReadonlyArray<{
    type: "Feature";
    geometry: {
      type: string;
      coordinates: unknown;
    };
    properties?: Record<string, unknown>;
  }>;
}

export interface HydrologyNativeInput {
  width: number;
  height: number;
  /** Row-major elevation meters; NaN = nodata. */
  elevation: Float32Array;
  catchmentBbox: BboxWgs84;
  pourLng: number;
  pourLat: number;
  rainfallDepthMm?: number;
  accumulationThreshold?: number;
}

export interface HydrologyNativeResult {
  status: "ok";
  library: "native-d8";
  libraryVersion: "1.0.0";
  routing: "d8";
  accumulationThreshold: number;
  drainageZonesGeoJson: GeoJsonFeatureCollection;
  flowLinesGeoJson: GeoJsonFeatureCollection;
  rainfallResultGeoJson: GeoJsonFeatureCollection | null;
  pourPoint: { lng: number; lat: number };
}

const D8_OFFSETS: ReadonlyArray<[number, number]> = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

function idx(col: number, row: number, width: number): number {
  return row * width + col;
}

function isFiniteElev(v: number): boolean {
  return Number.isFinite(v);
}

function lngLatForCell(
  col: number,
  row: number,
  width: number,
  height: number,
  bbox: BboxWgs84,
): [number, number] {
  const lng =
    bbox.westLng +
    ((col + 0.5) / Math.max(width, 1)) * (bbox.eastLng - bbox.westLng);
  const lat =
    bbox.northLat -
    ((row + 0.5) / Math.max(height, 1)) * (bbox.northLat - bbox.southLat);
  return [lng, lat];
}

function fillDepressions(
  dem: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(dem);
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = idx(col, row, width);
      if (!isFiniteElev(out[i]!)) continue;
      let minNeighbor = out[i]!;
      for (const [dc, dr] of D8_OFFSETS) {
        const v = out[idx(col + dc, row + dr, width)]!;
        if (isFiniteElev(v) && v < minNeighbor) minNeighbor = v;
      }
      if (minNeighbor > out[i]!) {
        out[i] = minNeighbor;
      }
    }
  }
  return out;
}

function flowDirection(
  dem: Float32Array,
  width: number,
  height: number,
): Int8Array {
  const fdir = new Int8Array(width * height);
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = idx(col, row, width);
      const z = dem[i]!;
      if (!isFiniteElev(z)) {
        fdir[i] = 0;
        continue;
      }
      let bestDrop = 0;
      let bestDir = 0;
      for (let d = 0; d < D8_OFFSETS.length; d++) {
        const [dc, dr] = D8_OFFSETS[d]!;
        const nz = dem[idx(col + dc, row + dr, width)]!;
        if (!isFiniteElev(nz)) continue;
        const drop = z - nz;
        if (drop > bestDrop) {
          bestDrop = drop;
          bestDir = d + 1;
        }
      }
      fdir[i] = bestDir;
    }
  }
  return fdir;
}

function accumulation(
  filled: Float32Array,
  fdir: Int8Array,
  width: number,
  height: number,
): Uint32Array {
  const acc = new Uint32Array(width * height);
  const order: number[] = [];
  for (let i = 0; i < width * height; i++) {
    if (fdir[i]! > 0 && isFiniteElev(filled[i]!)) order.push(i);
  }
  // Process upstream (higher elevation) before downstream so D8 acc
  // propagates correctly — the prior row+col lex sort under-counted.
  order.sort((a, b) => {
    const ea = filled[a]!;
    const eb = filled[b]!;
    if (eb !== ea) return eb - ea;
    const ca = a % width;
    const cb = b % width;
    return cb - ca;
  });
  for (const i of order) {
    acc[i] = (acc[i] ?? 0) + 1;
    const dir = fdir[i]!;
    if (dir <= 0) continue;
    const col = i % width;
    const row = Math.floor(i / width);
    const [dc, dr] = D8_OFFSETS[dir - 1]!;
    const ni = idx(col + dc, row + dr, width);
    acc[ni] = (acc[ni] ?? 0) + acc[i]!;
  }
  return acc;
}

function cellFromLngLat(
  lng: number,
  lat: number,
  width: number,
  height: number,
  bbox: BboxWgs84,
): [number, number] {
  const col = Math.round(
    ((lng - bbox.westLng) / (bbox.eastLng - bbox.westLng)) * (width - 1),
  );
  const row = Math.round(
    ((bbox.northLat - lat) / (bbox.northLat - bbox.southLat)) * (height - 1),
  );
  return [
    Math.max(0, Math.min(width - 1, col)),
    Math.max(0, Math.min(height - 1, row)),
  ];
}

function traceCatchment(
  pourCol: number,
  pourRow: number,
  fdir: Int8Array,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let c = col;
      let r = row;
      for (let step = 0; step < width * height; step++) {
        if (c === pourCol && r === pourRow) {
          mask[idx(col, row, width)] = 1;
          break;
        }
        const dir = fdir[idx(c, r, width)]!;
        if (dir <= 0) break;
        const [dc, dr] = D8_OFFSETS[dir - 1]!;
        c += dc;
        r += dr;
        if (c < 0 || r < 0 || c >= width || r >= height) break;
      }
    }
  }
  return mask;
}

function maskToGeoJson(
  mask: Uint8Array,
  width: number,
  height: number,
  bbox: BboxWgs84,
  properties: Record<string, unknown>,
): GeoJsonFeatureCollection {
  const features: GeoJsonFeatureCollection["features"][number][] = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 12));
  for (let row = 0; row < height; row += step) {
    for (let col = 0; col < width; col += step) {
      if (!mask[idx(col, row, width)]) continue;
      const [lng0, lat0] = lngLatForCell(col, row, width, height, bbox);
      const [lng1, lat1] = lngLatForCell(
        Math.min(col + step, width - 1),
        row,
        width,
        height,
        bbox,
      );
      const [lng2, lat2] = lngLatForCell(
        Math.min(col + step, width - 1),
        Math.min(row + step, height - 1),
        width,
        height,
        bbox,
      );
      const [lng3, lat3] = lngLatForCell(
        col,
        Math.min(row + step, height - 1),
        width,
        height,
        bbox,
      );
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [lng0, lat0],
              [lng1, lat1],
              [lng2, lat2],
              [lng3, lat3],
              [lng0, lat0],
            ],
          ],
        },
        properties: { ...properties },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function flowLinesFromAccumulation(
  acc: Uint32Array,
  fdir: Int8Array,
  width: number,
  height: number,
  bbox: BboxWgs84,
  threshold: number,
): GeoJsonFeatureCollection {
  const features: GeoJsonFeatureCollection["features"][number][] = [];
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = idx(col, row, width);
      if (acc[i]! < threshold) continue;
      const line: [number, number][] = [];
      let c = col;
      let r = row;
      for (let step = 0; step < width + height; step++) {
        line.push(lngLatForCell(c, r, width, height, bbox));
        const dir = fdir[idx(c, r, width)]!;
        if (dir <= 0) break;
        const [dc, dr] = D8_OFFSETS[dir - 1]!;
        c += dc;
        r += dr;
        if (c < 0 || r < 0 || c >= width || r >= height) break;
      }
      if (line.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: line },
          properties: { accumulation: acc[i] },
        });
      }
    }
  }
  return { type: "FeatureCollection", features: features.slice(0, 40) };
}

/** Run D8 hydrology on an in-memory elevation grid. */
export function runHydrologyNative(
  input: HydrologyNativeInput,
): HydrologyNativeResult {
  const { width, height, elevation, catchmentBbox } = input;
  const threshold = input.accumulationThreshold ?? 50;
  const filled = fillDepressions(elevation, width, height);
  const fdir = flowDirection(filled, width, height);
  const acc = accumulation(filled, fdir, width, height);
  const [pourCol, pourRow] = cellFromLngLat(
    input.pourLng,
    input.pourLat,
    width,
    height,
    catchmentBbox,
  );
  const catchMask = traceCatchment(pourCol, pourRow, fdir, width, height);
  const drainageZonesGeoJson = maskToGeoJson(
    catchMask,
    width,
    height,
    catchmentBbox,
    { zone: "catchment", library: "native-d8" },
  );
  const flowLinesGeoJson = flowLinesFromAccumulation(
    acc,
    fdir,
    width,
    height,
    catchmentBbox,
    threshold,
  );

  let rainfallResultGeoJson: GeoJsonFeatureCollection | null = null;
  const rainfallMm = input.rainfallDepthMm ?? 0;
  if (rainfallMm > 0) {
    const rainfallM = rainfallMm / 1000;
    const pondMask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      if (!isFiniteElev(filled[i]!)) continue;
      const slopeProxy = acc[i]! > 0 ? 1 / acc[i]! : 1;
      const pondDepth = rainfallM * Math.min(1, slopeProxy * 10);
      if (pondDepth > 0.005) pondMask[i] = 1;
    }
    rainfallResultGeoJson = maskToGeoJson(
      pondMask,
      width,
      height,
      catchmentBbox,
      { rainfallDepthMm: rainfallMm, library: "native-d8" },
    );
  }

  return {
    status: "ok",
    library: "native-d8",
    libraryVersion: "1.0.0",
    routing: "d8",
    accumulationThreshold: threshold,
    drainageZonesGeoJson,
    flowLinesGeoJson,
    rainfallResultGeoJson,
    pourPoint: { lng: input.pourLng, lat: input.pourLat },
  };
}
