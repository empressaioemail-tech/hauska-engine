/**
 * County-mapped hydrography adapter (feat/hydrography-map-layer).
 *
 * AUTHORITATIVE-OVER-DERIVED: serves the county's MAPPED water features
 * (creeks/streams polylines, waterbody polygons) for a viewport bbox from a
 * county-published ArcGIS layer — the real mapped hydrography a county GIS
 * office publishes, as opposed to the D8 flow channels the `hydrology-flow`
 * slot DERIVES from a DEM. Derived flow stays available as report input; the
 * customer-facing map layer should show what the county actually maps.
 *
 * COUNTY-AGNOSTIC BY REGISTRY: sources are configured per county in
 * {@link COUNTY_HYDROGRAPHY_SOURCES} (the same shape/mold as the Bastrop 1-ft
 * contour source in `topography/bastrop-contours.ts`, generalized to a
 * registry). A bbox with no registered source resolves to `null` and callers
 * return honest-unavailable — NEVER an OSM-derived or otherwise substituted
 * layer. Adding a county is a registry entry, not new code.
 *
 * Bastrop entry (verified live 2026-07-29 against the county services
 * directory — same public county server that publishes Contour1Ft2017):
 *   https://maps.co.bastrop.tx.us/server/rest/services/Hydrography/
 *     Creeks_Streams/MapServer/0
 *   - "Bastrop County Creeks & Streams", esriGeometryPolyline
 *   - NHD-derived schema: GNIS_Name (stream name), FEATURE_TY, ReachCode,
 *     LengthKM, FCode; ~9,083 features county-wide
 *   - capabilities "Map,Query,Data"; maxRecordCount 1000
 *   - NO FeatureServer endpoint (500s) and NO pagination support
 *     (`supportsPagination: false`; `resultRecordCount` returns HTTP 400
 *     "Pagination is not supported") — so this adapter issues a SINGLE
 *     envelope query and reports `exceededTransferLimit` truncation honestly
 *     instead of paging like the contour adapter does.
 *   - native SR WKID 102739 / 2277 (TX State Plane Central, US ft); we query
 *     with inSR/outSR=4326 so the server reprojects to WGS84 lng/lat.
 */

import type { BboxWgs84 } from "../topography/usgs3dep.js";

const COUNTY_HYDROGRAPHY_USER_AGENT =
  "hauska-engine/1.0 (+https://cortex.empressa.io; county hydrography)";

/** A county-published mapped-hydrography source (registry entry). */
export interface CountyHydrographySource {
  /** Jurisdiction key this source belongs to (matches `localKey` style). */
  countyKey: string;
  /** Stable source id, `<county>:<LayerName>` (provenance / adapterKey). */
  sourceKey: string;
  /** ArcGIS layer URL (MapServer/<n> or FeatureServer/<n>), no trailing /. */
  serviceUrl: string;
  /** Human layer name as the county publishes it. */
  layerName: string;
  /** Provider label for envelopes. */
  provider: string;
  /**
   * Published dataset vintage, or null when the county does not publish one
   * (never invent a vintage — provenance honesty).
   */
  vintage: string | null;
  /** Attribute carrying the feature name (e.g. GNIS_Name), if any. */
  nameField: string | null;
  /** Attribute carrying the feature type (e.g. FEATURE_TY), if any. */
  featureTypeField: string | null;
  /** outFields for the query (comma-separated attribute allowlist). */
  outFields: string;
  /** County footprint in WGS84 — bbox registry resolution + network skip. */
  footprint: BboxWgs84;
  /**
   * Whether the layer supports resultOffset/resultRecordCount paging. When
   * false (Bastrop MapServer) the adapter must NOT send paging params — the
   * server 400s on them — and truncation is reported via
   * `exceededTransferLimit` instead.
   */
  supportsPagination: boolean;
  /** Server maxRecordCount (page ceiling for a single query). */
  maxRecordCount: number;
}

export const BASTROP_HYDROGRAPHY_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/Hydrography/Creeks_Streams/MapServer/0";

export const BASTROP_HYDROGRAPHY_SOURCE: CountyHydrographySource = {
  countyKey: "bastrop-tx",
  sourceKey: "bastrop-county:Creeks_Streams",
  serviceUrl: BASTROP_HYDROGRAPHY_URL,
  layerName: "Bastrop County Creeks & Streams",
  provider: "Bastrop County GIS (Hydrography/Creeks_Streams)",
  // The service metadata publishes no dataset vintage (documentInfo empty;
  // per-feature FDate only) — honest null, never an invented year.
  vintage: null,
  nameField: "GNIS_Name",
  featureTypeField: "FEATURE_TY",
  outFields: "GNIS_Name,FEATURE_TY,ReachCode,LengthKM,FCode",
  // Same conservative Bastrop County envelope the 1-ft contour source uses.
  footprint: {
    westLng: -97.72,
    southLat: 29.9,
    eastLng: -96.94,
    northLat: 30.55,
  },
  supportsPagination: false,
  maxRecordCount: 1000,
};

/**
 * Per-county mapped-hydrography registry. Adding a county = adding an entry
 * (descriptor-driven, county-agnostic mechanism per the CTX mold).
 */
export const COUNTY_HYDROGRAPHY_SOURCES: readonly CountyHydrographySource[] = [
  BASTROP_HYDROGRAPHY_SOURCE,
];

function bboxesIntersect(a: BboxWgs84, b: BboxWgs84): boolean {
  return (
    a.westLng <= b.eastLng &&
    a.eastLng >= b.westLng &&
    a.southLat <= b.northLat &&
    a.northLat >= b.southLat
  );
}

/**
 * Resolve the configured hydrography source whose county footprint intersects
 * a bbox. `null` = no county source configured for this viewport — the caller
 * returns honest-unavailable, never a derived/substituted layer.
 */
export function resolveCountyHydrographySource(
  bbox: BboxWgs84,
  registry: readonly CountyHydrographySource[] = COUNTY_HYDROGRAPHY_SOURCES,
): CountyHydrographySource | null {
  return registry.find((s) => bboxesIntersect(bbox, s.footprint)) ?? null;
}

/** GeoJSON feature emitted for a county-mapped water feature. */
export interface CountyHydrographyFeature {
  type: "Feature";
  geometry: {
    type: "LineString" | "MultiLineString" | "Polygon";
    coordinates: unknown;
  };
  properties: {
    /** Trimmed feature name (e.g. "Piney Creek"), null when unnamed. */
    name: string | null;
    /** County feature type (e.g. "STREAM/RIVER"), null when absent. */
    featureType: string | null;
    [key: string]: unknown;
  };
}

export interface FetchCountyHydrographyResult {
  features: CountyHydrographyFeature[];
  featureCount: number;
  /**
   * True when the server hit its transfer limit or the client cap trimmed the
   * set — the viewport shows a PARTIAL mapped-hydrography picture ("zoom in").
   */
  truncated: boolean;
  elapsedMs: number;
  sourceUrl: string;
  sourceKey: string;
  layerName: string;
  vintage: string | null;
  /** Bbox actually queried, echoed for provenance. */
  bbox: BboxWgs84;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type EsriGeometry = {
  paths?: number[][][];
  rings?: number[][][];
};

function parseCoordArrays(raw: number[][][] | undefined): Array<Array<[number, number]>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Array<[number, number]>> = [];
  for (const part of raw) {
    if (!Array.isArray(part) || part.length < 2) continue;
    const coords: Array<[number, number]> = [];
    for (const pt of part) {
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
 * Esri geometry -> GeoJSON geometry. Polylines (paths) become LineString /
 * MultiLineString; polygons (rings) become Polygon. Returns null for empty or
 * unsupported geometry (feature is skipped, never fabricated).
 */
function esriToGeoJsonGeometry(
  geometry: EsriGeometry | undefined,
): CountyHydrographyFeature["geometry"] | null {
  if (geometry?.paths) {
    const paths = parseCoordArrays(geometry.paths);
    if (paths.length === 0) return null;
    return paths.length === 1
      ? { type: "LineString", coordinates: paths[0]! }
      : { type: "MultiLineString", coordinates: paths };
  }
  if (geometry?.rings) {
    const rings = parseCoordArrays(geometry.rings);
    if (rings.length === 0) return null;
    return { type: "Polygon", coordinates: rings };
  }
  return null;
}

/**
 * Fetch the county-mapped water features intersecting a WGS84 bbox from a
 * registered county source. Single envelope query (see the pagination note in
 * the module doc); truncation is reported honestly via `truncated`. Returns an
 * empty feature list (not an error) when the bbox is outside the county
 * footprint or intersects no mapped features.
 */
export async function fetchCountyHydrography(
  source: CountyHydrographySource,
  bbox: BboxWgs84,
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** Client-side cap on features kept (bbox-guard belt-and-suspenders). */
    maxFeatures?: number;
  } = {},
): Promise<FetchCountyHydrographyResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxFeatures = options.maxFeatures ?? 5_000;
  const t0 = Date.now();

  const base: FetchCountyHydrographyResult = {
    features: [],
    featureCount: 0,
    truncated: false,
    elapsedMs: 0,
    sourceUrl: source.serviceUrl,
    sourceKey: source.sourceKey,
    layerName: source.layerName,
    vintage: source.vintage,
    bbox,
  };

  // Skip the network entirely for clearly-out-of-county bboxes.
  if (!bboxesIntersect(bbox, source.footprint)) {
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

  const url = new URL(`${source.serviceUrl.replace(/\/$/, "")}/query`);
  url.searchParams.set("f", "json");
  url.searchParams.set("where", "1=1");
  url.searchParams.set("geometry", JSON.stringify(envelope));
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", source.outFields);
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  // NOTE: no resultRecordCount/resultOffset — sources with
  // supportsPagination:false (Bastrop) HTTP-400 on them.

  const res = await fetchImpl(url.toString(), {
    headers: {
      "User-Agent": COUNTY_HYDROGRAPHY_USER_AGENT,
      Accept: "application/json",
    },
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(`${source.sourceKey} HTTP ${res.status}: ${res.statusText}`);
  }
  const body = (await res.json()) as {
    error?: { message?: string };
    features?: Array<{
      attributes?: Record<string, unknown>;
      geometry?: EsriGeometry;
    }>;
    exceededTransferLimit?: boolean;
  };
  if (body.error) {
    throw new Error(
      `${source.sourceKey} ArcGIS error: ${body.error.message ?? "unknown"}`,
    );
  }

  const features: CountyHydrographyFeature[] = [];
  let clientCapped = false;
  for (const raw of body.features ?? []) {
    if (features.length >= maxFeatures) {
      clientCapped = true;
      break;
    }
    const geometry = esriToGeoJsonGeometry(raw.geometry);
    if (!geometry) continue;
    const attrs = raw.attributes ?? {};
    features.push({
      type: "Feature",
      geometry,
      properties: {
        ...attrs,
        name: source.nameField ? cleanText(attrs[source.nameField]) : null,
        featureType: source.featureTypeField
          ? cleanText(attrs[source.featureTypeField])
          : null,
      },
    });
  }

  return {
    ...base,
    features,
    featureCount: features.length,
    truncated: Boolean(body.exceededTransferLimit) || clientCapped,
    elapsedMs: Date.now() - t0,
  };
}
