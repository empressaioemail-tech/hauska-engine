/**
 * Adapter result cache contract — Task #180.
 *
 * The runner stays IO-free (per the comment at the top of `runner.ts`),
 * so this module defines a small interface a caller can implement to
 * back the cache with whatever store fits — the api-server uses a
 * Postgres table (`adapter_response_cache`), tests use an in-memory
 * `Map`.
 *
 * Cache key contract:
 *   - `(adapterKey, latRounded5, lngRounded5)`
 *   - Coordinates are rounded to 5 decimal places (~1.1m at the
 *     equator) so a parcel that geocodes to slightly different
 *     coordinates on a re-run still hits the cache. Anything coarser
 *     would risk crossing parcel boundaries; anything finer wouldn't
 *     coalesce repeated runs against the same parcel.
 *   - Coordinate normalisation is one-shot in {@link toCacheKey} so
 *     producers and consumers cannot drift on the rounding rule.
 *
 * Invalidation: there is no explicit "evict on parcel move" path.
 * Because the key is the parcel's coordinates, a parcel that moves
 * lands on a *different* cache key — the old entry stays put until its
 * TTL elapses, the new entry is fetched fresh. This matches Task #180's
 * "Cache is invalidated when the parcel coordinates change" without
 * needing a sweep.
 *
 * Failure isolation: cache lookups and writes must never throw — the
 * runner treats them as best-effort. A cache implementation that hits
 * a transient DB error should log and return `null` / no-op.
 */

import type { AdapterResult } from "./types";

/** Decimal places we round lat/lng to before keying. */
export const CACHE_COORDINATE_PRECISION = 5;

/** Normalised cache key — stable across runs of the same adapter at the same parcel. */
export interface AdapterCacheKey {
  adapterKey: string;
  /** Latitude rounded to {@link CACHE_COORDINATE_PRECISION} decimal places. */
  latRounded: number;
  /** Longitude rounded to {@link CACHE_COORDINATE_PRECISION} decimal places. */
  lngRounded: number;
}

/**
 * Build a cache key from raw coordinates. Returns `null` when the
 * coordinates are not finite — the runner skips the cache entirely in
 * that case so an engagement without a geocode still produces the
 * deterministic "no-coverage" outcome the runner emits today.
 */
export function toCacheKey(
  adapterKey: string,
  latitude: number,
  longitude: number,
): AdapterCacheKey | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const factor = 10 ** CACHE_COORDINATE_PRECISION;
  return {
    adapterKey,
    latRounded: Math.round(latitude * factor) / factor,
    lngRounded: Math.round(longitude * factor) / factor,
  };
}

/**
 * Cache hit envelope — wraps the replayed {@link AdapterResult} with
 * the original write timestamp so the runner can surface a
 * `cachedAt` on the outcome (Task #204). The Postgres-backed cache
 * fills `cachedAt` from the row's `created_at`, which is bumped to
 * `now()` on each upsert so it tracks the most recent successful
 * fetch.
 */
export interface AdapterCacheHit {
  result: AdapterResult;
  /** When the cache row was written (i.e. when the underlying lookup ran). */
  cachedAt: Date;
}

/**
 * Backing store the runner consults before invoking an adapter and
 * writes through after a successful run. Implementations are expected
 * to enforce TTL themselves and to never throw — see the file-level
 * comment for the failure-isolation contract.
 *
 * `get` returns an {@link AdapterCacheHit} on a hit so the runner can
 * propagate the cache-write timestamp, or `null` on a miss / stale
 * row.
 */
export interface AdapterResultCache {
  get(key: AdapterCacheKey): Promise<AdapterCacheHit | null>;
  put(key: AdapterCacheKey, result: AdapterResult): Promise<void>;
}

/**
 * Decide whether a given adapter's results are eligible for caching.
 * Default: federal tier only. Federal feeds (FEMA, USGS, EPA, FCC) are
 * the slow / rate-limited services Task #180 calls out; state and
 * local adapters are typically fast and may have parcel-level data
 * shifts that we don't want to mask with a stale cache hit.
 */
export type AdapterCachePredicate = (adapter: {
  readonly tier: "federal" | "state" | "local";
  readonly adapterKey: string;
}) => boolean;

export const FEDERAL_TIER_CACHE_PREDICATE: AdapterCachePredicate = (a) =>
  a.tier === "federal";
