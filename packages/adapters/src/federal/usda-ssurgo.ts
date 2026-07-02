/**
 * USDA NRCS SSURGO soils — federal subsurface adapter.
 *
 * SSURGO map-unit polygons are published as gSSURGO on the NRCS ArcGIS
 * host; dominant-component and map-unit aggregated attributes (drainage
 * class, hydrologic soil group, depth-to-bedrock, shrink-swell where
 * mapped) come from Soil Data Access (SDA).
 *
 * Two upstream calls run in parallel:
 *   1. gSSURGO MapServer point intersect → mukey / musym / muname
 *   2. SDA tabular POST → dominant-component + muaggatt readings
 *
 * Off-US or unmapped parcels emit a deterministic `no-coverage` verdict
 * (neutral pill) rather than a red failure.
 */

import { arcgisPointQuery } from "../arcgis";
import { fetchWithRetry } from "../retry";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { federalGeocodeApplies, isUsLatLng } from "./_federalGeocodeGate";

/** gSSURGO map-unit polygon layer (national). */
export const USDA_SSURGO_MAPUNIT_LAYER =
  "https://nrcsgeoservices.sc.egov.usda.gov/arcgis/rest/services/soils/gssurgo/MapServer/0";

export const USDA_SSURGO_SDA_ENDPOINT =
  "https://sdmdataaccess.sc.egov.usda.gov/tabular/post.rest";

export const USDA_SSURGO_PROVIDER_LABEL =
  "USDA NRCS Soil Survey Geographic Database (SSURGO)";

/**
 * SSURGO county-level updates roll out continuously; 24 months matches
 * other federal subsurface snapshots and flags engagements opened years
 * apart without firing stale on every annual county refresh.
 */
export const USDA_SSURGO_FRESHNESS_THRESHOLD_MONTHS = 24;

function nowIso(): string {
  return new Date().toISOString();
}

function wktPoint(longitude: number, latitude: number): string {
  return `POINT(${longitude} ${latitude})`;
}

function buildSdaSoilQuery(longitude: number, latitude: number): string {
  const wkt = wktPoint(longitude, latitude);
  return `
SELECT TOP 1
  mu.mukey,
  mu.musym,
  mu.muname,
  ma.drainsubclass,
  ma.brockdepmin,
  ma.brockdepmax,
  ma.wtdepannmin,
  ma.wtdepannmax,
  c.compname,
  c.drainagecl,
  c.hydgrp,
  c.slope_r,
  (SELECT TOP 1 ci.interplr
     FROM cointerp ci
    WHERE ci.cokey = c.cokey
      AND ci.mrulename = 'ENG - Shrink-Swell Potential'
      AND ci.ruledepth = 0) AS shrinkswell
FROM mapunit mu
INNER JOIN muaggatt ma ON ma.mukey = mu.mukey
INNER JOIN component c ON c.mukey = mu.mukey AND c.majcompflag = 'Yes'
WHERE mu.mukey IN (
  SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')
)
ORDER BY c.comppct_r DESC
`.trim();
}

interface SdaTableRow {
  [key: string]: unknown;
}

async function querySdaSoils(
  ctx: AdapterContext,
  longitude: number,
  latitude: number,
): Promise<SdaTableRow | null> {
  const body = new URLSearchParams({
    query: buildSdaSoilQuery(longitude, latitude),
    format: "JSON+COLUMNNAME",
  });
  const {
    response: res,
    attempts,
    throwExcerpt,
    bodyExcerpt,
  } = await fetchWithRetry(
    USDA_SSURGO_SDA_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, */*;q=0.1",
      },
      body: body.toString(),
      signal: ctx.signal,
    },
    {
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: "USDA Soil Data Access",
      // USDA's SDA host (sdmdataaccess.sc.egov.usda.gov) intermittently
      // resets the TLS connection (ECONNRESET) under load. fetchWithRetry
      // already retries transient resets with backoff; opting into
      // captureThrowsAsResult means a *final-attempt* reset comes back as
      // a 599 synthetic response carrying a `throwExcerpt` (e.g.
      // "ECONNRESET read sdmdataaccess.sc.egov.usda.gov") instead of an
      // unhandled network throw. The caller composes an honest degraded
      // message from it rather than surfacing a raw reset.
      captureThrowsAsResult: true,
    },
  );
  if (!res.ok) {
    // A synthetic 599 (throwExcerpt populated) is a network/TLS failure
    // — ECONNRESET / TLS reject / DNS. Surface it as a network-error so
    // the runner renders an honest degraded pill that names the failure
    // mode, and the adapter's run() can still return the gSSURGO map
    // unit alone as a partial result.
    if (res.status === 599 || throwExcerpt) {
      throw new AdapterRunError(
        "network-error",
        `USDA Soil Data Access unreachable after ${attempts} attempt${attempts === 1 ? "" : "s"}${throwExcerpt ? ` (${throwExcerpt})` : ""}. The USDA SDA endpoint intermittently resets TLS connections; use Force refresh to retry.`,
      );
    }
    throw new AdapterRunError(
      "upstream-error",
      `USDA Soil Data Access responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}${bodyExcerpt ? `: ${bodyExcerpt}` : ""}. Use Force refresh to retry.`,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new AdapterRunError(
      "parse-error",
      `USDA Soil Data Access response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!json || typeof json !== "object") {
    throw new AdapterRunError(
      "parse-error",
      "USDA Soil Data Access response was not a JSON object",
    );
  }
  const table = (json as { Table?: unknown }).Table;
  if (!Array.isArray(table) || table.length === 0) return null;
  const row = table[0];
  return row && typeof row === "object" ? (row as SdaTableRow) : null;
}

function pickString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const usdaSsurgoSoilsAdapter: Adapter = {
  adapterKey: "usda:ssurgo-soils",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "usda-ssurgo-soils",
  provider: USDA_SSURGO_PROVIDER_LABEL,
  jurisdictionGate: {},
  appliesTo(ctx) {
    return (
      federalGeocodeApplies(ctx) &&
      isUsLatLng(ctx.parcel.latitude, ctx.parcel.longitude)
    );
  },
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const { latitude, longitude } = ctx.parcel;
    // allSettled, not all: the two upstream calls hit different USDA
    // hosts with different reliability. The SDA tabular host resets TLS
    // connections intermittently; when it fails but the gSSURGO map-unit
    // polygon succeeds, we still return an HONEST partial result (the map
    // unit alone is useful) rather than discarding both and throwing.
    const [mapUnitSettled, sdaSettled] = await Promise.allSettled([
      arcgisPointQuery({
        serviceUrl: USDA_SSURGO_MAPUNIT_LAYER,
        latitude,
        longitude,
        outFields: "MUKEY,MUSYM,MUNAME,AREASYMBOL",
        returnGeometry: false,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        upstreamLabel: "USDA gSSURGO",
      }),
      querySdaSoils(ctx, longitude, latitude),
    ]);

    const mapUnit =
      mapUnitSettled.status === "fulfilled" ? mapUnitSettled.value : null;
    const sdaRow =
      sdaSettled.status === "fulfilled" ? sdaSettled.value : null;

    // If BOTH upstream calls failed, propagate the more informative
    // error (network/TLS over a bare arcgis failure) so the runner
    // renders an honest failed pill — never an unhandled reset.
    if (!mapUnit && sdaSettled.status === "rejected") {
      const sdaErr = sdaSettled.reason;
      const mapErr =
        mapUnitSettled.status === "rejected"
          ? mapUnitSettled.reason
          : undefined;
      const chosen =
        sdaErr instanceof AdapterRunError ? sdaErr : (mapErr ?? sdaErr);
      if (chosen instanceof AdapterRunError) throw chosen;
      throw new AdapterRunError(
        "network-error",
        `USDA SSURGO lookup failed: ${chosen instanceof Error ? chosen.message : String(chosen)}. Use Force refresh to retry.`,
      );
    }

    // Map-unit call failed but SDA succeeded (or vice versa) — continue
    // with whatever we have; degradedReason is stamped below.
    const sdaDegraded = sdaSettled.status === "rejected";
    const sdaDegradedReason =
      sdaSettled.status === "rejected"
        ? sdaSettled.reason instanceof Error
          ? sdaSettled.reason.message
          : String(sdaSettled.reason)
        : null;

    const feature = mapUnit?.features[0];
    const attrs = feature?.attributes ?? {};
    const mukey =
      pickString(attrs.MUKEY) ??
      pickString(sdaRow?.mukey) ??
      pickString(sdaRow?.MUKEY);
    const musym =
      pickString(attrs.MUSYM) ??
      pickString(sdaRow?.musym) ??
      pickString(sdaRow?.MUSYM);
    const muname =
      pickString(attrs.MUNAME) ??
      pickString(sdaRow?.muname) ??
      pickString(sdaRow?.MUNAME);

    // Only a genuine empty result from BOTH upstreams (both ran, both
    // returned nothing) is "no coverage". If the map-unit call was
    // rejected (network/TLS) we already handled the both-failed case
    // above; reaching here with no feature means the SDA call carried
    // the payload, so a null feature is a partial, not no-coverage.
    const mapUnitRan = mapUnitSettled.status === "fulfilled";
    if (mapUnitRan && !feature && !sdaRow) {
      throw new AdapterRunError(
        "no-coverage",
        "No SSURGO soil map unit is mapped at this location.",
      );
    }

    const partialReasons: string[] = [];
    if (sdaDegraded && sdaDegradedReason) {
      partialReasons.push(
        `Soil Data Access tabular attributes unavailable (${sdaDegradedReason})`,
      );
    }
    if (!mapUnitRan) {
      const reason =
        mapUnitSettled.status === "rejected" &&
        mapUnitSettled.reason instanceof Error
          ? mapUnitSettled.reason.message
          : "gSSURGO map-unit lookup failed";
      partialReasons.push(`gSSURGO map-unit polygon unavailable (${reason})`);
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "ssurgo-soils",
        degraded: partialReasons.length > 0,
        degradationReasons: partialReasons,
        mukey,
        musym,
        muname,
        areaSymbol: pickString(attrs.AREASYMBOL),
        drainageClass:
          pickString(sdaRow?.drainagecl) ??
          pickString(sdaRow?.drainsubclass) ??
          pickString(sdaRow?.DRAINAGECL),
        hydrologicSoilGroup:
          pickString(sdaRow?.hydgrp) ?? pickString(sdaRow?.HYDGRP),
        dominantComponent:
          pickString(sdaRow?.compname) ?? pickString(sdaRow?.COMPNAME),
        slopePercentRounded:
          pickNumber(sdaRow?.slope_r) ?? pickNumber(sdaRow?.SLOPE_R),
        depthToBedrockMinFeet:
          pickNumber(sdaRow?.brockdepmin) ?? pickNumber(sdaRow?.BROCKDEPMIN),
        depthToBedrockMaxFeet:
          pickNumber(sdaRow?.brockdepmax) ?? pickNumber(sdaRow?.BROCKDEPMAX),
        waterTableDepthMinFeet:
          pickNumber(sdaRow?.wtdepannmin) ?? pickNumber(sdaRow?.WTDEPANNMIN),
        waterTableDepthMaxFeet:
          pickNumber(sdaRow?.wtdepannmax) ?? pickNumber(sdaRow?.WTDEPANNMAX),
        shrinkSwellPotential:
          pickString(sdaRow?.shrinkswell) ?? pickString(sdaRow?.SHRINKSWELL),
        rawMapUnitAttributes: attrs,
        rawSdaRow: sdaRow ?? null,
      },
    };
  },
};
