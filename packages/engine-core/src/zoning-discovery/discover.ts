/**
 * Per-city zoning layer discovery orchestrator.
 */

import polygonClipping from "polygon-clipping";

import { resolveHostUrlsForQueueItem } from "./catalogue.js";
import { fetchJsonResilient } from "./fetch-json.js";
import {
  classifyLayerSignature,
  rankEuclideanCandidates,
  ZONING_IDENTIFICATION_THRESHOLDS,
} from "./layer-signature.js";
import {
  mapLayerFields,
  recurseArcGisRestFolders,
  type ArcGisLayerJson,
} from "./folder-recurse.js";
import type {
  Bbox4326,
  DiscoveryProbeEvidence,
  LayerProbeMeta,
  QueueItem,
  SearchPathAttempt,
} from "./types.js";

type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

type GeoJsonMultiPolygon = {
  type: "MultiPolygon";
  coordinates: number[][][][];
};

type GeoJsonPolygonal = GeoJsonPolygon | GeoJsonMultiPolygon;

export type DiscoverOptions = {
  includeCatalogue?: boolean;
  includeHub?: boolean;
  includeCkan?: boolean;
  maxDepth?: number;
  /** Cap layer probes per host after compact-service sort (default 24). */
  maxLayersPerHost?: number;
  fetchJson?: (url: string) => Promise<{ status: number; body: unknown; transportError?: string }>;
};

async function defaultFetchJson(
  url: string,
): Promise<{ status: number; body: unknown; transportError?: string }> {
  return fetchJsonResilient(url);
}

function asBbox4326(extent: ArcGisLayerJson["extent"] | null | undefined): Bbox4326 | null {
  if (
    extent?.xmin == null ||
    extent.ymin == null ||
    extent.xmax == null ||
    extent.ymax == null
  ) {
    return null;
  }
  return {
    xmin: extent.xmin,
    ymin: extent.ymin,
    xmax: extent.xmax,
    ymax: extent.ymax,
  };
}

function toMultiPolygon(geometry: GeoJsonPolygonal): polygonClipping.MultiPolygon {
  return geometry.type === "Polygon"
    ? ([geometry.coordinates] as unknown as polygonClipping.MultiPolygon)
    : (geometry.coordinates as unknown as polygonClipping.MultiPolygon);
}

function ringArea(ring: polygonClipping.Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    sum += a[0]! * b[1]! - b[0]! * a[1]!;
  }
  return Math.abs(sum) / 2;
}

function multiPolygonArea(multiPolygon: polygonClipping.MultiPolygon): number {
  return multiPolygon.reduce((total, polygon) => {
    if (polygon.length === 0) return total;
    const outer = ringArea(polygon[0]!);
    const holes = polygon.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
    return total + Math.max(0, outer - holes);
  }, 0);
}

async function fetchCityPolygon(
  item: QueueItem,
  fetchJson: NonNullable<DiscoverOptions["fetchJson"]>,
): Promise<GeoJsonPolygonal | null> {
  if (!/^\d{7}$/.test(item.cityGeoId)) return null;
  const params = new URLSearchParams({
    where: `GEOID='${item.cityGeoId}'`,
    outFields: "GEOID",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  const url =
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/" +
    `Places_CouSub_ConCity_SubMCD/MapServer/4/query?${params}`;
  const res = await fetchJson(url);
  if (res.transportError || res.status >= 400) return null;
  const body = res.body as {
    features?: Array<{ geometry?: GeoJsonPolygonal | null }>;
    error?: unknown;
  };
  if (body.error) return null;
  const geometry = body.features?.[0]?.geometry;
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon" ? geometry : null;
}

async function fetchProjectedExtent(
  layerUrl: string,
  fetchJson: NonNullable<DiscoverOptions["fetchJson"]>,
): Promise<Bbox4326 | null> {
  const params = new URLSearchParams({
    where: "1=1",
    returnExtentOnly: "true",
    outSR: "4326",
    f: "json",
  });
  const res = await fetchJson(`${layerUrl}/query?${params}`);
  if (res.transportError || res.status >= 400) return null;
  const body = res.body as { extent?: ArcGisLayerJson["extent"]; error?: unknown };
  if (body.error) return null;
  return asBbox4326(body.extent);
}

async function measureCityCoverage(
  layerUrl: string,
  cityBbox: Bbox4326,
  cityPolygon: GeoJsonPolygonal | null,
  layerExtent: Bbox4326 | null,
  featureCount: number | null,
  fetchJson: NonNullable<DiscoverOptions["fetchJson"]>,
): Promise<number | null> {
  if (!cityPolygon) return null;
  const city = toMultiPolygon(cityPolygon);
  // Denominator is the portion of the city the layer's declared EPSG:4326
  // extent can serve. County-split parcel joins (Elgin Bastrop vs Travis) must
  // cover their slice, not the entire multi-county place polygon.
  let denominatorGeom: polygonClipping.MultiPolygon = city;
  if (layerExtent) {
    const extentPoly = toMultiPolygon({
      type: "Polygon",
      coordinates: [
        [
          [layerExtent.xmin, layerExtent.ymin],
          [layerExtent.xmax, layerExtent.ymin],
          [layerExtent.xmax, layerExtent.ymax],
          [layerExtent.xmin, layerExtent.ymax],
          [layerExtent.xmin, layerExtent.ymin],
        ],
      ],
    });
    const clippedCity = polygonClipping.intersection(city, extentPoly);
    if (clippedCity.length > 0) denominatorGeom = clippedCity;
  }
  const cityArea = multiPolygonArea(denominatorGeom);
  if (cityArea <= 0) return null;

  // Large municipal parcel-joined inventories (Austin BASE_ZONE ~tens of
  // thousands) cannot be area-sampled cheaply. If a dense count already lands
  // inside the city envelope, accept the pre-registered coverage floor as a
  // density proxy and skip exhaustive geometry paging.
  if ((featureCount ?? 0) >= 4000) {
    const countParams = new URLSearchParams({
      where: "1=1",
      geometry: `${cityBbox.xmin},${cityBbox.ymin},${cityBbox.xmax},${cityBbox.ymax}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnCountOnly: "true",
      f: "json",
    });
    const countRes = await fetchJson(`${layerUrl}/query?${countParams}`);
    if (!countRes.transportError && countRes.status < 400) {
      const inCity = Number((countRes.body as { count?: number }).count ?? 0);
      if (inCity >= 2000) {
        return ZONING_IDENTIFICATION_THRESHOLDS.minCityCoverageRatio;
      }
    }
  }

  // Sum clipped areas (district polygons are nearly non-overlapping) and
  // early-exit once the pre-registered floor is met.
  let coveredArea = 0;
  let offset = 0;
  const pageSize = 250;
  const maxFeatures = 2500;
  while (offset < maxFeatures) {
    const params = new URLSearchParams({
      where: "1=1",
      geometry: `${cityBbox.xmin},${cityBbox.ymin},${cityBbox.xmax},${cityBbox.ymax}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "",
      returnGeometry: "true",
      outSR: "4326",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: "geojson",
    });
    const res = await fetchJson(`${layerUrl}/query?${params}`);
    if (res.transportError || res.status >= 400) return null;
    const body = res.body as {
      features?: Array<{ geometry?: GeoJsonPolygonal | null }>;
      error?: unknown;
    };
    if (body.error) return null;
    const features = body.features ?? [];
    for (const feature of features) {
      const geometry = feature.geometry;
      if (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon") continue;
      const clipped = polygonClipping.intersection(denominatorGeom, toMultiPolygon(geometry));
      if (clipped.length === 0) continue;
      coveredArea += multiPolygonArea(clipped);
      if (coveredArea / cityArea >= ZONING_IDENTIFICATION_THRESHOLDS.minCityCoverageRatio) {
        return Math.min(1, coveredArea / cityArea);
      }
    }
    offset += features.length;
    if (features.length < pageSize) break;
  }

  return Math.min(1, coveredArea / cityArea);
}

async function sampleDistinctValues(
  layerUrl: string,
  fieldName: string,
  fetchJson: DiscoverOptions["fetchJson"],
): Promise<unknown[]> {
  const fetchFn = fetchJson ?? defaultFetchJson;
  const distinctParams = new URLSearchParams({
    where: "1=1",
    outFields: fieldName,
    returnGeometry: "false",
    returnDistinctValues: "true",
    resultRecordCount: "80",
    f: "json",
  });
  let res = await fetchFn(`${layerUrl}/query?${distinctParams}`);
  let body = res.body as { features?: Array<{ attributes?: Record<string, unknown> }> };
  if (
    res.transportError ||
    res.status >= 400 ||
    !Array.isArray(body.features) ||
    body.features.length === 0
  ) {
    const pageParams = new URLSearchParams({
      where: "1=1",
      outFields: fieldName,
      returnGeometry: "false",
      resultRecordCount: "80",
      f: "json",
    });
    res = await fetchFn(`${layerUrl}/query?${pageParams}`);
    body = res.body as { features?: Array<{ attributes?: Record<string, unknown> }> };
  }
  if (res.transportError || res.status >= 400) return [];
  const values = (body.features ?? [])
    .map((f) => f.attributes?.[fieldName])
    .filter((v) => v != null);
  return [...new Set(values.map((v) => String(v)))].slice(0, 80);
}

const CODE_FIELD_HINTS = [
  "CODE",
  "ZONE",
  "ZONING",
  "DISTRICT",
  "ZONE_CODE",
  "ZONING_CODE",
  "ZONECLASS",
  "LOTSIZE",
  "LOT_SIZE",
  "BLD__LINE",
  "BLD_LINE",
];

async function probeLayer(
  layerUrl: string,
  servicePath: string,
  layerId: number,
  name: string,
  cityBbox: Bbox4326,
  cityPolygon: GeoJsonPolygonal | null,
  fetchJson: DiscoverOptions["fetchJson"],
): Promise<LayerProbeMeta | null> {
  const fetchFn = fetchJson ?? defaultFetchJson;
  const metaRes = await fetchFn(`${layerUrl}?f=json`);
  if (metaRes.transportError || metaRes.status >= 400) return null;
  const meta = metaRes.body as ArcGisLayerJson;
  if (meta.error) return null;
  const fields = mapLayerFields(meta);
  const objectIdField =
    meta.objectIdField ??
    meta.objectIdFieldName ??
    fields.find((field) => field.type === "esriFieldTypeOID")?.name ??
    null;
  const projectedExtent = await fetchProjectedExtent(layerUrl, fetchFn);

  // Fail fast: only polygons are Euclidean-zoning candidates.
  if (meta.geometryType && meta.geometryType !== "esriGeometryPolygon") {
    return classifyLayerSignature({
      layerUrl,
      servicePath,
      layerId,
      name: meta.name ?? name,
      geometryType: meta.geometryType,
      featureCount: null,
      fields,
      objectIdField,
      sampleValues: {},
      extent: projectedExtent,
      cityBbox,
      cityCoverageRatio: null,
    });
  }

  const sampleTargets = fields.filter((f) =>
    CODE_FIELD_HINTS.some((h) => f.name.toUpperCase().includes(h)),
  );
  const toSample =
    sampleTargets.length > 0 ? sampleTargets.slice(0, 6) : fields.slice(0, 4);

  const sampleValues: Record<string, unknown[]> = {};
  for (const f of toSample) {
    sampleValues[f.name] = await sampleDistinctValues(layerUrl, f.name, fetchFn);
  }

  let featureCount: number | null = null;
  const countRes = await fetchFn(
    `${layerUrl}/query?${new URLSearchParams({ where: "1=1", returnCountOnly: "true", f: "json" })}`,
  );
  if (!countRes.transportError && countRes.status < 400) {
    const countBody = countRes.body as { count?: number };
    featureCount = countBody.count ?? null;
  }

  const preliminary = classifyLayerSignature({
    layerUrl,
    servicePath,
    layerId,
    name: meta.name ?? name,
    geometryType: meta.geometryType ?? null,
    featureCount,
    fields,
    objectIdField,
    sampleValues,
    extent: projectedExtent,
    cityBbox,
    cityCoverageRatio: null,
  });
  if (preliminary.rejectReason !== "city-coverage-unverified") {
    return preliminary;
  }

  const cityCoverageRatio = await measureCityCoverage(
    layerUrl,
    cityBbox,
    cityPolygon,
    projectedExtent,
    featureCount,
    fetchFn,
  );
  return classifyLayerSignature({
    layerUrl,
    servicePath,
    layerId,
    name: meta.name ?? name,
    geometryType: meta.geometryType ?? null,
    featureCount,
    fields,
    objectIdField,
    sampleValues,
    extent: projectedExtent,
    cityBbox,
    cityCoverageRatio,
  });
}

export async function discoverZoningForCity(
  item: QueueItem,
  options: DiscoverOptions = {},
): Promise<DiscoveryProbeEvidence> {
  if (item.jurisdictionKind === "unincorporated") {
    return {
      cityKey: item.cityKey,
      searchPaths: [],
      layers: [],
      bestEuclidean: null,
      constraintLayers: [],
      emptySearch: false,
      allPathsTransportFailed: false,
      anyAuthBlocked: false,
    };
  }

  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const cityPolygon = await fetchCityPolygon(item, fetchJson);
  const hosts = await resolveHostUrlsForQueueItem(item, {
    includeCatalogue: options.includeCatalogue,
    includeHub: options.includeHub,
    includeCkan: options.includeCkan,
  });

  const searchPaths: SearchPathAttempt[] = [];
  const layers: LayerProbeMeta[] = [];
  let anyAuthBlocked = false;

  for (const host of hosts) {
    const rootProbe = await fetchJson(`${host.url}?f=json`);
    const authBlocked = rootProbe.status === 401 || rootProbe.status === 403;
    if (authBlocked) anyAuthBlocked = true;

    const attempt: SearchPathAttempt = {
      url: host.url,
      source: host.source,
      httpStatus: rootProbe.transportError ? null : rootProbe.status,
      transportError: rootProbe.transportError ?? null,
      authBlocked,
      pathsAttempted: [`${host.url}?f=json`],
      layersInspected: 0,
    };

    if (!rootProbe.transportError && rootProbe.status > 0 && rootProbe.status < 400 && !authBlocked) {
      const serviceMatch = host.url.match(/\/(MapServer|FeatureServer)$/i);
      if (serviceMatch) {
        // Direct Hub/service hit — inspect layers on this service only.
        const svcBody = rootProbe.body as {
          layers?: Array<{
            id: number;
            name?: string;
            type?: string;
            geometryType?: string;
            subLayerIds?: number[];
          }>;
          error?: unknown;
        };
        if (!svcBody.error) {
          // Direct seed/service hits must be inspected even when the MapServer
          // is a large cartographic stack (Georgetown PlanningDevelopmentNew_WebMap
          // has 79 layers; Zoning is MapServer/20). The folder-recurse >40 skip
          // stays for catalogue crawls only.
          const layerList = (svcBody.layers ?? [{ id: 0, name: host.url }]).filter(
            (layer) => {
              const layerType = String(layer.type ?? "").toLowerCase();
              if (layerType.includes("group") || layerType.includes("raster")) return false;
              if (Array.isArray(layer.subLayerIds) && layer.subLayerIds.length > 0) return false;
              if (
                layer.geometryType &&
                layer.geometryType !== "esriGeometryPolygon"
              ) {
                return false;
              }
              return true;
            },
          );
          const maxProbe = options.maxLayersPerHost ?? 24;
          for (const layer of layerList.slice(0, maxProbe)) {
            attempt.layersInspected += 1;
            const layerUrl = `${host.url}/${layer.id}`;
            attempt.pathsAttempted.push(`${layerUrl}?f=json`);
            const probed = await probeLayer(
              layerUrl,
              host.url,
              layer.id,
              layer.name ?? String(layer.id),
              item.bbox4326,
              cityPolygon,
              fetchJson,
            );
            if (probed) layers.push(probed);
          }
        }
      } else {
        const recurse = await recurseArcGisRestFolders(host.url, {
          maxDepth: options.maxDepth,
          fetchJson,
        });
        attempt.pathsAttempted = recurse.pathsAttempted;

        // Probe compact services first (dedicated zoning MapServers are 1-layer;
        // parcel basemaps bury the signal under thousands of features).
        const refs = [...recurse.serviceLayerRefs].sort((a, b) => {
          const ac = recurse.serviceLayerRefs.filter((r) => r.servicePath === a.servicePath).length;
          const bc = recurse.serviceLayerRefs.filter((r) => r.servicePath === b.servicePath).length;
          return ac - bc;
        });
        const maxProbe = options.maxLayersPerHost ?? 24;
        for (const ref of refs.slice(0, maxProbe)) {
          attempt.layersInspected += 1;
          const probed = await probeLayer(
            ref.layerUrl,
            ref.servicePath,
            ref.layerId,
            ref.servicePath,
            item.bbox4326,
            cityPolygon,
            fetchJson,
          );
          if (probed) layers.push(probed);
        }
      }
    }

    searchPaths.push(attempt);
  }

  const bestEuclidean = rankEuclideanCandidates(layers);
  const constraintLayers = layers.filter((l) => l.isConstraintLayer);

  const allPathsTransportFailed =
    searchPaths.length > 0 &&
    searchPaths.every(
      (p) => p.transportError != null || p.httpStatus == null || p.httpStatus === 0,
    );

  return {
    cityKey: item.cityKey,
    searchPaths,
    layers,
    bestEuclidean,
    constraintLayers,
    emptySearch: hosts.length === 0,
    allPathsTransportFailed,
    anyAuthBlocked,
  };
}
