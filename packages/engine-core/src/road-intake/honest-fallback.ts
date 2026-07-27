/**
 * QA4 — honest road-source fallback when osm-overpass 504s / times out.
 *
 * Silent zero-roads is impossible:
 *   - overpass ok → roads from OSM
 *   - overpass down + county roadway / surveyed present → degraded-covered
 *     (roads still emitted from fallback; named as fallback-active)
 *   - overpass down + no fallback → degraded-no-source (alert; never pretend empty)
 *   - all sources succeed with zero features → genuine-empty (distinguishable)
 */

import type { ParsedOsmElement } from "./types.js";

export const OVERPASS_TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504]);

export type OverpassFetchOutcome =
  | {
      ok: true;
      elements: ParsedOsmElement[];
      attempts: number;
      elapsedMs: number;
      query?: string;
    }
  | {
      ok: false;
      error: string;
      attempts: number;
      statusCode?: number;
      elapsedMs: number;
    };

export type FallbackSourcePresence = {
  /** ArcGIS / fixture count for county-roadway (0 = absent or empty). */
  countyRoadwayCount: number;
  /** ArcGIS / fixture count for streets-surveyed-2016. */
  streetsSurveyedCount: number;
};

export type FallbackSourceName = "county-roadway" | "streets-surveyed-2016";

export type HonestRoadCoverage =
  | {
      kind: "overpass-ok";
      elements: ParsedOsmElement[];
      attempts: number;
      elapsedMs: number;
      message: null;
      alert: false;
    }
  | {
      kind: "degraded-covered";
      /** OSM ways empty — caller must emit from county fallback sources. */
      elements: [];
      attempts: number;
      elapsedMs: number;
      overpassError: string;
      fallbackActive: ReadonlyArray<FallbackSourceName>;
      fallbackRoadCount: number;
      message: "overpass down, fallback active";
      alert: false;
    }
  | {
      kind: "degraded-no-source";
      elements: [];
      attempts: number;
      elapsedMs: number;
      overpassError: string;
      fallbackActive: [];
      fallbackRoadCount: 0;
      message: "roads unavailable this run: overpass down, no county roadway source";
      alert: true;
    }
  | {
      kind: "genuine-empty";
      elements: [];
      attempts: number;
      elapsedMs: number;
      message: "no roads observed: overpass and county sources returned zero";
      alert: false;
    };

/** Pure resolver — mechanical gate for QA4 (must go red on pre-fix code). */
export function resolveHonestRoadCoverage(
  overpass: OverpassFetchOutcome,
  fallback: FallbackSourcePresence,
): HonestRoadCoverage {
  const county = Math.max(0, Number(fallback.countyRoadwayCount) || 0);
  const surveyed = Math.max(0, Number(fallback.streetsSurveyedCount) || 0);
  const fallbackActive: FallbackSourceName[] = [];
  if (county > 0) fallbackActive.push("county-roadway");
  if (surveyed > 0) fallbackActive.push("streets-surveyed-2016");
  const fallbackRoadCount = county + surveyed;

  if (overpass.ok) {
    if (overpass.elements.length > 0) {
      return {
        kind: "overpass-ok",
        elements: overpass.elements,
        attempts: overpass.attempts,
        elapsedMs: overpass.elapsedMs,
        message: null,
        alert: false,
      };
    }
    // Overpass succeeded with zero ways. Distinguish from a transient outage:
    // genuine-empty only when county sources are also absent/empty.
    if (fallbackRoadCount === 0) {
      return {
        kind: "genuine-empty",
        elements: [],
        attempts: overpass.attempts,
        elapsedMs: overpass.elapsedMs,
        message: "no roads observed: overpass and county sources returned zero",
        alert: false,
      };
    }
    return {
      kind: "overpass-ok",
      elements: overpass.elements,
      attempts: overpass.attempts,
      elapsedMs: overpass.elapsedMs,
      message: null,
      alert: false,
    };
  }

  if (fallbackRoadCount > 0) {
    return {
      kind: "degraded-covered",
      elements: [],
      attempts: overpass.attempts,
      elapsedMs: overpass.elapsedMs,
      overpassError: overpass.error,
      fallbackActive,
      fallbackRoadCount,
      message: "overpass down, fallback active",
      alert: false,
    };
  }

  return {
    kind: "degraded-no-source",
    elements: [],
    attempts: overpass.attempts,
    elapsedMs: overpass.elapsedMs,
    overpassError: overpass.error,
    fallbackActive: [],
    fallbackRoadCount: 0,
    message: "roads unavailable this run: overpass down, no county roadway source",
    alert: true,
  };
}

/** True when coverage still has roads (OSM or named fallback). */
export function coverageEmitsRoads(coverage: HonestRoadCoverage): boolean {
  return (
    coverage.kind === "overpass-ok" || coverage.kind === "degraded-covered"
  );
}

/** Probe / board vocabulary for osm-overpass when upstream is down. */
export function overpassProbeCoverageMode(
  coverage: HonestRoadCoverage,
): "ok" | "degraded-covered" | "degraded-no-source" | "genuine-empty" {
  if (coverage.kind === "overpass-ok") return "ok";
  return coverage.kind;
}
