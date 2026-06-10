/**
 * USGS Earthquake Hazards — federal seismic design adapter.
 *
 * Combines:
 *   1. USGS Seismic Design Web Service (ASCE 7-22) for site-modified
 *      spectral accelerations and seismic design categories.
 *   2. Quaternary fault MapServer proximity query (50 km buffer) for
 *      nearest mapped fault trace.
 *
 * Locations outside the design-maps coverage envelope emit a neutral
 * `no-coverage` verdict rather than a red failure.
 */

import { fetchWithRetry } from "../retry";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { federalGeocodeApplies, isUsLatLng } from "./_federalGeocodeGate";

export const USGS_SEISMIC_DESIGN_ENDPOINT =
  "https://earthquake.usgs.gov/ws/designmaps/asce7-22.json";

export const USGS_QFAULTS_LAYER =
  "https://earthquake.usgs.gov/arcgis/rest/services/haz/Qfaults/MapServer/0";

export const USGS_SEISMIC_PROVIDER_LABEL =
  "USGS Earthquake Hazards Program (ASCE 7-22 design maps)";

export const USGS_SEISMIC_FRESHNESS_THRESHOLD_MONTHS = 24;

/** Default ASCE 7 risk category / site class when the brief has no structural inputs. */
const DEFAULT_RISK_CATEGORY = "II";
const DEFAULT_SITE_CLASS = "D";

/** Fault proximity search radius (km) passed to ArcGIS `distance`. */
const FAULT_SEARCH_KM = 50;

function nowIso(): string {
  return new Date().toISOString();
}

function pickNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchDesignMaps(
  ctx: AdapterContext,
  latitude: number,
  longitude: number,
): Promise<Record<string, unknown>> {
  const url = new URL(USGS_SEISMIC_DESIGN_ENDPOINT);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("riskCategory", DEFAULT_RISK_CATEGORY);
  url.searchParams.set("siteClass", DEFAULT_SITE_CLASS);
  url.searchParams.set("title", "cortex-site-context");

  const { response: res, attempts } = await fetchWithRetry(
    url.toString(),
    { signal: ctx.signal },
    {
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: "USGS seismic design maps",
    },
  );
  if (!res.ok) {
    if (res.status === 400 || res.status === 404) {
      throw new AdapterRunError(
        "no-coverage",
        "USGS seismic design maps have no coverage for this location.",
      );
    }
    throw new AdapterRunError(
      "upstream-error",
      `USGS seismic design maps responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}. Use Force refresh to retry.`,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new AdapterRunError(
      "parse-error",
      `USGS seismic design maps response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!json || typeof json !== "object") {
    throw new AdapterRunError(
      "parse-error",
      "USGS seismic design maps response was not a JSON object",
    );
  }
  const response = (json as { response?: unknown }).response;
  if (!response || typeof response !== "object") {
    throw new AdapterRunError(
      "parse-error",
      "USGS seismic design maps response missing `response` envelope",
    );
  }
  const status = (response as { status?: unknown }).status;
  if (status === "error") {
    throw new AdapterRunError(
      "no-coverage",
      "USGS seismic design maps returned no data for this location.",
    );
  }
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    throw new AdapterRunError(
      "no-coverage",
      "USGS seismic design maps returned no data for this location.",
    );
  }
  return data as Record<string, unknown>;
}

async function queryNearestFault(
  ctx: AdapterContext,
  latitude: number,
  longitude: number,
): Promise<{
  faultName: string | null;
  faultClass: string | null;
  slipRate: string | null;
  distanceKm: number | null;
} | null> {
  const url = new URL(`${USGS_QFAULTS_LAYER.replace(/\/$/, "")}/query`);
  url.searchParams.set("f", "json");
  url.searchParams.set(
    "geometry",
    JSON.stringify({
      x: longitude,
      y: latitude,
      spatialReference: { wkid: 4326 },
    }),
  );
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("distance", String(FAULT_SEARCH_KM * 1000));
  url.searchParams.set("units", "esriSRUnit_Meter");
  url.searchParams.set("outFields", "fault_name,section_name,class,slip_rate");
  url.searchParams.set("returnGeometry", "false");

  try {
    const { response: res } = await fetchWithRetry(
      url.toString(),
      { signal: ctx.signal },
      {
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        upstreamLabel: "USGS QFaults",
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      features?: Array<{ attributes?: Record<string, unknown> }>;
    };
    const features = json.features;
    if (!Array.isArray(features) || features.length === 0) return null;
    const attrs = features[0].attributes ?? {};
    return {
      faultName:
        pickString(attrs.fault_name) ?? pickString(attrs.section_name),
      faultClass: pickString(attrs.class),
      slipRate: pickString(attrs.slip_rate),
      distanceKm: null,
    };
  } catch {
    return null;
  }
}

export const usgsSeismicAdapter: Adapter = {
  adapterKey: "usgs:seismic",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "usgs-seismic",
  provider: USGS_SEISMIC_PROVIDER_LABEL,
  jurisdictionGate: {},
  appliesTo(ctx) {
    return (
      federalGeocodeApplies(ctx) &&
      isUsLatLng(ctx.parcel.latitude, ctx.parcel.longitude)
    );
  },
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const { latitude, longitude } = ctx.parcel;
    const [designData, nearestFault] = await Promise.all([
      fetchDesignMaps(ctx, latitude, longitude),
      queryNearestFault(ctx, latitude, longitude),
    ]);

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "seismic-design",
        referenceDocument: "ASCE7-22",
        riskCategory: DEFAULT_RISK_CATEGORY,
        siteClass: DEFAULT_SITE_CLASS,
        sds: pickNumber(designData.sds),
        sd1: pickNumber(designData.sd1),
        sms: pickNumber(designData.sms),
        sm1: pickNumber(designData.sm1),
        pga: pickNumber(designData.pga),
        seismicDesignCategory:
          pickString(designData.sdc) ?? pickString(designData.sdcs),
        longPeriodTransitionSeconds:
          pickNumber(designData.tl) ?? pickNumber(designData["t-sub-l"]),
        nearestFault,
        faultSearchRadiusKm: FAULT_SEARCH_KM,
        rawDesignData: designData,
      },
    };
  },
};
