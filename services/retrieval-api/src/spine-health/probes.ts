/**
 * Bastrop spine-health probes — sources + engines (COMPLETE-BASTROP B1).
 */

import { getSetbackTableForZoning } from "@hauska-engine/adapters";
import { HybridRetrieval } from "@hauska-engine/retrieval";
import type { StoragePort } from "@hauska-engine/storage";
import type postgres from "postgres";

import { DEPTH_WARM_PROMOTION_MARKER } from "../central-tx-tally.js";
import {
  AGOL_ZONING_PLACE_TYPE_URL,
  BASTROP_COUNTY_ROADWAY_URL,
  BASTROP_FLOODPLAIN_URL,
  BASTROP_PACK,
  BASTROP_PARCELS_URL,
  BASTROP_STREETS_SURVEYED_2016_URL,
  COUNTY_FIPS_BASTROP,
  GOLD_DISTRICT,
  GOLD_LAT,
  GOLD_LNG,
  GOLD_PARCEL_NODE_ID,
  OVERPASS_INTERPRETER,
  seedBaseline,
} from "./baselines.js";
import { deriveProbeStatus } from "./derive-status.js";
import type { ProbeKind, ProbeResult } from "./types.js";

type Sql = postgres.Sql;
type FetchImpl = typeof fetch;

export interface ProbeContext {
  substrateSql: Sql | null;
  overlaySql: Sql | null;
  storage: StoragePort | null;
  fetchImpl?: FetchImpl;
  baselines?: Readonly<Record<string, number>>;
  now?: () => Date;
}

const ARC_GIS_UA =
  "hauska-engine/1.0 (+https://cortex.empressa.io; spine-health B1)";

function resolveBaseline(
  probeId: string,
  baselines: Readonly<Record<string, number>> | undefined,
): number | null {
  if (baselines && Object.prototype.hasOwnProperty.call(baselines, probeId)) {
    return baselines[probeId]!;
  }
  return seedBaseline(probeId);
}

function finish(input: {
  probeId: string;
  kind: ProbeKind;
  baseline: number | null;
  current: number | null;
  errored?: boolean;
  expectedDead?: boolean;
  /** QA4: errored but fallback covers → degraded-covered, no alert. */
  fallbackCovered?: boolean;
  error?: string | null;
  signal: Record<string, unknown>;
  now: Date;
  lastSuccessAt?: string | null;
}): ProbeResult {
  const derived = deriveProbeStatus({
    expectedDead: input.expectedDead,
    errored: input.errored,
    fallbackCovered: input.fallbackCovered,
    baseline: input.baseline,
    current: input.current,
  });
  const lastSuccessAt =
    derived.status === "firing"
      ? input.now.toISOString()
      : (input.lastSuccessAt ?? null);
  return {
    probeId: input.probeId,
    kind: input.kind,
    pack: BASTROP_PACK,
    status: derived.status,
    alert: derived.alert,
    signal: input.signal,
    baselineValue: input.baseline,
    currentValue: input.current,
    error: input.error ?? null,
    lastSuccessAt,
    probedAt: input.now.toISOString(),
  };
}

async function arcgisCount(
  serviceUrl: string,
  fetchImpl: FetchImpl,
): Promise<number> {
  const url = new URL(`${serviceUrl.replace(/\/$/, "")}/query`);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("returnCountOnly", "true");
  url.searchParams.set("f", "json");
  const res = await fetchImpl(url.toString(), {
    headers: { "User-Agent": ARC_GIS_UA, Accept: "application/json" },
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
  if (typeof body.count !== "number") {
    throw new Error(`ArcGIS count missing for ${serviceUrl}`);
  }
  return body.count;
}

async function arcgisPointFeatureCount(
  serviceUrl: string,
  lat: number,
  lng: number,
  fetchImpl: FetchImpl,
): Promise<number> {
  const url = new URL(`${serviceUrl.replace(/\/$/, "")}/query`);
  url.searchParams.set("geometry", `${lng},${lat}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", "OBJECTID");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");
  const res = await fetchImpl(url.toString(), {
    headers: { "User-Agent": ARC_GIS_UA, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ArcGIS HTTP ${res.status} for point query ${serviceUrl}`);
  }
  const body = (await res.json()) as {
    features?: unknown[];
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(body.error.message ?? "ArcGIS error");
  }
  return Array.isArray(body.features) ? body.features.length : 0;
}

/** bastrop-tx:parcels — gold point must return ≥1 feature. */
export async function probeBastropParcels(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "bastrop-tx:parcels";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  try {
    const current = await arcgisPointFeatureCount(
      BASTROP_PARCELS_URL,
      GOLD_LAT,
      GOLD_LNG,
      fetchImpl,
    );
    return finish({
      probeId,
      kind: "source",
      baseline,
      current,
      signal: {
        url: BASTROP_PARCELS_URL,
        lat: GOLD_LAT,
        lng: GOLD_LNG,
        featureCount: current,
      },
      now,
    });
  } catch (err) {
    return finish({
      probeId,
      kind: "source",
      baseline,
      current: null,
      errored: true,
      error: err instanceof Error ? err.message : String(err),
      signal: { url: BASTROP_PARCELS_URL },
      now,
    });
  }
}

/** bastrop-tx:floodplain — MapServer count liveness. */
export async function probeBastropFloodplain(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "bastrop-tx:floodplain";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  try {
    const current = await arcgisCount(BASTROP_FLOODPLAIN_URL, fetchImpl);
    return finish({
      probeId,
      kind: "source",
      baseline,
      current,
      signal: { url: BASTROP_FLOODPLAIN_URL, count: current },
      now,
    });
  } catch (err) {
    return finish({
      probeId,
      kind: "source",
      baseline,
      current: null,
      errored: true,
      error: err instanceof Error ? err.message : String(err),
      signal: { url: BASTROP_FLOODPLAIN_URL },
      now,
    });
  }
}

/** zoning-agol:bastrop-city-tx — AGOL Place Type feature count. */
export async function probeZoningAgol(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "zoning-agol:bastrop-city-tx";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  try {
    const current = await arcgisCount(AGOL_ZONING_PLACE_TYPE_URL, fetchImpl);
    return finish({
      probeId,
      kind: "source",
      baseline,
      current,
      signal: {
        url: AGOL_ZONING_PLACE_TYPE_URL,
        field: "PlaceTypeClass",
        count: current,
      },
      now,
    });
  } catch (err) {
    return finish({
      probeId,
      kind: "source",
      baseline,
      current: null,
      errored: true,
      error: err instanceof Error ? err.message : String(err),
      signal: { url: AGOL_ZONING_PLACE_TYPE_URL },
      now,
    });
  }
}

/** bastrop-tx:zoning — expected dead (county GIS retired). */
export async function probeBastropZoningDeadExpected(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "bastrop-tx:zoning";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  return finish({
    probeId,
    kind: "source",
    baseline,
    current: 0,
    expectedDead: true,
    error:
      "County LandUse/Zoning retired; replacement is zoning-agol:bastrop-city-tx",
    signal: {
      expectedDead: true,
      replacement: "zoning-agol:bastrop-city-tx",
      replacementUrl: AGOL_ZONING_PLACE_TYPE_URL,
    },
    now,
  });
}

/** osm-overpass — highway way count in city bbox (out count). QA4 honesty. */
export async function probeOsmOverpass(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "osm-overpass";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const south = 30.04;
  const west = -97.38;
  const north = 30.16;
  const east = -97.25;
  const ql = `[out:json][timeout:60];way["highway"](${south},${west},${north},${east});out count;`;

  const maxAttempts = 3;
  let lastError: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    try {
      const res = await fetchImpl(OVERPASS_INTERPRETER, {
        method: "POST",
        headers: {
          "User-Agent": ARC_GIS_UA,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `data=${encodeURIComponent(ql)}`,
      });
      if (!res.ok) {
        lastError = `Overpass HTTP ${res.status}`;
        // Retry transient gateway/timeout statuses (QA4).
        if ([408, 429, 502, 503, 504].includes(res.status) && attempt < maxAttempts) {
          continue;
        }
        throw new Error(lastError);
      }
      const body = (await res.json()) as {
        elements?: Array<{ tags?: Record<string, string> }>;
      };
      const tags = body.elements?.[0]?.tags ?? {};
      const current = Number(tags.ways ?? tags.total ?? 0);
      return finish({
        probeId,
        kind: "source",
        baseline,
        current,
        signal: {
          url: OVERPASS_INTERPRETER,
          bbox: { south, west, north, east },
          tags,
          attempts,
        },
        now,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts && /504|502|503|408|429|fetch failed|timeout/i.test(lastError)) {
        continue;
      }
      break;
    }
  }

  // Overpass down — check whether county roadway / surveyed covers (QA4).
  let countyRoadwayCount = 0;
  let streetsSurveyedCount = 0;
  try {
    countyRoadwayCount = await arcgisCount(BASTROP_COUNTY_ROADWAY_URL, fetchImpl);
  } catch {
    countyRoadwayCount = 0;
  }
  try {
    streetsSurveyedCount = await arcgisCount(
      BASTROP_STREETS_SURVEYED_2016_URL,
      fetchImpl,
    );
  } catch {
    streetsSurveyedCount = 0;
  }
  const fallbackCovered = countyRoadwayCount > 0 || streetsSurveyedCount > 0;
  const fallbackActive: string[] = [];
  if (countyRoadwayCount > 0) fallbackActive.push("county-roadway");
  if (streetsSurveyedCount > 0) fallbackActive.push("streets-surveyed-2016");

  return finish({
    probeId,
    kind: "source",
    baseline,
    current: null,
    errored: true,
    fallbackCovered,
    error: lastError
      ? `${lastError} after ${attempts} attempt${attempts === 1 ? "" : "s"}`
      : `Overpass failed after ${attempts} attempts`,
    signal: {
      url: OVERPASS_INTERPRETER,
      bbox: { south, west, north, east },
      attempts,
      coverageMode: fallbackCovered ? "degraded-covered" : "degraded-no-source",
      message: fallbackCovered
        ? "overpass down, fallback active"
        : "roads unavailable this run: overpass down, no county roadway source",
      fallbackActive,
      fallbackCounts: {
        "county-roadway": countyRoadwayCount,
        "streets-surveyed-2016": streetsSurveyedCount,
      },
    },
    now,
  });
}

/** county-roadway — ArcGIS count. */
export async function probeCountyRoadway(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "county-roadway";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  try {
    const current = await arcgisCount(BASTROP_COUNTY_ROADWAY_URL, fetchImpl);
    return finish({
      probeId,
      kind: "source",
      baseline,
      current,
      signal: { url: BASTROP_COUNTY_ROADWAY_URL, count: current },
      now,
    });
  } catch (err) {
    return finish({
      probeId,
      kind: "source",
      baseline,
      current: null,
      errored: true,
      error: err instanceof Error ? err.message : String(err),
      signal: { url: BASTROP_COUNTY_ROADWAY_URL },
      now,
    });
  }
}

/** streets-surveyed-2016 — ArcGIS count. */
export async function probeStreetsSurveyed2016(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "streets-surveyed-2016";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  try {
    const current = await arcgisCount(
      BASTROP_STREETS_SURVEYED_2016_URL,
      fetchImpl,
    );
    return finish({
      probeId,
      kind: "source",
      baseline,
      current,
      signal: { url: BASTROP_STREETS_SURVEYED_2016_URL, count: current },
      now,
    });
  } catch (err) {
    return finish({
      probeId,
      kind: "source",
      baseline,
      current: null,
      errored: true,
      error: err instanceof Error ? err.message : String(err),
      signal: { url: BASTROP_STREETS_SURVEYED_2016_URL },
      now,
    });
  }
}

/** txgio_parcel:48021 row count + zoning_district population. */
export async function probeTxgioParcel48021(
  ctx: ProbeContext,
): Promise<ProbeResult[]> {
  const now = (ctx.now ?? (() => new Date()))();
  const idCount = "txgio_parcel:48021";
  const idZd = "txgio_parcel:48021:zoning_district";
  const baselineCount = resolveBaseline(idCount, ctx.baselines);
  const baselineZd = resolveBaseline(idZd, ctx.baselines);

  if (!ctx.overlaySql) {
    return [
      finish({
        probeId: idCount,
        kind: "source",
        baseline: baselineCount,
        current: null,
        errored: true,
        error: "overlay database not configured",
        signal: {},
        now,
      }),
      finish({
        probeId: idZd,
        kind: "source",
        baseline: baselineZd,
        current: null,
        errored: true,
        error: "overlay database not configured",
        signal: {},
        now,
      }),
    ];
  }

  try {
    const rows = await ctx.overlaySql<
      Array<{ total: number; with_zd: number }>
    >`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (
          WHERE coalesce(zoning_district, '') <> ''
        )::int AS with_zd
      FROM txgio_parcel
      WHERE county_fips = ${COUNTY_FIPS_BASTROP}
    `;
    const total = Number(rows[0]?.total ?? 0);
    const withZd = Number(rows[0]?.with_zd ?? 0);
    return [
      finish({
        probeId: idCount,
        kind: "source",
        baseline: baselineCount,
        current: total,
        signal: { county_fips: COUNTY_FIPS_BASTROP, total },
        now,
      }),
      finish({
        probeId: idZd,
        kind: "source",
        baseline: baselineZd,
        current: withZd,
        signal: {
          county_fips: COUNTY_FIPS_BASTROP,
          with_zoning_district: withZd,
        },
        now,
      }),
    ];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      finish({
        probeId: idCount,
        kind: "source",
        baseline: baselineCount,
        current: null,
        errored: true,
        error: message,
        signal: {},
        now,
      }),
      finish({
        probeId: idZd,
        kind: "source",
        baseline: baselineZd,
        current: null,
        errored: true,
        error: message,
        signal: {},
        now,
      }),
    ];
  }
}

/**
 * place_layer_snapshots tier1 + zoning_present + S-14 delta.
 * Export name must be probeTier1Snapshots48021 (not Tiers1).
 */
export async function probeTier1Snapshots48021(
  ctx: ProbeContext,
): Promise<ProbeResult[]> {
  const now = (ctx.now ?? (() => new Date()))();
  const idTier1 = "place_layer_snapshots:tier1:48021";
  const idZoning = "place_layer_snapshots:zoning_present:48021";
  const idDelta = "place_layer_snapshots:s14_delta:48021";
  const bTier1 = resolveBaseline(idTier1, ctx.baselines);
  const bZoning = resolveBaseline(idZoning, ctx.baselines);
  const bDelta = resolveBaseline(idDelta, ctx.baselines);

  if (!ctx.overlaySql) {
    const err = "overlay database not configured";
    return [
      finish({
        probeId: idTier1,
        kind: "source",
        baseline: bTier1,
        current: null,
        errored: true,
        error: err,
        signal: {},
        now,
      }),
      finish({
        probeId: idZoning,
        kind: "source",
        baseline: bZoning,
        current: null,
        errored: true,
        error: err,
        signal: {},
        now,
      }),
      finish({
        probeId: idDelta,
        kind: "source",
        baseline: bDelta,
        current: null,
        errored: true,
        error: err,
        signal: {},
        now,
      }),
    ];
  }

  try {
    const snapRows = await ctx.overlaySql<
      Array<{ tier1_total: number; zoning_present: number }>
    >`
      SELECT
        count(*)::int AS tier1_total,
        count(*) FILTER (
          WHERE coalesce(payload_json->'zoning'->>'district', '') <> ''
        )::int AS zoning_present
      FROM place_layer_snapshots
      WHERE adapter_key = 'node-facets:tier1'
        AND place_key LIKE ${"node:" + COUNTY_FIPS_BASTROP + ":%"}
    `;
    const tier1 = Number(snapRows[0]?.tier1_total ?? 0);
    const zoningPresent = Number(snapRows[0]?.zoning_present ?? 0);

    const zdRows = await ctx.overlaySql<Array<{ with_zd: number }>>`
      SELECT count(*) FILTER (
        WHERE coalesce(zoning_district, '') <> ''
      )::int AS with_zd
      FROM txgio_parcel
      WHERE county_fips = ${COUNTY_FIPS_BASTROP}
    `;
    const withZd = Number(zdRows[0]?.with_zd ?? 0);
    const delta = withZd - zoningPresent;

    // S-14: bake lag gauge — alert if delta grows past 1.5× seed baseline.
    const deltaBaseline = bDelta ?? 0;
    let deltaStatus: { status: ProbeResult["status"]; alert: boolean };
    if (deltaBaseline > 0 && delta > deltaBaseline * 1.5) {
      deltaStatus = { status: "degraded", alert: true };
    } else if (delta < 0) {
      deltaStatus = { status: "degraded", alert: true };
    } else {
      deltaStatus = { status: "firing", alert: false };
    }

    return [
      finish({
        probeId: idTier1,
        kind: "source",
        baseline: bTier1,
        current: tier1,
        signal: { tier1_total: tier1 },
        now,
      }),
      finish({
        probeId: idZoning,
        kind: "source",
        baseline: bZoning,
        current: zoningPresent,
        signal: { zoning_present: zoningPresent },
        now,
      }),
      {
        probeId: idDelta,
        kind: "source",
        pack: BASTROP_PACK,
        status: deltaStatus.status,
        alert: deltaStatus.alert,
        signal: {
          txgio_zd: withZd,
          zoning_present: zoningPresent,
          delta,
          note: "S-14 bake lag (txgio zd - tier1 zoning_present)",
        },
        baselineValue: bDelta,
        currentValue: delta,
        error: null,
        lastSuccessAt:
          deltaStatus.status === "firing" ? now.toISOString() : null,
        probedAt: now.toISOString(),
      },
    ];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      finish({
        probeId: idTier1,
        kind: "source",
        baseline: bTier1,
        current: null,
        errored: true,
        error: message,
        signal: {},
        now,
      }),
      finish({
        probeId: idZoning,
        kind: "source",
        baseline: bZoning,
        current: null,
        errored: true,
        error: message,
        signal: {},
        now,
      }),
      finish({
        probeId: idDelta,
        kind: "source",
        baseline: bDelta,
        current: null,
        errored: true,
        error: message,
        signal: {},
        now,
      }),
    ];
  }
}

/** boundary-primitive — property-boundary-edge count for 48021. */
export async function probeBoundaryPrimitive(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "boundary-primitive";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  if (!ctx.substrateSql) {
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current: null,
      errored: true,
      error: "substrate database not configured",
      signal: {},
      now,
    });
  }
  try {
    const rows = await ctx.substrateSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM atoms
      WHERE entity_type = 'property-boundary-edge'
        AND (
          entity_id LIKE ${COUNTY_FIPS_BASTROP + ":%"}
          OR body->>'parcelNodeId' LIKE ${COUNTY_FIPS_BASTROP + ":%"}
        )
    `;
    const current = Number(rows[0]?.n ?? 0);
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current,
      signal: { count: current, county_fips: COUNTY_FIPS_BASTROP },
      now,
    });
  } catch (err) {
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current: null,
      errored: true,
      error: err instanceof Error ? err.message : String(err),
      signal: {},
      now,
    });
  }
}

/** depth-warm — promoted envelope count (DEPTH_WARM_PROMOTION_MARKER). */
export async function probeDepthWarm(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "depth-warm";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  if (!ctx.substrateSql) {
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current: null,
      errored: true,
      error: "substrate database not configured",
      signal: {},
      now,
    });
  }
  try {
    const rows = await ctx.substrateSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM atoms
      WHERE entity_type = 'buildable-envelope'
        AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS_BASTROP + ":%"}
        AND body->>'depthWarmPromotion' = ${DEPTH_WARM_PROMOTION_MARKER}
    `;
    const current = Number(rows[0]?.n ?? 0);
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current,
      signal: {
        count: current,
        marker: DEPTH_WARM_PROMOTION_MARKER,
        county_fips: COUNTY_FIPS_BASTROP,
      },
      now,
    });
  } catch (err) {
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current: null,
      errored: true,
      error: err instanceof Error ? err.message : String(err),
      signal: {},
      now,
    });
  }
}

/** rule-setback — resolve setback table row for gold district (P-5 → P-5 Core). */
export async function probeRuleSetback(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "rule-setback";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  try {
    const table = getSetbackTableForZoning("bastrop-tx", GOLD_DISTRICT);
    const wanted = GOLD_DISTRICT.toUpperCase();
    const district =
      table?.districts.find((d) => {
        const name = d.district_name.toUpperCase();
        return (
          name === wanted ||
          name.startsWith(`${wanted} `) ||
          name.startsWith(`${wanted}-`)
        );
      }) ?? null;
    const current = district ? 1 : 0;
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current,
      signal: {
        jurisdictionKey: table?.jurisdictionKey ?? null,
        district: GOLD_DISTRICT,
        matchedDistrict: district?.district_name ?? null,
        goldParcel: GOLD_PARCEL_NODE_ID,
        found: Boolean(district),
        front_ft: district?.front_ft ?? null,
      },
      now,
    });
  } catch (err) {
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current: null,
      errored: true,
      error: err instanceof Error ? err.message : String(err),
      signal: { district: GOLD_DISTRICT },
      now,
    });
  }
}

/** reasoning-chain — atom-chain keys on gold parcel. */
export async function probeReasoningChain(
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const probeId = "reasoning-chain";
  const now = (ctx.now ?? (() => new Date()))();
  const baseline = resolveBaseline(probeId, ctx.baselines);
  if (!ctx.storage) {
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current: null,
      errored: true,
      error: "storage not configured",
      signal: { parcelNodeId: GOLD_PARCEL_NODE_ID },
      now,
    });
  }
  try {
    const retrieval = new HybridRetrieval(ctx.storage);
    const chain = await retrieval.getPropertyAtomChain(GOLD_PARCEL_NODE_ID);
    const keys = {
      zoningFact: Boolean(chain.zoningFact),
      setbackRule: Boolean(chain.setbackRule),
      buildableEnvelope: Boolean(chain.buildableEnvelope),
    };
    const current =
      (keys.zoningFact ? 1 : 0) +
      (keys.setbackRule ? 1 : 0) +
      (keys.buildableEnvelope ? 1 : 0);
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current,
      signal: { parcelNodeId: GOLD_PARCEL_NODE_ID, keys },
      now,
    });
  } catch (err) {
    return finish({
      probeId,
      kind: "engine",
      baseline,
      current: null,
      errored: true,
      error: err instanceof Error ? err.message : String(err),
      signal: { parcelNodeId: GOLD_PARCEL_NODE_ID },
      now,
    });
  }
}

/** Run every Bastrop pack probe; returns flat ProbeResult[]. */
export async function runAllBastropProbes(
  ctx: ProbeContext,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  results.push(await probeBastropParcels(ctx));
  results.push(await probeBastropFloodplain(ctx));
  results.push(await probeZoningAgol(ctx));
  results.push(await probeBastropZoningDeadExpected(ctx));
  results.push(await probeOsmOverpass(ctx));
  results.push(await probeCountyRoadway(ctx));
  results.push(await probeStreetsSurveyed2016(ctx));
  results.push(...(await probeTxgioParcel48021(ctx)));
  results.push(...(await probeTier1Snapshots48021(ctx)));
  results.push(await probeBoundaryPrimitive(ctx));
  results.push(await probeDepthWarm(ctx));
  results.push(await probeRuleSetback(ctx));
  results.push(await probeReasoningChain(ctx));
  return results;
}
