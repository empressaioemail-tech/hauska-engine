/**
 * Live Overpass bbox fetch for road-node intake (27c R4).
 * Same etiquette headers as Grand County OSM fallback — no special Bastrop path.
 */

import type { ParsedOsmElement } from "./types.js";

export const OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

export const OVERPASS_USER_AGENT =
  "hauska-engine/1.0 (+https://cortex.empressa.io; depth-engine R4)";

/** Overpass server-side timeout (seconds). */
export const OVERPASS_QL_TIMEOUT_SEC = 180;

/** Bastrop County, TX (48021) — public county extent for road bulk ingest. */
export const BASTROP_COUNTY_BBOX = {
  south: 29.8937,
  west: -97.6378,
  north: 30.3997,
  east: -96.9097,
} as const;

export interface OverpassBbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface FetchOverpassRoadsResult {
  elements: ParsedOsmElement[];
  elapsedMs: number;
  query: string;
}

function buildBboxQuery(bbox: OverpassBbox): string {
  const { south, west, north, east } = bbox;
  return `[out:json][timeout:${OVERPASS_QL_TIMEOUT_SEC}];(way["highway"](${south},${west},${north},${east}););out body geom;`;
}

/**
 * POST an Overpass interpreter query for all highway ways in a bbox.
 * Returns parsed way elements with geometry (out body geom).
 */
export async function fetchOverpassRoadsInBbox(
  bbox: OverpassBbox,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchOverpassRoadsResult> {
  const query = buildBboxQuery(bbox);
  const t0 = performance.now();
  const response = await fetchImpl(OSM_OVERPASS_URL, {
    method: "POST",
    body: query,
    headers: {
      "Content-Type": "text/plain",
      "User-Agent": OVERPASS_USER_AGENT,
      Accept: "application/json, */*;q=0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Overpass HTTP ${response.status}: ${response.statusText}`);
  }
  const body = (await response.json()) as { elements?: ParsedOsmElement[] };
  const elapsedMs = Math.round(performance.now() - t0);
  const elements = (body.elements ?? []).filter(
    (el) => el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2,
  );
  return { elements, elapsedMs, query };
}

export function parseBastropBboxFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OverpassBbox {
  const raw = env.BASTROP_ROAD_BBOX?.trim();
  if (!raw) return { ...BASTROP_COUNTY_BBOX };
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(
      "BASTROP_ROAD_BBOX must be south,west,north,east (four comma-separated numbers)",
    );
  }
  return { south: parts[0]!, west: parts[1]!, north: parts[2]!, east: parts[3]! };
}
