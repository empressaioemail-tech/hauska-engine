/**
 * Wave-3 map layer geometry — floodway, DEM, topography, OZ tract.
 *
 * Wired by cc-agent-C per 75i task 11 / map-layers-contract.md.
 */

import type { AdapterRunOutcome } from "@hauska-engine/adapters";
import { arcgisPointQuery } from "@hauska-engine/adapters/arcgis";
import { fetchUsgs3depDem } from "@hauska-engine/adapters/topography";
import {
  deriveContoursGeoJson,
  parseDemBytes,
} from "@hauska-engine/engine-core/site-topography";
import {
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
  sealEnvelope,
  type EngineEnvelope,
} from "@hauska-engine/engine-core/envelope";
import type {
  MapLayerGeometryPayload,
  MapLayerKey,
  MapLayerSlot,
  MapLayersAssembleRequest,
} from "@hauska-engine/engine-core/map-layers";
import { lookupOpportunityZoneTract } from "./opportunityZoneRegistry.js";

const FEMA_NFHL_FLOOD_ZONES =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28";

export interface MapLayersBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export function defaultCatchmentBbox(
  latitude: number,
  longitude: number,
  bufferDeg = 0.002,
): MapLayersBbox {
  return {
    westLng: longitude - bufferDeg,
    southLat: latitude - bufferDeg,
    eastLng: longitude + bufferDeg,
    northLat: latitude + bufferDeg,
  };
}

function resolveBbox(request: MapLayersAssembleRequest): MapLayersBbox {
  return request.bbox ?? defaultCatchmentBbox(
    request.parcel.latitude,
    request.parcel.longitude,
  );
}

function okWave3Slot(
  layerKey: MapLayerKey,
  adapterKey: string,
  body: MapLayerGeometryPayload,
  dataVintage: string | null,
  coverage = okCoverage(),
): MapLayerSlot {
  return {
    layerKey,
    status: "ok",
    adapterKey,
    envelope: sealEnvelope(body, {
      confidence: resolveReadPathConfidence({ deterministic: true }),
      dataVintage,
      coverage,
      source: { adapter: adapterKey, citationIds: [layerKey] },
    }),
  };
}

function pendingWave3Slot(layerKey: MapLayerKey, reason: string): MapLayerSlot {
  return {
    layerKey,
    status: "pending",
    pendingReason: reason,
    envelope: sealEnvelope(
      { kind: layerKey, note: reason },
      {
        confidence: resolveReadPathConfidence({ deterministic: true }),
        dataVintage: null,
        coverage: degradedCoverage(reason),
        source: { adapter: `map-layers:${layerKey}` },
      },
    ),
  };
}

function esriToGeoJsonFeature(
  feature: { attributes: Record<string, unknown>; geometry?: Record<string, unknown> | null },
): Record<string, unknown> | null {
  const geom = feature.geometry;
  if (!geom || typeof geom !== "object") return null;
  if ("rings" in geom && Array.isArray(geom.rings)) {
    return {
      type: "Feature",
      properties: feature.attributes,
      geometry: {
        type: "Polygon",
        coordinates: geom.rings,
      },
    };
  }
  if ("x" in geom && "y" in geom) {
    return {
      type: "Feature",
      properties: feature.attributes,
      geometry: { type: "Point", coordinates: [geom.x, geom.y] },
    };
  }
  return {
    type: "Feature",
    properties: feature.attributes,
    geometry: geom,
  };
}

function isFloodwayFeature(attrs: Record<string, unknown>): boolean {
  const subty = String(attrs.ZONE_SUBTY ?? "").toUpperCase();
  return subty.includes("FLOODWAY");
}

async function resolveFloodwaySlot(
  request: MapLayersAssembleRequest,
  outcomesByKey: Map<string, AdapterRunOutcome>,
): Promise<MapLayerSlot> {
  const fema = outcomesByKey.get("fema:nfhl-flood-zone");
  if (fema?.status === "ok" && fema.result) {
    const payload = fema.result.payload as {
      features?: Array<{
        attributes: Record<string, unknown>;
        geometry?: Record<string, unknown> | null;
      }>;
      zoneSubtype?: string | null;
    };
    const floodwayFeatures = (payload.features ?? []).filter((f) =>
      isFloodwayFeature(f.attributes),
    );
    if (floodwayFeatures.length > 0) {
      const geojson = {
        type: "FeatureCollection",
        features: floodwayFeatures
          .map(esriToGeoJsonFeature)
          .filter((f): f is Record<string, unknown> => f !== null),
      };
      return okWave3Slot(
        "floodway",
        "fema:nfhl-flood-zone",
        {
          kind: "floodway",
          geojson,
          attributes: { source: "FEMA NFHL ZONE_SUBTY=FLOODWAY" },
          provider: fema.result.provider,
          snapshotDate: fema.result.snapshotDate,
        },
        fema.result.snapshotDate ?? null,
      );
    }
    if (
      payload.zoneSubtype &&
      String(payload.zoneSubtype).toUpperCase().includes("FLOODWAY")
    ) {
      const top = payload.features?.[0];
      const feature = top ? esriToGeoJsonFeature(top) : null;
      return okWave3Slot(
        "floodway",
        "fema:nfhl-flood-zone",
        {
          kind: "floodway",
          geojson: feature
            ? { type: "FeatureCollection", features: [feature] }
            : undefined,
          attributes: { zoneSubtype: payload.zoneSubtype },
          provider: fema.result.provider,
          snapshotDate: fema.result.snapshotDate,
        },
        fema.result.snapshotDate ?? null,
      );
    }
  }

  try {
    const result = await arcgisPointQuery({
      serviceUrl: FEMA_NFHL_FLOOD_ZONES,
      latitude: request.parcel.latitude,
      longitude: request.parcel.longitude,
      outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF",
      returnGeometry: true,
      upstreamLabel: "FEMA NFHL floodway",
    });
    const floodwayFeatures = result.features.filter((f) =>
      isFloodwayFeature(f.attributes),
    );
    if (floodwayFeatures.length === 0) {
      return okWave3Slot(
        "floodway",
        "fema:nfhl-flood-zone",
        {
          kind: "floodway",
          geojson: { type: "FeatureCollection", features: [] },
          attributes: { inFloodway: false },
          note: "Parcel does not intersect a mapped regulatory floodway.",
        },
        new Date().toISOString(),
      );
    }
    const geojson = {
      type: "FeatureCollection",
      features: floodwayFeatures
        .map(esriToGeoJsonFeature)
        .filter((f): f is Record<string, unknown> => f !== null),
    };
    return okWave3Slot(
      "floodway",
      "fema:nfhl-flood-zone",
      {
        kind: "floodway",
        geojson,
        attributes: { inFloodway: true },
        provider: "FEMA National Flood Hazard Layer (NFHL)",
      },
      new Date().toISOString(),
    );
  } catch (err) {
    return pendingWave3Slot(
      "floodway",
      err instanceof Error ? err.message : "FEMA floodway lookup failed",
    );
  }
}

async function resolveDemSlot(
  request: MapLayersAssembleRequest,
): Promise<MapLayerSlot> {
  const bbox = resolveBbox(request);
  try {
    const result = await fetchUsgs3depDem(bbox, { resolutionMeters: 10 });
    return okWave3Slot(
      "dem",
      "usgs:3dep-dem",
      {
        kind: "dem",
        attributes: {
          widthPx: result.widthPx,
          heightPx: result.heightPx,
          bbox: result.bbox,
          demBytesBase64: Buffer.from(result.bytes).toString("base64"),
        },
        provider: "USGS 3DEP",
        snapshotDate: result.fetchedAt,
      },
      result.fetchedAt,
    );
  } catch (err) {
    return pendingWave3Slot(
      "dem",
      err instanceof Error ? err.message : "USGS 3DEP DEM fetch failed",
    );
  }
}

async function resolveTopographySlot(
  request: MapLayersAssembleRequest,
): Promise<MapLayerSlot> {
  const bbox = resolveBbox(request);
  try {
    const result = await fetchUsgs3depDem(bbox, { resolutionMeters: 10 });
    const dem = await parseDemBytes(new Uint8Array(result.bytes));
    const interval = 1;
    const { featureCollection, thresholds } = deriveContoursGeoJson(
      dem,
      bbox,
      interval,
    );
    const nodataRatio = dem.nodataCount / (dem.width * dem.height);
    const coverage =
      nodataRatio > 0.05
        ? degradedCoverage(
            `${Math.round(nodataRatio * 100)}% nodata cells masked from contours`,
            true,
          )
        : okCoverage();
    return okWave3Slot(
      "topography",
      "site-topography:contours",
      {
        kind: "topography-contours",
        geojson: featureCollection,
        attributes: { thresholds, intervalMeters: interval },
        provider: "USGS 3DEP + site-topography",
        snapshotDate: result.fetchedAt,
      },
      result.fetchedAt,
      coverage,
    );
  } catch (err) {
    return pendingWave3Slot(
      "topography",
      err instanceof Error ? err.message : "contour derivation failed",
    );
  }
}

function resolveOzTractSlot(request: MapLayersAssembleRequest): MapLayerSlot {
  const lookup = lookupOpportunityZoneTract({
    latitude: request.parcel.latitude,
    longitude: request.parcel.longitude,
  });
  if (!lookup.inOpportunityZone || !lookup.tractFeature) {
    return okWave3Slot(
      "opportunity-zone-tract",
      "national:opportunity-zone",
      {
        kind: "opportunity-zone-tract",
        geojson: { type: "FeatureCollection", features: [] },
        attributes: {
          inOpportunityZone: false,
          tractListVersion: lookup.tractListVersion,
          ozRound: lookup.ozRound,
        },
        provider: "CDFI Fund / HUD",
      },
      new Date().toISOString(),
    );
  }
  return okWave3Slot(
    "opportunity-zone-tract",
    "national:opportunity-zone",
    {
      kind: "opportunity-zone-tract",
      geojson: {
        type: "FeatureCollection",
        features: [lookup.tractFeature],
      },
      attributes: {
        inOpportunityZone: true,
        tractGeoid: lookup.tractGeoid,
        ozRound: lookup.ozRound,
        tractListVersion: lookup.tractListVersion,
      },
      provider: "CDFI Fund / HUD",
    },
    new Date().toISOString(),
  );
}

export async function resolveWave3MapLayerSlot(
  layerKey: MapLayerKey,
  request: MapLayersAssembleRequest,
  outcomesByKey: Map<string, AdapterRunOutcome>,
): Promise<MapLayerSlot> {
  switch (layerKey) {
    case "floodway":
      return resolveFloodwaySlot(request, outcomesByKey);
    case "dem":
      return resolveDemSlot(request);
    case "topography":
      return resolveTopographySlot(request);
    case "opportunity-zone-tract":
      return resolveOzTractSlot(request);
    default:
      return pendingWave3Slot(layerKey, `no wave-3 resolver for ${layerKey}`);
  }
}

export const WAVE3_LAYER_KEYS: readonly MapLayerKey[] = [
  "floodway",
  "dem",
  "topography",
  "opportunity-zone-tract",
] as const;
