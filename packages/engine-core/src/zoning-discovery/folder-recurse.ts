/**
 * BFS folder recursion for ArcGIS REST services roots.
 * Records every path attempted plus layer metadata stubs.
 */

import type { LayerFieldMeta } from "./types.js";

export type ArcGisFolderJson = {
  folders?: string[];
  services?: Array<{ name: string; type: string }>;
  currentVersion?: number;
  error?: { code?: number; message?: string };
};

export type ArcGisLayerJson = {
  id?: number;
  name?: string;
  geometryType?: string;
  fields?: Array<{ name: string; type: string; alias?: string }>;
  extent?: {
    xmin?: number;
    ymin?: number;
    xmax?: number;
    ymax?: number;
  };
  error?: { code?: number; message?: string };
};

export type FolderRecurseOptions = {
  maxDepth?: number;
  fetchJson: (url: string) => Promise<{ status: number; body: unknown; transportError?: string }>;
};

export type ServiceLayerRef = {
  servicePath: string;
  serviceType: "MapServer" | "FeatureServer";
  layerId: number;
  layerUrl: string;
};

export type FolderRecurseResult = {
  pathsAttempted: string[];
  serviceLayerRefs: ServiceLayerRef[];
};

function normalizeRestRoot(rootUrl: string): string {
  return rootUrl.replace(/\/+$/, "");
}

function joinRestPath(root: string, ...parts: string[]): string {
  const base = normalizeRestRoot(root);
  const tail = parts.filter(Boolean).join("/");
  return tail ? `${base}/${tail}` : base;
}

export async function recurseArcGisRestFolders(
  rootUrl: string,
  options: FolderRecurseOptions,
): Promise<FolderRecurseResult> {
  const maxDepth = options.maxDepth ?? 4;
  const root = normalizeRestRoot(rootUrl);
  const pathsAttempted: string[] = [];
  const serviceLayerRefs: ServiceLayerRef[] = [];
  const queue: Array<{ folderPath: string; depth: number }> = [{ folderPath: "", depth: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const { folderPath, depth } = queue.shift()!;
    const pathKey = folderPath || "/";
    if (seen.has(pathKey)) continue;
    seen.add(pathKey);

    const folderUrl = folderPath
      ? `${joinRestPath(root, folderPath)}?f=json`
      : `${root}?f=json`;
    pathsAttempted.push(folderUrl);

    const res = await options.fetchJson(folderUrl);
    if (res.transportError || res.status >= 400) continue;

    const body = res.body as ArcGisFolderJson;
    if (body.error) continue;

    for (const svc of body.services ?? []) {
      if (svc.type !== "MapServer" && svc.type !== "FeatureServer") continue;
      // ArcGIS often returns names already prefixed with the folder
      // (e.g. folder WGS84 lists service name "WGS84/Zoning_WGS84").
      // Doubling the folder creates WGS84/WGS84/... ghosts that Z1-class miss.
      const servicePath = svc.name.includes("/")
        ? svc.name
        : folderPath
          ? `${folderPath}/${svc.name}`
          : svc.name;
      const serviceUrl = joinRestPath(root, servicePath, svc.type);
      pathsAttempted.push(`${serviceUrl}?f=json`);

      const svcRes = await options.fetchJson(`${serviceUrl}?f=json`);
      if (svcRes.transportError || svcRes.status >= 400) continue;

      const svcBody = svcRes.body as ArcGisFolderJson & {
        layers?: Array<{
          id: number;
          name?: string;
          type?: string;
          geometryType?: string;
          subLayerIds?: number[];
        }>;
      };
      if (svcBody.error) continue;

      const listed = svcBody.layers ?? [{ id: 0, name: svc.name }];
      // Multi-scale cartographic MapServers (Deer Park City_Limits_Zoning_WGS84)
      // expose hundreds of duplicate scale-dependent Feature Layers. Real zoning
      // data services are small (typically 1–15 layers). Structural cap — not a
      // name regex.
      if (listed.length > 40) {
        pathsAttempted.push(`${serviceUrl}?f=json#skipped-large-layer-stack:${listed.length}`);
        continue;
      }

      for (const layer of listed) {
        // Skip group/raster shells — only Feature Layers can be Euclidean polygons.
        const layerType = (layer.type ?? "").toLowerCase();
        if (layerType.includes("group") || layerType.includes("raster")) continue;
        if (layer.subLayerIds && layer.subLayerIds.length > 0) continue;
        if (
          layer.geometryType &&
          layer.geometryType !== "esriGeometryPolygon"
        ) {
          continue;
        }
        serviceLayerRefs.push({
          servicePath,
          serviceType: svc.type as "MapServer" | "FeatureServer",
          layerId: layer.id,
          layerUrl: `${serviceUrl}/${layer.id}`,
        });
      }
    }

    if (depth >= maxDepth) continue;
    for (const folder of body.folders ?? []) {
      const childPath = folderPath ? `${folderPath}/${folder}` : folder;
      queue.push({ folderPath: childPath, depth: depth + 1 });
    }
  }

  return { pathsAttempted, serviceLayerRefs };
}

export function mapLayerFields(layerJson: ArcGisLayerJson): LayerFieldMeta[] {
  return (layerJson.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    alias: f.alias,
  }));
}

/**
 * Pure BFS over in-memory folder fixtures (unit tests).
 */
export function recurseArcGisRestFoldersFromFixtures(
  rootUrl: string,
  fixtureMap: Record<string, ArcGisFolderJson>,
  maxDepth = 4,
): FolderRecurseResult {
  const root = normalizeRestRoot(rootUrl);
  const pathsAttempted: string[] = [];
  const serviceLayerRefs: ServiceLayerRef[] = [];
  const queue: Array<{ folderPath: string; depth: number }> = [{ folderPath: "", depth: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const { folderPath, depth } = queue.shift()!;
    const pathKey = folderPath || "/";
    if (seen.has(pathKey)) continue;
    seen.add(pathKey);

    const folderUrl = folderPath
      ? joinRestPath(root, folderPath)
      : root;
    pathsAttempted.push(`${folderUrl}?f=json`);

    const body = fixtureMap[folderPath || "/"] ?? fixtureMap[folderUrl] ?? { folders: [], services: [] };

    for (const svc of body.services ?? []) {
      if (svc.type !== "MapServer" && svc.type !== "FeatureServer") continue;
      const servicePath = svc.name.includes("/")
        ? svc.name
        : folderPath
          ? `${folderPath}/${svc.name}`
          : svc.name;
      const serviceUrl = joinRestPath(root, servicePath, svc.type);
      pathsAttempted.push(`${serviceUrl}?f=json`);

      const svcKey = servicePath;
      const svcBody = fixtureMap[svcKey] ?? { layers: [{ id: 0, name: svc.name }] };
      for (const layer of (svcBody as { layers?: Array<{ id: number; name?: string }> }).layers ?? [
        { id: 0, name: svc.name },
      ]) {
        serviceLayerRefs.push({
          servicePath,
          serviceType: svc.type as "MapServer" | "FeatureServer",
          layerId: layer.id,
          layerUrl: `${serviceUrl}/${layer.id}`,
        });
      }
    }

    if (depth >= maxDepth) continue;
    for (const folder of body.folders ?? []) {
      const childPath = folderPath ? `${folderPath}/${folder}` : folder;
      queue.push({ folderPath: childPath, depth: depth + 1 });
    }
  }

  return { pathsAttempted, serviceLayerRefs };
}
