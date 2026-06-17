/**
 * USGS National Elevation Dataset (NED) — federal point-elevation adapter.
 *
 * USGS exposes a JSON Elevation Point Query Service (EPQS) at
 * `https://epqs.nationalmap.gov/v1/json` that returns the NED
 * elevation for a single lat/lng. The response is intentionally tiny:
 *   {
 *     "location": { "x": -109.55, "y": 38.57 },
 *     "value": 4032.7,
 *     "units": "Feet",
 *     "rasterId": 1
 *   }
 *
 * The service occasionally returns the elevation value as a string
 * (older deployments) or `-1000000` as a sentinel for "no data at this
 * point". We normalize both into `elevationFeet: number | null`.
 *
 * The v1 EPQS contract accepts only `x`, `y`, `units`, and `output`
 * — sending `wkid` or `includeDate` causes HTTP 400. Calls go through
 * {@link fetchWithRetry} so a transient EPQS hiccup is not surfaced
 * as a hard failure on the first try.
 */

import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { fetchWithRetry } from "../retry";

const USGS_EPQS_ENDPOINT = "https://epqs.nationalmap.gov/v1/json";
const USGS_EPQS_LABEL = "USGS EPQS";

/** EPQS sentinel for "raster has no value at this point". */
const EPQS_NODATA_SENTINEL = -1_000_000;

/**
 * Freshness window for the USGS NED elevation snapshot.
 *
 * The 3DEP/NED raster is reprocessed in multi-year blocks per region;
 * absolute elevation at a point is geologically stable, so a snapshot
 * is only "stale" when the *raster product* has been replaced (e.g. a
 * new lidar collection at a finer DEM resolution). 24 months matches
 * the cadence USGS publishes new 1m / 1/3 arc-second tiles in the
 * pilot states; older than that and an architect should re-run the
 * adapter to pick up any new lidar-derived terrain.
 */
export const USGS_NED_FRESHNESS_THRESHOLD_MONTHS = 24;

function federalApplies(ctx: AdapterContext): boolean {
  // PL-04: federal adapters apply nationwide whenever the engagement is
  // geocoded. See fema-nfhl.ts for the decoupling rationale — out-of-
  // pilot engagements now receive federal layers + a partial-coverage
  // UI banner instead of a blanket 422.
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

export const usgsNedAdapter: Adapter = {
  adapterKey: "usgs:ned-elevation",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "usgs-ned-elevation",
  provider: "USGS National Elevation Dataset (3DEP)",
  jurisdictionGate: {},
  appliesTo: federalApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const url = new URL(USGS_EPQS_ENDPOINT);
    url.searchParams.set("x", String(ctx.parcel.longitude));
    url.searchParams.set("y", String(ctx.parcel.latitude));
    url.searchParams.set("units", "Feet");
    // Explicit `output=json` is the contract; the path's `/v1/json`
    // suffix is sticky but EPQS still validates the param when set.
    url.searchParams.set("output", "json");

    const { response: res, attempts } = await fetchWithRetry(
      url.toString(),
      { signal: ctx.signal },
      {
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        upstreamLabel: USGS_EPQS_LABEL,
      },
    );
    if (!res.ok) {
      throw new AdapterRunError(
        "upstream-error",
        `USGS EPQS responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}. Use Force refresh to retry.`,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new AdapterRunError(
        "parse-error",
        `USGS EPQS response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!json || typeof json !== "object") {
      throw new AdapterRunError(
        "parse-error",
        "USGS EPQS response was not a JSON object",
      );
    }
    const env = json as {
      value?: unknown;
      units?: unknown;
      location?: unknown;
    };
    // EPQS has shipped both `number` and stringified-number variants of
    // `value` over the years — accept either.
    const rawValue =
      typeof env.value === "number"
        ? env.value
        : typeof env.value === "string" && env.value.trim() !== ""
          ? Number(env.value)
          : NaN;
    if (!Number.isFinite(rawValue)) {
      throw new AdapterRunError(
        "parse-error",
        "USGS EPQS response missing numeric `value`",
      );
    }
    const isNoData = rawValue === EPQS_NODATA_SENTINEL;
    const units =
      typeof env.units === "string" && env.units.length > 0
        ? env.units
        : "Feet";

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "elevation-point",
        elevationFeet: isNoData ? null : rawValue,
        units,
        location: env.location ?? {
          x: ctx.parcel.longitude,
          y: ctx.parcel.latitude,
        },
      },
      note: isNoData
        ? "USGS NED has no elevation value at this point (off-raster)."
        : null,
    };
  },
};
