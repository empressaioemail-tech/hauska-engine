/**
 * ArcGIS easement feature fetch for CAD easement-rest counties.
 */

import {
  geoJsonRingFromEsri,
  ringToEasementGeometry,
  type EasementFeatureInput,
} from "./geo.js";

const USER_AGENT =
  "hauska-engine/1.0 (+https://cortex.empressa.io; utility-easement-writer)";

export interface FetchCadEasementsOptions {
  serviceRootUrl: string;
  layerIds: readonly number[];
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
  statusFields?: readonly string[];
  docNumFields?: readonly string[];
  fetchImpl?: typeof fetch;
}

export async function fetchCadEasementFeatures(
  options: FetchCadEasementsOptions,
): Promise<EasementFeatureInput[]> {
  const {
    serviceRootUrl,
    layerIds,
    westLng,
    southLat,
    eastLng,
    northLat,
    statusFields = ["Status", "TYPE", "EasementType", "LABEL_DESC"],
    docNumFields = ["DOC_NUM", "Recordation_Num", "DOCNUM"],
    fetchImpl = fetch,
  } = options;

  const envelope = {
    xmin: westLng,
    ymin: southLat,
    xmax: eastLng,
    ymax: northLat,
    spatialReference: { wkid: 4326 },
  };

  const features: EasementFeatureInput[] = [];

  for (const layerId of layerIds) {
    const layerUrl = `${serviceRootUrl.replace(/\/$/, "")}/${layerId}`;
    let offset = 0;
    const pageSize = 1000;

    for (;;) {
      const url = new URL(`${layerUrl}/query`);
      url.searchParams.set("f", "json");
      url.searchParams.set("where", "1=1");
      url.searchParams.set("geometry", JSON.stringify(envelope));
      url.searchParams.set("geometryType", "esriGeometryEnvelope");
      url.searchParams.set("inSR", "4326");
      url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
      url.searchParams.set(
        "outFields",
        [...statusFields, ...docNumFields, "OBJECTID", "FID"].join(","),
      );
      url.searchParams.set("returnGeometry", "true");
      url.searchParams.set("outSR", "4326");
      url.searchParams.set("resultRecordCount", String(pageSize));
      url.searchParams.set("resultOffset", String(offset));

      const res = await fetchImpl(url.toString(), {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`CAD easement layer ${layerId} HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        error?: { message?: string };
        features?: Array<{
          attributes?: Record<string, unknown>;
          geometry?: { rings?: number[][][]; paths?: number[][][] };
        }>;
      };
      if (body.error) {
        throw new Error(
          `CAD easement layer ${layerId} ArcGIS error: ${body.error.message ?? "unknown"}`,
        );
      }

      const page = body.features ?? [];
      for (const raw of page) {
        const attrs = raw.attributes ?? {};
        const ring = geoJsonRingFromEsri(raw.geometry);
        if (!ring) continue;
        const geometry = ringToEasementGeometry(ring);
        if (!geometry) continue;

        let status: string | null = null;
        for (const field of statusFields) {
          const val = attrs[field];
          if (val != null && String(val).trim()) {
            status = String(val);
            break;
          }
        }

        let docNum: string | null = null;
        for (const field of docNumFields) {
          const val = attrs[field];
          if (val != null && String(val).trim()) {
            docNum = String(val);
            break;
          }
        }

        const objectId =
          attrs.OBJECTID ?? attrs.FID ?? attrs.objectid ?? features.length;
        features.push({
          easementId: `${layerId}:${objectId}`,
          geometry,
          status,
          docNum,
        });
      }

      if (page.length < pageSize) break;
      offset += page.length;
    }
  }

  return features;
}
