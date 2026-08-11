/**
 * Fetch Texas RRC surface wells for a county bbox from the Harris County mirror layer.
 */

export const TEXAS_RRC_WELLS_LAYER =
  "https://www.gis.hctx.net/arcgishcpid/rest/services/TXRRC/Wells/MapServer/0";

const ARC_GIS_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

export interface RrcWellFeature {
  surfaceId: number;
  symnum: number;
  api: string;
  wellId: string;
  lng: number;
  lat: number;
  reliab: string | null;
}

export interface CountyWellFetchResult {
  wells: ReadonlyArray<RrcWellFeature>;
  truncated: boolean;
  fieldNames: ReadonlyArray<string>;
}

export interface BBoxInput {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

function parseWellFeature(raw: unknown): RrcWellFeature | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as {
    properties?: Record<string, unknown>;
    geometry?: { coordinates?: unknown };
  };
  const attrs = f.properties ?? {};
  let lng = Number(attrs.GIS_LONG83 ?? attrs.LONG83 ?? attrs.LONG27);
  let lat = Number(attrs.GIS_LAT83 ?? attrs.LAT83 ?? attrs.LAT27);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    const coords = f.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      lng = Number(coords[0]);
      lat = Number(coords[1]);
    }
  }
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const surfaceId = Number(
    attrs.SURFACE_ID ?? attrs.UNIQID ?? attrs.OBJECTID ?? 0,
  );
  const wellId = String(attrs.WELLID ?? attrs.GIS_WELL_NUMBER ?? "");
  return {
    surfaceId,
    symnum: Number(attrs.SYMNUM ?? 0),
    api: String(attrs.API ?? ""),
    wellId,
    lng,
    lat,
    reliab: attrs.RELIAB != null ? String(attrs.RELIAB) : null,
  };
}

export async function fetchRrcWellsForBBox(
  bbox: BBoxInput,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<CountyWellFetchResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const pageSize = 2000;
  const maxPages = 8;
  const merged: RrcWellFeature[] = [];
  let truncated = false;
  let fieldNames: string[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const url = new URL(`${TEXAS_RRC_WELLS_LAYER}/query`);
    url.searchParams.set("f", "geojson");
    url.searchParams.set(
      "geometry",
      JSON.stringify({
        xmin: bbox.westLng,
        ymin: bbox.southLat,
        xmax: bbox.eastLng,
        ymax: bbox.northLat,
        spatialReference: { wkid: 4326 },
      }),
    );
    url.searchParams.set("geometryType", "esriGeometryEnvelope");
    url.searchParams.set("inSR", "4326");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", String(pageSize));

    const res = await fetchImpl(url.toString(), {
      signal: opts?.signal,
      headers: {
        "User-Agent": ARC_GIS_USER_AGENT,
        Accept: "application/json, */*;q=0.1",
      },
    });
    if (!res.ok) break;

    const json = (await res.json()) as {
      features?: unknown[];
      exceededTransferLimit?: boolean;
      fields?: Array<{ name: string }>;
    };
    if (Array.isArray(json.fields)) {
      fieldNames = json.fields.map((f) => f.name);
    }
    for (const feat of json.features ?? []) {
      const parsed = parseWellFeature(feat);
      if (parsed) merged.push(parsed);
    }
    const exceeded = Boolean(json.exceededTransferLimit);
    if (!exceeded || (json.features?.length ?? 0) < pageSize) {
      return { wells: merged, truncated, fieldNames };
    }
    if (page === maxPages - 1) truncated = true;
  }

  return { wells: merged, truncated, fieldNames };
}
