/**
 * Per-city zoning layer discovery orchestrator.
 */

import { resolveHostUrlsForQueueItem } from "./catalogue.js";
import { fetchJsonResilient } from "./fetch-json.js";
import { classifyLayerSignature, rankEuclideanCandidates } from "./layer-signature.js";
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

export type DiscoverOptions = {
  includeCatalogue?: boolean;
  includeHub?: boolean;
  includeCkan?: boolean;
  maxDepth?: number;
  /** Cap layer probes per host after compact-service sort (default 48). */
  maxLayersPerHost?: number;
  fetchJson?: (url: string) => Promise<{ status: number; body: unknown; transportError?: string }>;
};

async function defaultFetchJson(
  url: string,
): Promise<{ status: number; body: unknown; transportError?: string }> {
  return fetchJsonResilient(url);
}

function webMercatorToLonLat(x: number, y: number): { lon: number; lat: number } {
  const lon = (x / 20037508.34) * 180;
  let lat = (y / 20037508.34) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return { lon, lat };
}

function extentToBbox(
  extent?: (ArcGisLayerJson["extent"] & {
    spatialReference?: { wkid?: number; latestWkid?: number };
  }) | null,
): Bbox4326 | null {
  if (
    extent?.xmin == null ||
    extent?.ymin == null ||
    extent?.xmax == null ||
    extent?.ymax == null
  ) {
    return null;
  }
  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;
  const looksMercator =
    wkid === 102100 ||
    wkid === 3857 ||
    Math.abs(extent.xmin) > 180 ||
    Math.abs(extent.xmax) > 180;

  if (looksMercator) {
    const sw = webMercatorToLonLat(extent.xmin, extent.ymin);
    const ne = webMercatorToLonLat(extent.xmax, extent.ymax);
    return { xmin: sw.lon, ymin: sw.lat, xmax: ne.lon, ymax: ne.lat };
  }

  return {
    xmin: extent.xmin,
    ymin: extent.ymin,
    xmax: extent.xmax,
    ymax: extent.ymax,
  };
}

async function sampleDistinctValues(
  layerUrl: string,
  fieldName: string,
  fetchJson: DiscoverOptions["fetchJson"],
): Promise<unknown[]> {
  const fetchFn = fetchJson ?? defaultFetchJson;
  // Prefer a bounded feature page over returnDistinctValues — some AGOL
  // hosts hang or time out on distinct queries.
  const params = new URLSearchParams({
    where: "1=1",
    outFields: fieldName,
    returnGeometry: "false",
    resultRecordCount: "80",
    f: "json",
  });
  const res = await fetchFn(`${layerUrl}/query?${params}`);
  if (res.transportError || res.status >= 400) return [];
  const body = res.body as { features?: Array<{ attributes?: Record<string, unknown> }> };
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
  fetchJson: DiscoverOptions["fetchJson"],
): Promise<LayerProbeMeta | null> {
  const fetchFn = fetchJson ?? defaultFetchJson;
  const metaRes = await fetchFn(`${layerUrl}?f=json`);
  if (metaRes.transportError || metaRes.status >= 400) return null;
  const meta = metaRes.body as ArcGisLayerJson;
  if (meta.error) return null;

  // Fail fast: only polygons are Euclidean-zoning candidates.
  if (meta.geometryType && meta.geometryType !== "esriGeometryPolygon") {
    return classifyLayerSignature({
      layerUrl,
      servicePath,
      layerId,
      name: meta.name ?? name,
      geometryType: meta.geometryType,
      featureCount: null,
      fields: mapLayerFields(meta),
      sampleValues: {},
      extent: extentToBbox(meta.extent),
      cityBbox,
    });
  }

  const fields = mapLayerFields(meta);
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

  return classifyLayerSignature({
    layerUrl,
    servicePath,
    layerId,
    name: meta.name ?? name,
    geometryType: meta.geometryType ?? null,
    featureCount,
    fields,
    sampleValues,
    extent: extentToBbox(meta.extent),
    cityBbox,
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
          layers?: Array<{ id: number; name?: string }>;
          error?: unknown;
        };
        if (!svcBody.error) {
          const layerList = svcBody.layers ?? [{ id: 0, name: host.url }];
          for (const layer of layerList) {
            attempt.layersInspected += 1;
            const layerUrl = `${host.url}/${layer.id}`;
            attempt.pathsAttempted.push(`${layerUrl}?f=json`);
            const probed = await probeLayer(
              layerUrl,
              host.url,
              layer.id,
              layer.name ?? String(layer.id),
              item.bbox4326,
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
        const maxProbe = options.maxLayersPerHost ?? 48;
        for (const ref of refs.slice(0, maxProbe)) {
          attempt.layersInspected += 1;
          const probed = await probeLayer(
            ref.layerUrl,
            ref.servicePath,
            ref.layerId,
            ref.servicePath,
            item.bbox4326,
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
