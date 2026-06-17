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
  const { response: res, attempts } = await fetchWithRetry(
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
    },
  );
  if (!res.ok) {
    throw new AdapterRunError(
      "upstream-error",
      `USDA Soil Data Access responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}. Use Force refresh to retry.`,
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
    const [mapUnit, sdaRow] = await Promise.all([
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

    const feature = mapUnit.features[0];
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

    if (!feature && !sdaRow) {
      throw new AdapterRunError(
        "no-coverage",
        "No SSURGO soil map unit is mapped at this location.",
      );
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
