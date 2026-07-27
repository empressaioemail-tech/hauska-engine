/**
 * Live ArcGIS fetch for Caldwell CAD Road_Centerlines (FeatureServer layer 6).
 * RECIPE-PROOF county #2 / 48055.
 */

import type { CaldwellCadRoadAttributes } from "./classify-caldwell-cad.js";

export const CALDWELL_CAD_ROAD_CENTERLINES_URL =
  "https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/Caldwell_CAD_Parcel_Map/FeatureServer/6";

export const CALDWELL_CAD_ROAD_USER_AGENT =
  "hauska-engine/1.0 (+https://cortex.empressa.io; recipe-proof-48055)";

const PAGE_SIZE = 1000;

export interface CaldwellCadRoadFeature {
  objectId: number;
  attributes: CaldwellCadRoadAttributes;
  centerline: ReadonlyArray<readonly [number, number]>;
}

export interface FetchCaldwellCadRoadsResult {
  features: CaldwellCadRoadFeature[];
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
}): CaldwellCadRoadFeature | null {
  const attrs = (raw.attributes ?? {}) as CaldwellCadRoadAttributes;
  const objectId = Number(attrs.OBJECTID ?? attrs.objectid);
  if (!Number.isFinite(objectId)) return null;
  const centerline = parseArcGisPaths(raw.geometry);
  if (!centerline) return null;
  return { objectId, attributes: attrs, centerline };
}

export async function fetchCaldwellCadRoadFeatures(
  options: {
    serviceUrl?: string;
    fetchImpl?: typeof fetch;
    where?: string;
    outFields?: string;
    outSr?: number;
  } = {},
): Promise<FetchCaldwellCadRoadsResult> {
  const serviceUrl = (options.serviceUrl ?? CALDWELL_CAD_ROAD_CENTERLINES_URL).replace(
    /\/$/,
    "",
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const where = options.where ?? "1=1";
  const outFields = options.outFields ?? "*";
  const outSr = options.outSr ?? 4326;
  const t0 = performance.now();
  const features: CaldwellCadRoadFeature[] = [];
  let offset = 0;
  let pagesFetched = 0;

  for (;;) {
    const url =
      `${serviceUrl}/query?where=${encodeURIComponent(where)}` +
      `&outFields=${encodeURIComponent(outFields)}` +
      `&returnGeometry=true&outSR=${outSr}` +
      `&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}&f=json`;
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": CALDWELL_CAD_ROAD_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Caldwell CAD roads fetch HTTP ${response.status} at offset ${offset}`);
    }
    const body = (await response.json()) as {
      features?: Array<{
        attributes?: Record<string, unknown>;
        geometry?: { paths?: number[][][] };
      }>;
      exceededTransferLimit?: boolean;
    };
    pagesFetched += 1;
    const page = body.features ?? [];
    for (const raw of page) {
      const parsed = parseFeature(raw);
      if (parsed) features.push(parsed);
    }
    if (page.length < PAGE_SIZE && !body.exceededTransferLimit) break;
    if (page.length === 0) break;
    offset += page.length;
  }

  return {
    features,
    elapsedMs: Math.round(performance.now() - t0),
    pagesFetched,
    sourceUrl: serviceUrl,
  };
}
