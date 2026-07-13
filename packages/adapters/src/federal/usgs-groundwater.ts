/**
 * USGS NWIS groundwater — federal subsurface adapter.
 *
 * Finds active groundwater monitoring locations within a ~10 km search
 * window around the parcel, then reads the most recent depth-to-water
 * measurement (parameter 72019) from the NWIS instantaneous-values
 * service.
 *
 * Parcels with no nearby NWIS wells still emit an `ok` row with
 * `wellCount: 0` so the briefing attributes "no mapped monitoring
 * coverage" to a cited source rather than painting the row red.
 */

import { fetchWithRetry } from "../retry";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { federalGeocodeApplies, isUsLatLng } from "./_federalGeocodeGate";

export const USGS_NWIS_SITE_ENDPOINT =
  "https://waterservices.usgs.gov/nwis/site/";

export const USGS_NWIS_IV_ENDPOINT =
  "https://waterservices.usgs.gov/nwis/iv/";

/** Depth to water level, feet below land surface (NWIS parm 72019). */
const GW_DEPTH_PARAMETER_CD = "72019";

/** ~0.09° ≈ 10 km at Central Texas latitude. */
const SEARCH_DELTA_DEG = 0.09;

export const USGS_GROUNDWATER_PROVIDER_LABEL =
  "USGS National Water Information System (NWIS)";

export const USGS_GROUNDWATER_FRESHNESS_THRESHOLD_MONTHS = 12;

export type NwisGwSitePoint = {
  siteNo: string;
  siteName: string | null;
  latitude: number;
  longitude: number;
};

/**
 * NWIS rejects bBox components carrying more than 7 digits right of the
 * decimal point ("BBox list argument at element N failed validation:
 * requires a decimal number with at most 7 digits to the right of the
 * decimal point", HTTP 400). Raw float arithmetic in `searchBbox`
 * produces exactly that (e.g. `30.1105 + 0.09 = 30.200499999999998`),
 * so every component is rounded to 6 decimals (~0.11 m — far below the
 * search-radius tolerance) before serialization. `Number(...)` strips
 * trailing zeros, which NWIS also accepts.
 */
function nwisCoord(value: number): string {
  return String(Number(value.toFixed(6)));
}

export function buildNwisGwSiteBboxUrl(bbox: {
  west: number;
  south: number;
  east: number;
  north: number;
}): string {
  const url = new URL(USGS_NWIS_SITE_ENDPOINT);
  url.searchParams.set("format", "rdb");
  url.searchParams.set(
    "bBox",
    [bbox.west, bbox.south, bbox.east, bbox.north].map(nwisCoord).join(","),
  );
  url.searchParams.set("siteType", "GW");
  return url.toString();
}

/** NWIS site/ only returns bbox queries reliably with format=rdb (json+bBox → HTTP 400). */
export function parseNwisGwSitesFromRdb(text: string): NwisGwSitePoint[] {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length < 2) return [];

  const header = lines[0]!.split("\t");
  const siteIdx = header.indexOf("site_no");
  const nameIdx = header.indexOf("station_nm");
  const latIdx = header.indexOf("dec_lat_va");
  const lonIdx = header.indexOf("dec_long_va");
  if (siteIdx < 0 || latIdx < 0 || lonIdx < 0) return [];

  const sites: NwisGwSitePoint[] = [];
  for (const line of lines.slice(2)) {
    const cols = line.split("\t");
    const siteNo = cols[siteIdx]?.trim() ?? "";
    const lat = Number(cols[latIdx]);
    const lon = Number(cols[lonIdx]);
    if (!siteNo || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    sites.push({
      siteNo,
      siteName: nameIdx >= 0 ? cols[nameIdx]?.trim() || null : null,
      latitude: lat,
      longitude: lon,
    });
  }
  return sites;
}

function nowIso(): string {
  return new Date().toISOString();
}

function searchBbox(
  latitude: number,
  longitude: number,
): { west: number; south: number; east: number; north: number } {
  return {
    west: longitude - SEARCH_DELTA_DEG,
    south: latitude - SEARCH_DELTA_DEG,
    east: longitude + SEARCH_DELTA_DEG,
    north: latitude + SEARCH_DELTA_DEG,
  };
}

function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const r = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

async function fetchNwisSites(
  ctx: AdapterContext,
  url: string,
  label: string,
): Promise<NwisGwSitePoint[]> {
  const { response: res, attempts } = await fetchWithRetry(
    url,
    { signal: ctx.signal },
    {
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: label,
    },
  );
  if (!res.ok) {
    throw new AdapterRunError(
      "upstream-error",
      `${label} responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}. Use Force refresh to retry.`,
    );
  }
  const text = await res.text();
  return parseNwisGwSitesFromRdb(text);
}

async function fetchJson(
  ctx: AdapterContext,
  url: string,
  label: string,
): Promise<unknown> {
  const { response: res, attempts } = await fetchWithRetry(
    url,
    { signal: ctx.signal },
    {
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: label,
    },
  );
  if (!res.ok) {
    throw new AdapterRunError(
      "upstream-error",
      `${label} responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}. Use Force refresh to retry.`,
    );
  }
  try {
    return await res.json();
  } catch (err) {
    throw new AdapterRunError(
      "parse-error",
      `${label} response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseLatestGwDepth(json: unknown): {
  depthFeet: number | null;
  measuredAt: string | null;
} {
  if (!json || typeof json !== "object") {
    return { depthFeet: null, measuredAt: null };
  }
  const value = (json as { value?: unknown }).value;
  if (!value || typeof value !== "object") {
    return { depthFeet: null, measuredAt: null };
  }
  const timeSeries = (value as { timeSeries?: unknown }).timeSeries;
  if (!Array.isArray(timeSeries) || timeSeries.length === 0) {
    return { depthFeet: null, measuredAt: null };
  }
  const series = timeSeries[0] as {
    values?: Array<{ value?: Array<{ value?: string; dateTime?: string }> }>;
  };
  const points = series.values?.[0]?.value;
  if (!Array.isArray(points) || points.length === 0) {
    return { depthFeet: null, measuredAt: null };
  }
  const latest = points[points.length - 1];
  const depth = latest?.value ? Number(latest.value) : NaN;
  return {
    depthFeet: Number.isFinite(depth) ? depth : null,
    measuredAt:
      typeof latest?.dateTime === "string" ? latest.dateTime : null,
  };
}

export const usgsGroundwaterAdapter: Adapter = {
  adapterKey: "usgs:groundwater",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "usgs-groundwater",
  provider: USGS_GROUNDWATER_PROVIDER_LABEL,
  jurisdictionGate: {},
  appliesTo(ctx) {
    return (
      federalGeocodeApplies(ctx) &&
      isUsLatLng(ctx.parcel.latitude, ctx.parcel.longitude)
    );
  },
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const { latitude, longitude } = ctx.parcel;
    const bbox = searchBbox(latitude, longitude);
    const siteUrl = buildNwisGwSiteBboxUrl(bbox);

    const sites = (await fetchNwisSites(ctx, siteUrl, "USGS NWIS site"))
      .map((site) => ({
        siteNo: site.siteNo,
        siteName: site.siteName,
        latitude: site.latitude,
        longitude: site.longitude,
        distanceMiles: haversineMiles(
          latitude,
          longitude,
          site.latitude,
          site.longitude,
        ),
      }))
      .sort(
        (a, b) =>
          (a.distanceMiles ?? Number.POSITIVE_INFINITY) -
          (b.distanceMiles ?? Number.POSITIVE_INFINITY),
      );

    if (sites.length === 0) {
      return {
        adapterKey: this.adapterKey,
        tier: this.tier,
        layerKind: this.layerKind,
        sourceKind: this.sourceKind,
        provider: this.provider,
        snapshotDate: nowIso(),
        payload: {
          kind: "groundwater-monitoring",
          wellCount: 0,
          nearestWell: null,
          depthToWaterFeet: null,
          measuredAt: null,
          searchRadiusMiles: Math.round(SEARCH_DELTA_DEG * 69),
        },
        note: "No active USGS groundwater monitoring wells within the search radius.",
      };
    }

    const nearest = sites[0]!;
    const ivUrl = new URL(USGS_NWIS_IV_ENDPOINT);
    ivUrl.searchParams.set("format", "json");
    ivUrl.searchParams.set("sites", nearest.siteNo);
    ivUrl.searchParams.set("parameterCd", GW_DEPTH_PARAMETER_CD);
    ivUrl.searchParams.set("period", "P365D");

    const ivJson = await fetchJson(ctx, ivUrl.toString(), "USGS NWIS iv");
    const { depthFeet, measuredAt } = parseLatestGwDepth(ivJson);

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "groundwater-monitoring",
        wellCount: sites.length,
        nearestWell: {
          siteNo: nearest.siteNo,
          siteName: nearest.siteName,
          distanceMiles: nearest.distanceMiles,
        },
        depthToWaterFeet: depthFeet,
        measuredAt,
        searchRadiusMiles: Math.round(SEARCH_DELTA_DEG * 69),
        wells: sites.slice(0, 5),
      },
    };
  },
};
