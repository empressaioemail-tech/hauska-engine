/**
 * Live Overpass bbox fetch for road-node intake (27c R4 / R4.2).
 * Same etiquette headers as Grand County OSM fallback — no special Bastrop path.
 */

import type { ParsedOsmElement } from "./types.js";
import type { OverpassFetchOutcome } from "./honest-fallback.js";

export const OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

export const OVERPASS_USER_AGENT =
  "hauska-engine/1.0 (+https://cortex.empressa.io; depth-engine R4.2)";

/** Overpass server-side timeout (seconds). */
export const OVERPASS_QL_TIMEOUT_SEC = 180;

/** Bounded retry on transient Overpass failures (QA4 — 504 / gateway blips). */
export const OVERPASS_MAX_ATTEMPTS = 3;
export const OVERPASS_RETRY_BASE_MS = 500;
export const OVERPASS_RETRY_MAX_MS = 2_000;
export const OVERPASS_TRANSIENT_HTTP = new Set([408, 429, 502, 503, 504]);

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

/** Caldwell County, TX (48055) — approximate public county extent. */
export const CALDWELL_COUNTY_BBOX = {
  south: 29.62,
  west: -97.9,
  north: 30.12,
  east: -97.55,
} as const;

/**
 * City of Lockhart limits from Caldwell CAD City_Limits layer (outSR=4326,
 * RECIPE-PROOF 2026-07-27 recon).
 */
export const LOCKHART_CITY_BBOX = {
  south: 29.83787,
  west: -97.72866,
  north: 29.9244,
  east: -97.62483,
} as const;

/**
 * City of Elgin limits (Bastrop-county side, 48021) from AGOL Elgin_Zoning
 * FeatureServer/0 extent query (same layer as ELGIN_REGISTRY_ROW):
 *   https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/Elgin_Zoning/FeatureServer/0/query?where=CITY_LIMIT%3D%27ELGIN%27&returnExtentOnly=true&outSR=4326&f=json
 * Fetched 2026-08-04 by planner via curl; verbatim extent:
 *   xmin=-97.410938698399292 ymin=30.313790730771967
 *   xmax=-97.355026917826052 ymax=30.369229436331114
 * OSM cross-check timed out (server busy); primary source is AGOL zoning envelope
 * (aligns with Lockhart CAD City_Limits precedent, not undocumented Bastrop hand-tune).
 */
export const ELGIN_CITY_BBOX = {
  south: 30.313790730771967,
  west: -97.410938698399292,
  north: 30.369229436331114,
  east: -97.355026917826052,
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
  scope?: BastropRoadIngestScope | "custom";
  /** Attempts consumed (1 = first try succeeded). */
  attempts?: number;
}

export interface FetchOverpassOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(
  attemptIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attemptIndex);
  const jitter = Math.floor(Math.random() * Math.min(100, baseDelayMs));
  return exp + jitter;
}

/**
 * POST an Overpass interpreter query for all highway ways in a bbox.
 * Bounded retry/backoff on transient HTTP (504/502/503/408/429) — QA4.
 * Returns parsed way elements with geometry (out body geom).
 */
export async function fetchOverpassRoadsInBbox(
  bbox: OverpassBbox,
  fetchImpl: typeof fetch = fetch,
  options: Omit<FetchOverpassOptions, "fetchImpl"> = {},
): Promise<FetchOverpassRoadsResult> {
  const outcome = await fetchOverpassRoadsInBboxOutcome(bbox, {
    ...options,
    fetchImpl,
  });
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return {
    elements: outcome.elements,
    elapsedMs: outcome.elapsedMs,
    query: outcome.query ?? buildBboxQuery(bbox),
    attempts: outcome.attempts,
  };
}

/**
 * Same as {@link fetchOverpassRoadsInBbox} but returns an outcome object
 * instead of throwing — used by honest-fallback orchestration (QA4).
 */
export async function fetchOverpassRoadsInBboxOutcome(
  bbox: OverpassBbox,
  options: FetchOverpassOptions = {},
): Promise<OverpassFetchOutcome & { query?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? OVERPASS_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? OVERPASS_RETRY_BASE_MS;
  const maxDelayMs = options.maxDelayMs ?? OVERPASS_RETRY_MAX_MS;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const query = buildBboxQuery(bbox);
  const t0 = performance.now();
  let lastError = "Overpass request failed";
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
        lastStatus = response.status;
        lastError = `Overpass HTTP ${response.status}: ${response.statusText || "error"}`;
        const retryable = OVERPASS_TRANSIENT_HTTP.has(response.status);
        if (retryable && attempt < maxAttempts) {
          await sleepImpl(retryDelayMs(attempt - 1, baseDelayMs, maxDelayMs));
          continue;
        }
        return {
          ok: false,
          error: `${lastError} after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
          attempts: attempt,
          statusCode: response.status,
          elapsedMs: Math.round(performance.now() - t0),
          query,
        };
      }
      const body = (await response.json()) as { elements?: ParsedOsmElement[] };
      return {
        ok: true,
        elements: filterWayElements(body.elements),
        attempts: attempt,
        elapsedMs: Math.round(performance.now() - t0),
        query,
      };
    } catch (err) {
      lastError =
        err instanceof Error ? err.message : `Overpass fetch failed: ${String(err)}`;
      if (attempt < maxAttempts) {
        await sleepImpl(retryDelayMs(attempt - 1, baseDelayMs, maxDelayMs));
        continue;
      }
      return {
        ok: false,
        error: `${lastError} after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
        attempts: attempt,
        statusCode: lastStatus,
        elapsedMs: Math.round(performance.now() - t0),
        query,
      };
    }
  }

  return {
    ok: false,
    error: `${lastError} after ${maxAttempts} attempts`,
    attempts: maxAttempts,
    statusCode: lastStatus,
    elapsedMs: Math.round(performance.now() - t0),
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
 *
 * QA4: when scope is `county` (single county query that often 504s), fail over
 * to the preferred city-scope bbox after bounded retries — never silently
 * return zero as if the county has no roads.
 */
export async function fetchBastropRoadsForIngest(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  options: Omit<FetchOverpassOptions, "fetchImpl"> = {},
): Promise<
  FetchOverpassRoadsResult & {
    bbox: OverpassBbox;
    scope: BastropRoadIngestScope | "custom";
    preferredCityFallback?: boolean;
  }
> {
  const { bbox, scope } = resolveBastropRoadIngestBbox(env);
  if (scope === "county-tiled") {
    const tiled = await fetchOverpassRoadsTiled(bbox, { fetchImpl });
    return { ...tiled, bbox, scope };
  }

  const outcome = await fetchOverpassRoadsInBboxOutcome(bbox, {
    ...options,
    fetchImpl,
  });
  if (outcome.ok) {
    return {
      elements: outcome.elements,
      elapsedMs: outcome.elapsedMs,
      query: outcome.query ?? buildBboxQuery(bbox),
      attempts: outcome.attempts,
      bbox,
      scope,
    };
  }

  // Prefer city-scope over a county single-query that 504s (QA4 / LESSON).
  if (scope === "county") {
    const cityOutcome = await fetchOverpassRoadsInBboxOutcome(
      { ...BASTROP_CITY_BBOX },
      { ...options, fetchImpl },
    );
    if (cityOutcome.ok) {
      return {
        elements: cityOutcome.elements,
        elapsedMs: cityOutcome.elapsedMs,
        query: cityOutcome.query ?? buildBboxQuery(BASTROP_CITY_BBOX),
        attempts: cityOutcome.attempts,
        bbox: { ...BASTROP_CITY_BBOX },
        scope: "city",
        preferredCityFallback: true,
      };
    }
    throw new Error(
      `${outcome.error}; city-scope fallback also failed: ${cityOutcome.error}`,
    );
  }

  throw new Error(outcome.error);
}

/**
 * Outcome-shaped Bastrop overpass fetch for honest-fallback orchestration.
 * Does not throw on 504 — caller resolves coverage via resolveHonestRoadCoverage.
 */
export async function fetchBastropOverpassOutcome(
  env: NodeJS.ProcessEnv = process.env,
  options: FetchOverpassOptions = {},
): Promise<
  OverpassFetchOutcome & {
    bbox: OverpassBbox;
    scope: BastropRoadIngestScope | "custom";
    query?: string;
    preferredCityFallback?: boolean;
  }
> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { bbox, scope } = resolveBastropRoadIngestBbox(env);

  if (scope === "county-tiled") {
    try {
      const tiled = await fetchOverpassRoadsTiled(bbox, { fetchImpl });
      return {
        ok: true,
        elements: tiled.elements,
        attempts: 1,
        elapsedMs: tiled.elapsedMs,
        query: tiled.query,
        bbox,
        scope,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        attempts: 1,
        elapsedMs: 0,
        bbox,
        scope,
      };
    }
  }

  const outcome = await fetchOverpassRoadsInBboxOutcome(bbox, {
    ...options,
    fetchImpl,
  });
  if (outcome.ok) {
    return { ...outcome, bbox, scope };
  }

  if (scope === "county") {
    const cityOutcome = await fetchOverpassRoadsInBboxOutcome(
      { ...BASTROP_CITY_BBOX },
      { ...options, fetchImpl },
    );
    if (cityOutcome.ok) {
      return {
        ...cityOutcome,
        bbox: { ...BASTROP_CITY_BBOX },
        scope: "city",
        preferredCityFallback: true,
      };
    }
    return {
      ok: false,
      error: `${outcome.error}; city-scope fallback also failed: ${cityOutcome.error}`,
      attempts: outcome.attempts + cityOutcome.attempts,
      statusCode: cityOutcome.statusCode ?? outcome.statusCode,
      elapsedMs: outcome.elapsedMs + cityOutcome.elapsedMs,
      bbox,
      scope,
    };
  }

  return { ...outcome, bbox, scope };
}

export type CaldwellRoadIngestScope = "lockhart-city" | "county" | "county-tiled";

/** Default Lockhart city OSM ingest for Caldwell depth-warm (city streets sparse in CAD). */
export function resolveCaldwellRoadIngestBbox(
  env: NodeJS.ProcessEnv = process.env,
): { bbox: OverpassBbox; scope: CaldwellRoadIngestScope | "custom" } {
  const raw = env.CALDWELL_ROAD_BBOX?.trim();
  if (raw) {
    const parts = raw.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(
        "CALDWELL_ROAD_BBOX must be south,west,north,east (four comma-separated numbers)",
      );
    }
    return {
      bbox: { south: parts[0]!, west: parts[1]!, north: parts[2]!, east: parts[3]! },
      scope: "custom",
    };
  }
  const scopeRaw = env.CALDWELL_ROAD_INGEST_SCOPE?.trim().toLowerCase();
  if (scopeRaw === "county") {
    return { bbox: { ...CALDWELL_COUNTY_BBOX }, scope: "county" };
  }
  if (scopeRaw === "county-tiled") {
    return { bbox: { ...CALDWELL_COUNTY_BBOX }, scope: "county-tiled" };
  }
  return { bbox: { ...LOCKHART_CITY_BBOX }, scope: "lockhart-city" };
}

export async function fetchCaldwellRoadsForIngest(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  elements: ParsedOsmElement[];
  elapsedMs: number;
  query: string;
  tilesFetched?: number;
  bbox: OverpassBbox;
  scope: CaldwellRoadIngestScope | "custom";
}> {
  const { bbox, scope } = resolveCaldwellRoadIngestBbox(env);
  if (scope === "county-tiled") {
    const tiled = await fetchOverpassRoadsTiled(bbox, { fetchImpl });
    return {
      elements: tiled.elements,
      elapsedMs: tiled.elapsedMs,
      query: tiled.query,
      tilesFetched: tiled.tilesFetched,
      bbox,
      scope,
    };
  }
  const single = await fetchOverpassRoadsInBbox(bbox, fetchImpl);
  return {
    elements: single.elements,
    elapsedMs: single.elapsedMs,
    query: single.query,
    bbox,
    scope,
  };
}
