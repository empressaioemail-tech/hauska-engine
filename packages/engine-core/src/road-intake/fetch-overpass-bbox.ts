/**
 * Live Overpass bbox fetch for road-node intake (27c R4 / R4.2).
 * Same etiquette headers as Grand County OSM fallback — no special Bastrop path.
 */

import type { ParsedOsmElement } from "./types.js";

export const OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

export const OVERPASS_USER_AGENT =
  "hauska-engine/1.0 (+https://cortex.empressa.io; depth-engine R4.2)";

/** Overpass server-side timeout (seconds). */
export const OVERPASS_QL_TIMEOUT_SEC = 180;

/** Bastrop County, TX (48021) — public county extent for road bulk ingest. */
export const BASTROP_COUNTY_BBOX = {
  south: 29.8937,
  west: -97.6378,
  north: 30.3997,
  east: -96.9097,
} as const;

/** Bastrop city limits + near-ETJ core — depth-warm city cohort (R4.1 / R4.2). */
export const BASTROP_CITY_BBOX = {
  south: 30.04,
  west: -97.38,
  north: 30.16,
  east: -97.25,
} as const;

export type BastropRoadIngestScope = "city" | "county" | "county-tiled";

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
  tilesFetched?: number;
  scope?: BastropRoadIngestScope;
}

function buildBboxQuery(bbox: OverpassBbox): string {
  const { south, west, north, east } = bbox;
  return `[out:json][timeout:${OVERPASS_QL_TIMEOUT_SEC}];(way["highway"](${south},${west},${north},${east}););out body geom;`;
}

function parseBboxCsv(raw: string): OverpassBbox {
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(
      "BASTROP_ROAD_BBOX must be south,west,north,east (four comma-separated numbers)",
    );
  }
  return { south: parts[0]!, west: parts[1]!, north: parts[2]!, east: parts[3]! };
}

/**
 * Resolve ingest scope. Default `city` — full BASTROP_CITY_BBOX (~5k OSM ways, ~3s).
 * County single-query 504s on overpass-api.de; use `county-tiled` when county coverage is required.
 */
export function resolveBastropRoadIngestScope(
  env: NodeJS.ProcessEnv = process.env,
): BastropRoadIngestScope {
  const raw = env.BASTROP_ROAD_INGEST_SCOPE?.trim().toLowerCase();
  if (raw === "city" || raw === "county" || raw === "county-tiled") {
    return raw;
  }
  return "city";
}

/** Bbox for road ingest: explicit BASTROP_ROAD_BBOX wins; else scope-derived preset. */
export function resolveBastropRoadIngestBbox(
  env: NodeJS.ProcessEnv = process.env,
): { bbox: OverpassBbox; scope: BastropRoadIngestScope | "custom" } {
  const raw = env.BASTROP_ROAD_BBOX?.trim();
  if (raw) {
    return { bbox: parseBboxCsv(raw), scope: "custom" };
  }
  const scope = resolveBastropRoadIngestScope(env);
  if (scope === "city") {
    return { bbox: { ...BASTROP_CITY_BBOX }, scope: "city" };
  }
  return { bbox: { ...BASTROP_COUNTY_BBOX }, scope };
}

/** @deprecated Prefer resolveBastropRoadIngestBbox — kept for callers/tests. */
export function parseBastropBboxFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OverpassBbox {
  return resolveBastropRoadIngestBbox(env).bbox;
}

function filterWayElements(elements: ParsedOsmElement[] | undefined): ParsedOsmElement[] {
  return (elements ?? []).filter(
    (el) => el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2,
  );
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
  return {
    elements: filterWayElements(body.elements),
    elapsedMs,
    query,
  };
}

export interface FetchOverpassRoadsTiledOptions {
  tilesX?: number;
  tilesY?: number;
  fetchImpl?: typeof fetch;
  pauseMs?: number;
}

function splitBbox(bbox: OverpassBbox, tilesX: number, tilesY: number): OverpassBbox[] {
  const latStep = (bbox.north - bbox.south) / tilesY;
  const lngStep = (bbox.east - bbox.west) / tilesX;
  const tiles: OverpassBbox[] = [];
  for (let yi = 0; yi < tilesY; yi++) {
    for (let xi = 0; xi < tilesX; xi++) {
      tiles.push({
        south: bbox.south + yi * latStep,
        west: bbox.west + xi * lngStep,
        north: yi === tilesY - 1 ? bbox.north : bbox.south + (yi + 1) * latStep,
        east: xi === tilesX - 1 ? bbox.east : bbox.west + (xi + 1) * lngStep,
      });
    }
  }
  return tiles;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tile a large bbox (county) to avoid Overpass 504 gateway timeouts.
 * Dedupes OSM ways by id across tiles.
 */
export async function fetchOverpassRoadsTiled(
  bbox: OverpassBbox,
  options: FetchOverpassRoadsTiledOptions = {},
): Promise<FetchOverpassRoadsResult> {
  const tilesX = Math.max(1, options.tilesX ?? 3);
  const tilesY = Math.max(1, options.tilesY ?? 3);
  const fetchImpl = options.fetchImpl ?? fetch;
  const pauseMs = options.pauseMs ?? 750;
  const tiles = splitBbox(bbox, tilesX, tilesY);
  const t0 = performance.now();
  const byId = new Map<number, ParsedOsmElement>();
  const queries: string[] = [];

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    const result = await fetchOverpassRoadsInBbox(tile, fetchImpl);
    queries.push(result.query);
    for (const el of result.elements) {
      if (typeof el.id === "number") byId.set(el.id, el);
    }
    if (i < tiles.length - 1 && pauseMs > 0) {
      await sleep(pauseMs);
    }
  }

  return {
    elements: [...byId.values()],
    elapsedMs: Math.round(performance.now() - t0),
    query: queries.join("\n---\n"),
    tilesFetched: tiles.length,
    scope: "county-tiled",
  };
}

/**
 * Fetch roads for resolved Bastrop ingest scope.
 * `county-tiled` uses a 3×3 grid over BASTROP_COUNTY_BBOX.
 */
export async function fetchBastropRoadsForIngest(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchOverpassRoadsResult & { bbox: OverpassBbox; scope: BastropRoadIngestScope | "custom" }> {
  const { bbox, scope } = resolveBastropRoadIngestBbox(env);
  if (scope === "county-tiled") {
    const tiled = await fetchOverpassRoadsTiled(bbox, { fetchImpl });
    return { ...tiled, bbox, scope };
  }
  const single = await fetchOverpassRoadsInBbox(bbox, fetchImpl);
  return { ...single, bbox, scope };
}
