/**
 * Bastrop County 1-ft contour adapter (qa/topo-fidelity-1ft, 2026-07-27).
 *
 * Authoritative fidelity tier for the terrain contour-rendering consumers
 * (DXF contours, site-plan contours + elevation labels) within the Bastrop
 * County footprint. Source is the county's published `Contour1Ft2017`
 * FeatureServer, derived from 2017 StratMap LiDAR — a 1-ft vertical interval,
 * far finer than the 3DEP-derived d3-contour lines the pipeline draws
 * elsewhere.
 *
 * Endpoint (verified live 2026-07-27)
 * -----------------------------------
 *   https://maps.co.bastrop.tx.us/server/rest/services/RoadAndBridgeMap/
 *     Contour1Ft2017/FeatureServer/0
 *   - geometryType: esriGeometryPolyline
 *   - `contour` field (Double): elevation value
 *   - `mod10` field (SmallInteger): 1 on index (mod-10) contours, else 0
 *   - native SR: WKID 102739 / latestWkid 2277 (NAD83 State Plane TX Central,
 *     US SURVEY FEET); vcsWkid 105703 / latestVcsWkid 6360 (NAVD88 height,
 *     US survey foot). ~1.12M features county-wide, maxRecordCount 2000.
 *
 * Unit + projection reconciliation
 * --------------------------------
 * The pipeline is METRES NAVD88 in WGS84 lng/lat local-ENU frames. This
 * adapter reconciles both axes:
 *  - HORIZONTAL: request `outSR=4326` so the ImageServer reprojects the
 *    polyline vertices server-side from State Plane US-ft to WGS84 lng/lat.
 *    No client-side horizontal math (the server knows the exact datum grid).
 *  - VERTICAL: the `contour` value is NAVD88 in US SURVEY FEET. Convert to
 *    metres with the US survey foot (1200/3937 m), NOT the international foot.
 *    (At 258-765 ft the survey-vs-international difference is sub-millimetre,
 *    well under the ±0.05 m mesh integrity tolerance; we use the exact factor
 *    regardless because it is free and correct.)
 *
 * Fallback posture
 * ----------------
 * This adapter covers ONLY the Bastrop County footprint. Callers use
 * {@link bastropContourCoverage} to decide, and fall back to the 3DEP-derived
 * contour path honestly for any bbox outside coverage (or when the fetch
 * returns nothing). It never invents contour geometry, and never replaces the
 * 3DEP mesh Z — it is an additive contour-rendering tier only.
 */

import type { BboxWgs84 } from "./usgs3dep.js";

export const BASTROP_CONTOUR_1FT_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/RoadAndBridgeMap/Contour1Ft2017/FeatureServer/0";

export const BASTROP_CONTOUR_SOURCE = "bastrop-county:Contour1Ft2017";
export const BASTROP_CONTOUR_VINTAGE = "2017 StratMap LiDAR";
export const BASTROP_CONTOUR_INTERVAL_LABEL = "1-ft vertical interval";

const BASTROP_CONTOUR_USER_AGENT =
  "hauska-engine/1.0 (+https://cortex.empressa.io; topo-fidelity 1ft)";

/** US survey foot in metres (1200/3937). NOT the international foot (0.3048). */
export const US_SURVEY_FOOT_METERS = 1200 / 3937;

const PAGE_SIZE = 2000; // == service maxRecordCount

/**
 * Approximate Bastrop County footprint in WGS84 (derived from the service
 * extent, WKID 102739, reprojected). A conservative envelope: any bbox that
 * intersects this is eligible for a live 1-ft contour query, and an empty
 * live result still falls back to 3DEP honestly. Only used to skip the network
 * call entirely for clearly-out-of-county bboxes (e.g. Moab, UT).
 */
const BASTROP_FOOTPRINT_WGS84: BboxWgs84 = {
  westLng: -97.72,
  southLat: 29.90,
  eastLng: -96.94,
  northLat: 30.55,
};

export interface BastropContourPolyline {
  /** Elevation in metres NAVD88 (converted from US survey feet). */
  elevationMeters: number;
  /** Original contour value in US survey feet (provenance / audit). */
  elevationFeet: number;
  /** True on index (mod-10-ft) contours. */
  index: boolean;
  /** Polyline vertices as WGS84 [lng, lat] pairs (server-reprojected to 4326). */
  points: Array<[number, number]>;
}

export interface FetchBastropCountyContoursResult {
  polylines: BastropContourPolyline[];
  featureCount: number;
  pagesFetched: number;
  elapsedMs: number;
  sourceUrl: string;
  source: string;
  vintage: string;
  intervalLabel: string;
  verticalUnitConverted: "us-survey-foot->metre";
  /** Bbox actually queried, echoed for provenance. */
  bbox: BboxWgs84;
}

function bboxesIntersect(a: BboxWgs84, b: BboxWgs84): boolean {
  return (
    a.westLng <= b.eastLng &&
    a.eastLng >= b.westLng &&
    a.southLat <= b.northLat &&
    a.northLat >= b.southLat
  );
}

/**
 * True when a bbox intersects the Bastrop County footprint and is therefore
 * eligible for the authoritative 1-ft contour tier. A `false` here is the
 * signal to fall back to the 3DEP-derived contour path.
 */
export function bastropContourCoverage(bbox: BboxWgs84): boolean {
  return bboxesIntersect(bbox, BASTROP_FOOTPRINT_WGS84);
}

function parsePaths(
  geometry: { paths?: number[][][] } | undefined,
): Array<[number, number]>[] {
  const paths = geometry?.paths;
  if (!Array.isArray(paths)) return [];
  const out: Array<[number, number]>[] = [];
  for (const path of paths) {
    if (!Array.isArray(path) || path.length < 2) continue;
    const coords: Array<[number, number]> = [];
    for (const pt of path) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const lng = Number(pt[0]);
      const lat = Number(pt[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      coords.push([lng, lat]);
    }
    if (coords.length >= 2) out.push(coords);
  }
  return out;
}

/**
 * Fetch the 1-ft contour polylines intersecting a WGS84 bbox from the Bastrop
 * County service. A per-bbox envelope query (far lighter than pulling all
 * ~1.12M county features). Returns polylines with metre-converted elevations
 * plus full provenance. Returns an empty polyline list (not an error) when the
 * bbox is outside the county footprint or intersects no contours — the caller
 * then falls back to 3DEP honestly.
 */
export async function fetchBastropCountyContours(
  bbox: BboxWgs84,
  options: {
    serviceUrl?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** Cap total features to guard against a pathologically large bbox. */
    maxFeatures?: number;
  } = {},
): Promise<FetchBastropCountyContoursResult> {
  const serviceUrl = (options.serviceUrl ?? BASTROP_CONTOUR_1FT_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxFeatures = options.maxFeatures ?? 200_000;
  const t0 = Date.now();

  const base: FetchBastropCountyContoursResult = {
    polylines: [],
    featureCount: 0,
    pagesFetched: 0,
    elapsedMs: 0,
    sourceUrl: serviceUrl,
    source: BASTROP_CONTOUR_SOURCE,
    vintage: BASTROP_CONTOUR_VINTAGE,
    intervalLabel: BASTROP_CONTOUR_INTERVAL_LABEL,
    verticalUnitConverted: "us-survey-foot->metre",
    bbox,
  };

  // Skip the network entirely for clearly-out-of-county bboxes.
  if (!bastropContourCoverage(bbox)) {
    base.elapsedMs = Date.now() - t0;
    return base;
  }

  const envelope = {
    xmin: bbox.westLng,
    ymin: bbox.southLat,
    xmax: bbox.eastLng,
    ymax: bbox.northLat,
    spatialReference: { wkid: 4326 },
  };

  const polylines: BastropContourPolyline[] = [];
  let offset = 0;
  let pagesFetched = 0;

  for (;;) {
    const url = new URL(`${serviceUrl}/query`);
    url.searchParams.set("f", "json");
    url.searchParams.set("where", "1=1");
    url.searchParams.set("geometry", JSON.stringify(envelope));
    url.searchParams.set("geometryType", "esriGeometryEnvelope");
    url.searchParams.set("inSR", "4326");
    url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    url.searchParams.set("outFields", "contour,mod10");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
    url.searchParams.set("resultOffset", String(offset));

    const res = await fetchImpl(url.toString(), {
      headers: { "User-Agent": BASTROP_CONTOUR_USER_AGENT, Accept: "application/json" },
      signal: options.signal,
    });
    if (!res.ok) {
      throw new Error(`Contour1Ft2017 HTTP ${res.status}: ${res.statusText}`);
    }
    const body = (await res.json()) as {
      error?: { message?: string };
      features?: Array<{
        attributes?: { contour?: unknown; mod10?: unknown };
        geometry?: { paths?: number[][][] };
      }>;
      exceededTransferLimit?: boolean;
    };
    if (body.error) {
      throw new Error(`Contour1Ft2017 ArcGIS error: ${body.error.message ?? "unknown"}`);
    }
    for (const raw of body.features ?? []) {
      const feet = Number(raw.attributes?.contour);
      if (!Number.isFinite(feet)) continue;
      const index = Number(raw.attributes?.mod10) === 1;
      const meters = feet * US_SURVEY_FOOT_METERS;
      for (const points of parsePaths(raw.geometry)) {
        polylines.push({ elevationMeters: meters, elevationFeet: feet, index, points });
      }
    }
    pagesFetched++;
    if (!body.exceededTransferLimit) break;
    if (polylines.length >= maxFeatures) break;
    offset += PAGE_SIZE;
  }

  return {
    ...base,
    polylines,
    featureCount: polylines.length,
    pagesFetched,
    elapsedMs: Date.now() - t0,
  };
}
