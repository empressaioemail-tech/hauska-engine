/**
 * USDA NRCS SSURGO soils — federal subsurface adapter.
 *
 * Source of truth is USDA Soil Data Access (SDA) on
 * `sdmdataaccess.sc.egov.usda.gov`: the tabular POST endpoint resolves the
 * map unit at a point (`SDA_Get_Mukey_from_intersection_with_WktWgs84`)
 * plus dominant-component and muaggatt attributes in one query.
 *
 * The gSSURGO ArcGIS host (`nrcsgeoservices.sc.egov.usda.gov`) resets TLS
 * handshakes from Cloud Run (and most non-browser clients) — the long-lived
 * "SSURGO ECONNRESET" degradation. It is therefore only queried as
 * best-effort enrichment; its failure never fails the adapter when SDA
 * answers. `Promise.allSettled` (not `Promise.all`) keeps a dead ArcGIS
 * host from failing the whole adapter when SDA answered.
 *
 * Off-US or unmapped parcels emit a deterministic `no-coverage` verdict
 * (neutral pill) rather than a red failure.
 *
 * Ported from the ldt cortex-side fix (ldt PR #248) verbatim in behavior:
 * the SDA SQL named nonexistent muaggatt columns (`brockdepmax` /
 * `wtdepannmax` / `drainsubclass`) and USDA 400'd every call; the
 * response parser read named keys off the header row (`Table[0]`) of the
 * `JSON+COLUMNNAME` array-of-arrays wire shape and got nothing on success;
 * the SDA call needs a browser-ish User-Agent or USDA front doors reset.
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

/** gSSURGO map-unit polygon layer (national). Enrichment-only; see header. */
export const USDA_SSURGO_MAPUNIT_LAYER =
  "https://nrcsgeoservices.sc.egov.usda.gov/arcgis/rest/services/soils/gssurgo/MapServer/0";

export const USDA_SSURGO_SDA_ENDPOINT =
  "https://sdmdataaccess.sc.egov.usda.gov/tabular/post.rest";

/**
 * Browser-ish UA for USDA hosts. Several USDA front doors 406/reset
 * requests without a recognizable User-Agent.
 */
export const USDA_HTTP_USER_AGENT =
  "Mozilla/5.0 (compatible; HauskaEngine/1.0; +https://hauska.dev)";

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

/**
 * Point query against SDA. Column set verified against the live schema
 * (2026-07-14 in the ldt fix, re-checked here): muaggatt has
 * `brockdepmin` / `wtdepannmin` but no `brockdepmax` / `wtdepannmax` /
 * `drainsubclass` — the previous query named those and SDA rejected it
 * with HTTP 400 "Invalid column name" on every call. `areasymbol` comes
 * from the legend join; `drclassdcd` / `hydgrpdcd` are map-unit-level
 * fallbacks for the component readings. muaggatt is LEFT JOINed so a
 * mapped mukey with no aggregate row still returns the component.
 */
function buildSdaSoilQuery(longitude: number, latitude: number): string {
  const wkt = wktPoint(longitude, latitude);
  return `
SELECT TOP 1
  mu.mukey,
  mu.musym,
  mu.muname,
  l.areasymbol,
  ma.brockdepmin,
  ma.wtdepannmin,
  ma.drclassdcd,
  ma.hydgrpdcd,
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
INNER JOIN legend l ON l.lkey = mu.lkey
INNER JOIN component c ON c.mukey = mu.mukey AND c.majcompflag = 'Yes'
LEFT JOIN muaggatt ma ON ma.mukey = mu.mukey
WHERE mu.mukey IN (
  SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')
)
ORDER BY c.comppct_r DESC
`.trim();
}

interface SdaTableRow {
  [key: string]: unknown;
}

/**
 * Parse an SDA `format=JSON+COLUMNNAME` response body into keyed rows.
 *
 * The real wire shape is `{ "Table": [[col, col, …], [val, val, …], …] }`
 * — the FIRST row is column names and every subsequent row is a value
 * array. The previous implementation indexed `Table[0]` and read named
 * properties off it, i.e. it always consumed the header row and every
 * attribute came back `undefined` even on a successful call. Object rows
 * are still tolerated in case a proxy or fixture provides them.
 */
export function parseSdaTableRows(json: unknown): SdaTableRow[] {
  if (!json || typeof json !== "object") return [];
  const table = (json as { Table?: unknown }).Table;
  if (!Array.isArray(table) || table.length === 0) return [];

  const first = table[0];
  if (Array.isArray(first)) {
    const columns = first.map((c) => String(c));
    const rows: SdaTableRow[] = [];
    for (let i = 1; i < table.length; i++) {
      const values = table[i];
      if (!Array.isArray(values)) continue;
      const row: SdaTableRow = {};
      for (let c = 0; c < columns.length; c++) {
        row[columns[c]] = values[c] ?? null;
      }
      rows.push(row);
    }
    return rows;
  }

  return table.filter(
    (row): row is SdaTableRow =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
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
        // Several USDA front doors 406/reset requests without a
        // recognizable User-Agent — send a browser-ish one.
        "User-Agent": USDA_HTTP_USER_AGENT,
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
  const rows = parseSdaTableRows(json);
  return rows[0] ?? null;
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

/** muaggatt depth attributes are centimeters; payload fields are feet. */
function cmToFeet(value: number | null): number | null {
  if (value === null) return null;
  return Math.round((value / 30.48) * 10) / 10;
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
        areaSymbol:
          pickString(attrs.AREASYMBOL) ??
          pickString(sdaRow?.areasymbol) ??
          pickString(sdaRow?.AREASYMBOL),
        drainageClass:
          pickString(sdaRow?.drainagecl) ??
          pickString(sdaRow?.DRAINAGECL) ??
          pickString(sdaRow?.drclassdcd),
        hydrologicSoilGroup:
          pickString(sdaRow?.hydgrp) ??
          pickString(sdaRow?.HYDGRP) ??
          pickString(sdaRow?.hydgrpdcd),
        dominantComponent:
          pickString(sdaRow?.compname) ?? pickString(sdaRow?.COMPNAME),
        slopePercentRounded:
          pickNumber(sdaRow?.slope_r) ?? pickNumber(sdaRow?.SLOPE_R),
        // muaggatt reports cm; converted so the field names stay honest.
        // The *Max* columns do not exist in muaggatt (SDA 400s on them),
        // so max depths are null pending a corestrictions-based source.
        depthToBedrockMinFeet: cmToFeet(
          pickNumber(sdaRow?.brockdepmin) ?? pickNumber(sdaRow?.BROCKDEPMIN),
        ),
        depthToBedrockMaxFeet: null,
        waterTableDepthMinFeet: cmToFeet(
          pickNumber(sdaRow?.wtdepannmin) ?? pickNumber(sdaRow?.WTDEPANNMIN),
        ),
        waterTableDepthMaxFeet: null,
        shrinkSwellPotential:
          pickString(sdaRow?.shrinkswell) ?? pickString(sdaRow?.SHRINKSWELL),
        rawMapUnitAttributes: attrs,
        rawSdaRow: sdaRow ?? null,
      },
    };
  },
};
