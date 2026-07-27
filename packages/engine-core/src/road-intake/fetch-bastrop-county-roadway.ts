/**
 * Live ArcGIS fetch for Bastrop County Roadway (27f S2-F).
 * Comprehensive city + county centerline grid — retires city OSM proxy.
 */

import type { BastropRoadwayAttributes } from "./classify-county-street.js";

export const BASTROP_COUNTY_ROADWAY_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/Transportation_BP/Bastrop_County_Roadway/MapServer/0";

export const BASTROP_COUNTY_ROADWAY_USER_AGENT =
  "hauska-engine/1.0 (+https://cortex.empressa.io; depth-engine S2-F)";

const PAGE_SIZE = 1000;

export interface BastropRoadwayFeature {
  objectId: number;
  attributes: BastropRoadwayAttributes & { objectid?: number };
  centerline: ReadonlyArray<readonly [number, number]>;
}

export interface FetchBastropCountyRoadwayResult {
  features: BastropRoadwayFeature[];
  elapsedMs: number;
  pagesFetched: number;
  sourceUrl: string;
}

function parseArcGisPaths(
  geometry: { paths?: number[][][] } | undefined,
): ReadonlyArray<readonly [number, number]> | null {
  const paths = geometry?.paths;
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const ring = paths[0];
  if (!Array.isArray(ring) || ring.length < 2) return null;
  const coords: [number, number][] = [];
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const x = Number(pt[0]);
    const y = Number(pt[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    coords.push([x, y]);
  }
  return coords.length >= 2 ? coords : null;
}

function parseFeature(raw: {
  attributes?: Record<string, unknown>;
  geometry?: { paths?: number[][][] };
}): BastropRoadwayFeature | null {
  const attrs = raw.attributes ?? {};
  const objectId = Number(attrs.objectid);
  if (!Number.isFinite(objectId)) return null;
  const centerline = parseArcGisPaths(raw.geometry);
  if (!centerline) return null;
  return {
    objectId,
    attributes: attrs as BastropRoadwayAttributes & { objectid?: number },
    centerline,
  };
}

export async function fetchBastropCountyRoadwayFeatures(
  options: {
    serviceUrl?: string;
    fetchImpl?: typeof fetch;
    where?: string;
    outFields?: string;
  } = {},
): Promise<FetchBastropCountyRoadwayResult> {
  const serviceUrl = (options.serviceUrl ?? BASTROP_COUNTY_ROADWAY_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const where = options.where ?? "1=1";
  const outFields = options.outFields ?? "*";
  const t0 = performance.now();
  const features: BastropRoadwayFeature[] = [];
  let offset = 0;
  let pagesFetched = 0;

  for (;;) {
    const url = new URL(`${serviceUrl}/query`);
    url.searchParams.set("f", "json");
    url.searchParams.set("where", where);
    url.searchParams.set("outFields", outFields);
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
    url.searchParams.set("resultOffset", String(offset));

    const response = await fetchImpl(url.toString(), {
      headers: {
        "User-Agent": BASTROP_COUNTY_ROADWAY_USER_AGENT,
        Accept: "application/json, */*;q=0.1",
      },
    });
    if (!response.ok) {
      throw new Error(`Bastrop_County_Roadway HTTP ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as {
      error?: { message?: string };
      features?: Array<{ attributes?: Record<string, unknown>; geometry?: { paths?: number[][][] } }>;
      exceededTransferLimit?: boolean;
    };
    if (body.error) {
      throw new Error(`Bastrop_County_Roadway ArcGIS error: ${body.error.message ?? "unknown"}`);
    }
    for (const raw of body.features ?? []) {
      const parsed = parseFeature(raw);
      if (parsed) features.push(parsed);
    }
    pagesFetched++;
    if (!body.exceededTransferLimit) break;
    offset += PAGE_SIZE;
  }

  return {
    features,
    elapsedMs: Math.round(performance.now() - t0),
    pagesFetched,
    sourceUrl: serviceUrl,
  };
}
