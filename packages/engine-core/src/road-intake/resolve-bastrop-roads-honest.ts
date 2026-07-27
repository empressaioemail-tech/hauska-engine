/**
 * QA4 — resolve Bastrop road intake with honest overpass fallback.
 *
 * Orchestrates: overpass (retry + prefer city) → county presence probe →
 * resolveHonestRoadCoverage. Never returns silent zero roads on overpass 504.
 */

import {
  resolveHonestRoadCoverage,
  type FallbackSourcePresence,
  type HonestRoadCoverage,
  type OverpassFetchOutcome,
} from "./honest-fallback.js";
import {
  BASTROP_COUNTY_ROADWAY_URL,
  BASTROP_COUNTY_ROADWAY_USER_AGENT,
} from "./fetch-bastrop-county-roadway.js";
import {
  STREETS_SURVEYED_2016_URL,
  STREETS_SURVEYED_USER_AGENT,
} from "./fetch-streets-surveyed-2016.js";
import {
  fetchBastropOverpassOutcome,
  type FetchOverpassOptions,
} from "./fetch-overpass-bbox.js";

export interface ResolveBastropRoadsHonestOptions extends FetchOverpassOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected fallback presence (tests). When omitted, ArcGIS count is probed. */
  fallbackPresence?: FallbackSourcePresence;
}

export interface ResolveBastropRoadsHonestResult {
  coverage: HonestRoadCoverage;
  overpass: OverpassFetchOutcome & {
    bbox?: unknown;
    scope?: string;
    preferredCityFallback?: boolean;
  };
  fallback: FallbackSourcePresence;
}

async function arcgisFeatureCount(
  serviceUrl: string,
  fetchImpl: typeof fetch,
  userAgent: string,
): Promise<number> {
  const url = new URL(`${serviceUrl.replace(/\/$/, "")}/query`);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("returnCountOnly", "true");
  url.searchParams.set("f", "json");
  const res = await fetchImpl(url.toString(), {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ArcGIS HTTP ${res.status} for ${serviceUrl}`);
  }
  const body = (await res.json()) as {
    count?: number;
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(body.error.message ?? "ArcGIS error");
  }
  return typeof body.count === "number" ? body.count : 0;
}

/** Probe whether county roadway / surveyed-2016 can cover an overpass outage. */
export async function probeBastropRoadFallbackPresence(
  fetchImpl: typeof fetch = fetch,
): Promise<FallbackSourcePresence> {
  let countyRoadwayCount = 0;
  let streetsSurveyedCount = 0;
  try {
    countyRoadwayCount = await arcgisFeatureCount(
      BASTROP_COUNTY_ROADWAY_URL,
      fetchImpl,
      BASTROP_COUNTY_ROADWAY_USER_AGENT,
    );
  } catch {
    countyRoadwayCount = 0;
  }
  try {
    streetsSurveyedCount = await arcgisFeatureCount(
      STREETS_SURVEYED_2016_URL,
      fetchImpl,
      STREETS_SURVEYED_USER_AGENT,
    );
  } catch {
    streetsSurveyedCount = 0;
  }
  return { countyRoadwayCount, streetsSurveyedCount };
}

/**
 * Full honest resolve: overpass outcome + fallback presence → coverage state.
 * Mechanical entry point for ingest + probe semantics (QA4).
 */
export async function resolveBastropRoadsHonest(
  options: ResolveBastropRoadsHonestOptions = {},
): Promise<ResolveBastropRoadsHonestResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const overpass = await fetchBastropOverpassOutcome(options.env ?? process.env, {
    fetchImpl,
    maxAttempts: options.maxAttempts,
    baseDelayMs: options.baseDelayMs,
    maxDelayMs: options.maxDelayMs,
    sleepImpl: options.sleepImpl,
  });

  const fallback =
    options.fallbackPresence ??
    (await probeBastropRoadFallbackPresence(fetchImpl));

  const coverage = resolveHonestRoadCoverage(overpass, fallback);
  return { coverage, overpass, fallback };
}
