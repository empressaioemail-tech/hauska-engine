/**
 * Wave-3 map layer geometry — floodway, DEM, topography, OZ tract.
 *
 * Wired by cc-agent-C per 75i task 11 / map-layers-contract.md.
 */


import { arcgisPointQuery } from "@hauska-engine/adapters/arcgis";
import {
  fetchUsgs3depDem,
  selectAdaptiveResolutionMeters,
  DEFAULT_TERRAIN_RESOLUTION_METERS,
  fetchBastropCountyContours,
  bastropContourCoverage,
  BASTROP_CONTOUR_SOURCE,
  BASTROP_CONTOUR_VINTAGE,
  BASTROP_CONTOUR_INTERVAL_LABEL,
} from "@hauska-engine/adapters/topography";
import { runHydrologyWorker } from "@hauska-engine/adapters/hydrology";
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
  MapLayerAdapterOutcome,
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
  outcomesByKey: Map<string, MapLayerAdapterOutcome>,
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
    const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(
      bbox,
      DEFAULT_TERRAIN_RESOLUTION_METERS,
    );
    const result = await fetchUsgs3depDem(bbox, { resolutionMeters: resolutionMetersAdapted });
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
    const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(
      bbox,
      DEFAULT_TERRAIN_RESOLUTION_METERS,
    );
    const result = await fetchUsgs3depDem(bbox, { resolutionMeters: resolutionMetersAdapted });
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

/**
 * SLOT 1 — LIVE 1-FT CONTOUR MAP SLOT (`topography-1ft`).
 *
 * Serves the AUTHORITATIVE contour tier for a viewport bbox as WGS84 GeoJSON
 * LineStrings the map can draw directly:
 *   - Bastrop County footprint  -> real 1-ft LiDAR contour polylines
 *     (`fetchBastropCountyContours`, ft->m US-survey-foot reconciled), tier
 *     `authoritative-1ft`.
 *   - Anywhere else, empty result, or a county-fetch failure -> honest 3DEP
 *     fallback (`deriveContoursGeoJson`), tier `3dep-fallback`.
 *
 * Reuses the SAME fetch + ft->m conversion + coverage predicate as the export
 * path (`resolveContourSource`), but keeps geometry in WGS84 lng/lat rather than
 * projecting to the local-ENU CAD frame — a map layer needs geographic coords,
 * not the metre-ENU frame the DXF/PDF path uses.
 *
 * HONESTY: the response stamps a `contourSource` provenance block distinguishing
 * `authoritative-1ft` (Bastrop) from `3dep-fallback` per bbox, with the true
 * source, vintage, and interval. 3DEP is NEVER labelled 1-ft.
 */
async function resolveTopography1ftSlot(
  request: MapLayersAssembleRequest,
): Promise<MapLayerSlot> {
  const bbox = resolveBbox(request);

  // 3DEP-derived fallback (shared by the "outside Bastrop", "empty", and
  // "county fetch failed" honest-degrade paths).
  const derived3depFallback = async (
    fallbackReason: string,
  ): Promise<MapLayerSlot> => {
    const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(
      bbox,
      DEFAULT_TERRAIN_RESOLUTION_METERS,
    );
    const dem = await fetchUsgs3depDem(bbox, {
      resolutionMeters: resolutionMetersAdapted,
    });
    const parsed = await parseDemBytes(new Uint8Array(dem.bytes));
    const interval = 1;
    const { featureCollection, thresholds } = deriveContoursGeoJson(
      parsed,
      bbox,
      interval,
    );
    const nodataRatio = parsed.nodataCount / (parsed.width * parsed.height);
    const coverage =
      nodataRatio > 0.05
        ? degradedCoverage(
            `${Math.round(nodataRatio * 100)}% nodata cells masked from contours`,
            true,
          )
        : okCoverage();
    return okWave3Slot(
      "topography-1ft",
      "usgs:3dep-dem",
      {
        kind: "topography-contours",
        geojson: featureCollection,
        attributes: {
          contourSource: {
            tier: "3dep-fallback",
            source: "usgs:3dep-dem",
            vintage: "USGS 3DEP (national mosaic)",
            intervalLabel: `${interval}-m interval (3DEP-derived)`,
            intervalMeters: interval,
            unit: "metres NAVD88 (3DEP-derived contour lines)",
            contourCount: featureCollection.features.length,
            fallbackReason,
          },
          thresholds,
        },
        provider: "USGS 3DEP + site-topography",
        snapshotDate: dem.fetchedAt,
      },
      dem.fetchedAt,
      coverage,
    );
  };

  try {
    if (!bastropContourCoverage(bbox)) {
      return await derived3depFallback(
        "bbox outside Bastrop County 1-ft footprint",
      );
    }

    let county;
    try {
      county = await fetchBastropCountyContours(bbox);
    } catch (err) {
      return await derived3depFallback(
        `Bastrop 1-ft fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!county.polylines.length) {
      return await derived3depFallback(
        "Bastrop 1-ft service returned no contours intersecting this bbox",
      );
    }

    const features = county.polylines.map((line) => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: line.points,
      },
      properties: {
        contour: line.elevationMeters,
        contourFeet: line.elevationFeet,
        index: line.index,
      },
    }));

    return okWave3Slot(
      "topography-1ft",
      BASTROP_CONTOUR_SOURCE,
      {
        kind: "topography-contours",
        geojson: { type: "FeatureCollection", features },
        attributes: {
          contourSource: {
            tier: "authoritative-1ft",
            source: BASTROP_CONTOUR_SOURCE,
            vintage: BASTROP_CONTOUR_VINTAGE,
            intervalLabel: BASTROP_CONTOUR_INTERVAL_LABEL,
            unit: "metres NAVD88 (converted from US survey feet)",
            verticalUnitConverted: county.verticalUnitConverted,
            contourCount: features.length,
          },
          featureCount: county.featureCount,
          bbox: county.bbox,
        },
        provider: "Bastrop County GIS (Contour1Ft2017, 2017 StratMap LiDAR)",
      },
      county.vintage,
    );
  } catch (err) {
    return pendingWave3Slot(
      "topography-1ft",
      err instanceof Error ? err.message : "1-ft contour resolution failed",
    );
  }
}

/**
 * SLOT 2 — HYDROLOGY-D8 MAP SLOT (`hydrology-flow`, bbox -> GeoJSON).
 *
 * Wraps the existing D8/drainage compute into a bbox-scoped, map-renderable
 * form: fetch the ~1m 3DEP DEM for the viewport bbox, run D8 flow accumulation,
 * and emit the significant flow CHANNELS (`flowLinesGeoJson`) as GeoJSON
 * LineStrings ("where does water flow in this view").
 *
 * The bbox does not carry an interactive pour point, so we derive a catchment
 * pour point at the bbox centre — the flow-line channels are driven by the
 * accumulation THRESHOLD (channels = cells with accumulation above threshold),
 * not by that single outlet, so a centre pour point is honest for a viewport
 * "flow lines" render. Compute is bounded by the same 512² drainage-cell cap +
 * adaptive-resolution downsample the terrain/hydrology paths use, so a large
 * viewport bbox at 1m cannot OOM/hang.
 *
 * HONESTY: a degraded/empty D8 result (flat terrain, no channels above
 * threshold, DEM void) returns honest-empty with the real reason — never a
 * fabricated meander.
 */
const HYDROLOGY_FLOW_MAX_CELLS = 512 * 512;

function downsampleFlowElevation(
  elevation: Float32Array,
  width: number,
  height: number,
): { elevation: Float32Array; width: number; height: number } {
  const cells = width * height;
  if (cells <= HYDROLOGY_FLOW_MAX_CELLS) {
    return { elevation, width, height };
  }
  const scale = Math.ceil(Math.sqrt(cells / HYDROLOGY_FLOW_MAX_CELLS));
  const outW = Math.max(8, Math.floor(width / scale));
  const outH = Math.max(8, Math.floor(height / scale));
  const out = new Float32Array(outW * outH);
  for (let row = 0; row < outH; row++) {
    for (let col = 0; col < outW; col++) {
      const srcCol = Math.min(width - 1, col * scale);
      const srcRow = Math.min(height - 1, row * scale);
      out[row * outW + col] = elevation[srcRow * width + srcCol]!;
    }
  }
  return { elevation: out, width: outW, height: outH };
}

async function resolveHydrologyFlowSlot(
  request: MapLayersAssembleRequest,
): Promise<MapLayerSlot> {
  const bbox = resolveBbox(request);
  try {
    const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(
      bbox,
      DEFAULT_TERRAIN_RESOLUTION_METERS,
    );
    const dem = await fetchUsgs3depDem(bbox, {
      resolutionMeters: resolutionMetersAdapted,
    });
    const parsed = await parseDemBytes(new Uint8Array(dem.bytes));

    // Row-major finite elevation grid (NaN = nodata) for the D8 engine.
    const elevationFull = Float32Array.from(parsed.values);
    const down = downsampleFlowElevation(
      elevationFull,
      parsed.width,
      parsed.height,
    );

    // Pour point at bbox centre; channels are threshold-driven, not
    // outlet-driven, so a centre pour point is honest for a viewport render.
    const pourLng = (bbox.westLng + bbox.eastLng) / 2;
    const pourLat = (bbox.southLat + bbox.northLat) / 2;

    const result = await runHydrologyWorker({
      demBytes: new Uint8Array(dem.bytes).buffer.slice(0) as ArrayBuffer,
      pourLng,
      pourLat,
      catchmentBbox: bbox,
      width: down.width,
      height: down.height,
      elevation: down.elevation,
    });

    if (result.status === "error") {
      // Honest-empty: real reason (flat terrain, nodata DEM, worker failure).
      return okWave3Slot(
        "hydrology-flow",
        "hydrology:d8",
        {
          kind: "hydrology-flow",
          geojson: { type: "FeatureCollection", features: [] },
          attributes: {
            channelCount: 0,
            honestEmptyReason: result.message,
            errorCode: result.code,
            resolutionMetersAdapted,
            gridWidth: down.width,
            gridHeight: down.height,
          },
          provider: "USGS 3DEP + D8 flow accumulation",
          snapshotDate: dem.fetchedAt,
          note: `hydrology-flow honest-empty: ${result.message}`,
        },
        dem.fetchedAt,
        degradedCoverage(result.message, true),
      );
    }

    const channels = result.flowLinesGeoJson;
    const channelCount = channels.features.length;
    const coverage =
      channelCount === 0
        ? degradedCoverage(
            "no flow channels above accumulation threshold in this bbox",
            true,
          )
        : result.fallbackUsed
          ? degradedCoverage(
              result.fallbackReason ?? "pysheds unavailable; native D8 fallback",
              true,
            )
          : okCoverage();

    return okWave3Slot(
      "hydrology-flow",
      `hydrology:${result.library}`,
      {
        kind: "hydrology-flow",
        geojson: channels,
        attributes: {
          channelCount,
          accumulationThreshold: result.accumulationThreshold,
          routing: result.routing,
          library: result.library,
          libraryVersion: result.libraryVersion,
          fallbackUsed: result.fallbackUsed ?? false,
          fallbackReason: result.fallbackReason ?? null,
          pourPoint: result.pourPoint,
          resolutionMetersAdapted,
          gridWidth: down.width,
          gridHeight: down.height,
          honestEmptyReason:
            channelCount === 0
              ? "no flow channels above accumulation threshold in this bbox"
              : null,
        },
        provider: "USGS 3DEP + D8 flow accumulation",
        snapshotDate: dem.fetchedAt,
      },
      dem.fetchedAt,
      coverage,
    );
  } catch (err) {
    return pendingWave3Slot(
      "hydrology-flow",
      err instanceof Error ? err.message : "hydrology flow resolution failed",
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
  outcomesByKey: Map<string, MapLayerAdapterOutcome>,
): Promise<MapLayerSlot> {
  switch (layerKey) {
    case "floodway":
      return resolveFloodwaySlot(request, outcomesByKey);
    case "dem":
      return resolveDemSlot(request);
    case "topography":
      return resolveTopographySlot(request);
    case "topography-1ft":
      return resolveTopography1ftSlot(request);
    case "hydrology-flow":
      return resolveHydrologyFlowSlot(request);
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
  "topography-1ft",
  "hydrology-flow",
  "opportunity-zone-tract",
] as const;
