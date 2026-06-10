/**
 * Cotality national parcel + zoning adapters (Phase 1 core).
 *
 * Parcel polygon: Spatial Tile GET /spatial-tile/parcels?lat=&lon=&pageNumber=0&pageSize=1
 * Zoning: Property GET /v2/properties/{clip}/site-location → landUseAndZoningCodes
 *
 * CLIP-joined via shared {@link resolveCotalityClip}.
 */

import { AdapterRunError, type Adapter, type AdapterContext, type AdapterResult } from "../types";
import {
  COTALITY_FRESHNESS_THRESHOLD_MONTHS,
  COTALITY_PROVIDER_LABEL,
  COTALITY_TIMEOUT_MS,
  __resetCotalityClipDedupForTests,
  __resetCotalityTokenCacheForTests,
  buildPolygonFeature,
  cotalityAdapterMeta,
  cotalityAppliesGeocoded,
  cotalityGetWithApp,
  extractParcelGeometryFromSpatialTile,
  normalizeGeometryToCoordinates,
  providerLabel,
  resolveCotalityClip,
  snapshotDateFromJson,
  type NormalizedFeature,
} from "./cotalityClient";

export {
  COTALITY_FRESHNESS_THRESHOLD_MONTHS,
  cotalityTokenUrl,
  cotalityPropertyBaseUrl,
  cotalitySpatialTileBaseUrl,
  __resetCotalityTokenCacheForTests,
  __resetCotalityClipDedupForTests,
  readCotalityAppCredentials,
  getCotalityAccessToken,
  resolveCotalityClip,
  buildPolygonFeature as buildFeature,
  normalizeGeometryToCoordinates,
  type NormalizedFeature,
} from "./cotalityClient";

// Re-export endpoint defaults for tests
export {
  COTALITY_TOKEN_URL_DEFAULT,
  COTALITY_PROPERTY_BASE_URL_DEFAULT,
  COTALITY_SPATIALTILE_BASE_URL_DEFAULT,
} from "./cotalityClient";

export function cotalityPropertyPointPath(): string {
  return process.env.COTALITY_PROPERTY_POINT_PATH ?? "/search/geocode";
}

export function cotalitySpatialTilePointPath(): string {
  return process.env.COTALITY_SPATIALTILE_POINT_PATH ?? "/parcels";
}

export function __resetCotalityDedupForTests(): void {
  __resetCotalityClipDedupForTests();
}

/** @deprecated test compat — merge no longer used; kept for unit test import */
export function mergeCotalityPropertyAndSpatial(
  propertyJson: unknown,
  spatialJson: unknown | null,
): Record<string, unknown> {
  const property =
    propertyJson && typeof propertyJson === "object"
      ? { ...(propertyJson as Record<string, unknown>) }
      : {};
  if (spatialJson && typeof spatialJson === "object") {
    const geom = extractParcelGeometryFromSpatialTile(spatialJson);
    (property as Record<string, unknown>).parcel = {
      geometry: geom,
      attributes: property,
    };
  }
  return property;
}

async function fetchSpatialParcelPolygon(args: {
  latitude: number;
  longitude: number;
  address?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
}): Promise<{ geometry: unknown; spatialJson: unknown }> {
  const spatialJson = await cotalityGetWithApp({
    app: "spatialtile",
    path: cotalitySpatialTilePointPath(),
    query: {
      lat: args.latitude,
      lon: args.longitude,
      latitude: args.latitude,
      longitude: args.longitude,
      pageNumber: 0,
      pageSize: 1,
      address: args.address ?? undefined,
    },
    fetchImpl: args.fetchImpl,
    signal: args.signal,
    adapterKeyForLog: args.adapterKeyForLog,
    label: "spatialtile-parcels",
  });
  const geometry = extractParcelGeometryFromSpatialTile(spatialJson);
  return { geometry, spatialJson };
}

async function fetchSiteLocation(args: {
  clip: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
}): Promise<unknown> {
  return cotalityGetWithApp({
    app: "property",
    path: `/${args.clip}/site-location`,
    fetchImpl: args.fetchImpl,
    signal: args.signal,
    adapterKeyForLog: args.adapterKeyForLog,
    label: "property-site-location",
  });
}

function zoningFromSiteLocation(siteJson: unknown): {
  props: Record<string, unknown>;
  geometry: unknown | null;
} {
  if (!siteJson || typeof siteJson !== "object") {
    return { props: {}, geometry: null };
  }
  const root = siteJson as Record<string, unknown>;
  const luz =
    (root.landUseAndZoningCodes as Record<string, unknown> | undefined) ??
    (root.landUseAndZoning as Record<string, unknown> | undefined) ??
    root;
  const props: Record<string, unknown> = {
    zoning: luz.zoningCode ?? luz.zoning ?? luz.code ?? null,
    zoning_description:
      luz.zoningDescription ?? luz.description ?? luz.zoningDesc ?? null,
    land_use_code: luz.landUseCode ?? luz.landUse ?? null,
    land_use_description: luz.landUseDescription ?? null,
  };
  const centroid =
    root.coordinatesParcel ??
    (root.coordinates as Record<string, unknown> | undefined)?.parcel;
  return { props, geometry: centroid ?? null };
}

export const cotalityParcelsAdapter: Adapter = {
  adapterKey: "cotality:parcels",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-parcel",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const clipCtx = await resolveCotalityClip({
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      address: ctx.parcel.address ?? null,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
    });

    const { geometry, spatialJson } = await fetchSpatialParcelPolygon({
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      address: ctx.parcel.address ?? null,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
    });

    let coords = normalizeGeometryToCoordinates(geometry);
    if (!coords) {
      const siteJson = await fetchSiteLocation({
        clip: clipCtx.clip,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        adapterKeyForLog: this.adapterKey,
      });
      const site = siteJson as Record<string, unknown>;
      coords = normalizeGeometryToCoordinates(
        site.coordinatesParcel ?? site.geometry,
      );
      if (!coords) {
        throw new AdapterRunError(
          "no-coverage",
          "Cotality returned no parcel polygon at this lat/lng (Spatial Tile geometry missing; centroid fallback also absent).",
        );
      }
    }

    const feature: NormalizedFeature = buildPolygonFeature(coords, {
      clip: clipCtx.clip,
      ...cotalityAdapterMeta(this.adapterKey, "spatialtile"),
      county: clipCtx.county,
    });

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(spatialJson),
      payload: { kind: "parcel", parcel: feature },
    };
  },
};

export const cotalityZoningAdapter: Adapter = {
  adapterKey: "cotality:zoning",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-zoning",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const clipCtx = await resolveCotalityClip({
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      address: ctx.parcel.address ?? null,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
    });

    const siteJson = await fetchSiteLocation({
      clip: clipCtx.clip,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
    });

    const { props, geometry } = zoningFromSiteLocation(siteJson);
    const hasZoning =
      props.zoning != null ||
      props.zoning_description != null ||
      props.land_use_code != null;
    if (!hasZoning) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality site-location returned no landUseAndZoningCodes at this CLIP.",
      );
    }

    let coords =
      normalizeGeometryToCoordinates(geometry) ?? ([] as unknown);

    if (!Array.isArray(coords) || (coords as unknown[]).length === 0) {
      try {
        const spatial = await fetchSpatialParcelPolygon({
          latitude: ctx.parcel.latitude,
          longitude: ctx.parcel.longitude,
          address: ctx.parcel.address ?? null,
          fetchImpl: ctx.fetchImpl,
          signal: ctx.signal,
          adapterKeyForLog: this.adapterKey,
        });
        coords =
          normalizeGeometryToCoordinates(spatial.geometry) ??
          ([] as unknown);
      } catch {
        coords = [] as unknown;
      }
    }

    const feature = buildPolygonFeature(coords, {
      clip: clipCtx.clip,
      ...props,
      ...cotalityAdapterMeta(this.adapterKey, "property"),
    });

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(siteJson),
      payload: { kind: "zoning", zoning: feature },
    };
  },
};
