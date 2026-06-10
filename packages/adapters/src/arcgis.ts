/**
 * Thin helper around ArcGIS REST `query` endpoints. Most of the
 * adapters in this sprint hit ArcGIS Feature/Map services because that
 * is what UGRC, INSIDE Idaho, Grand County GIS, Lemhi County GIS, and
 * TCEQ all expose. The shape is consistent enough that one helper
 * covers the common case ("hit a layer with a point and get the
 * intersecting feature attributes back").
 *
 * The helper deliberately:
 *   - takes an injected `fetch` so unit tests can stub the network;
 *   - validates the JSON envelope and surfaces ArcGIS's in-band error
 *     object as a typed throw rather than letting it round-trip as a
 *     "successful" empty response;
 *   - normalizes the resulting feature list to a small subset
 *     (`attributes` + `geometry`) so adapters don't depend on the full
 *     ArcGIS schema;
 *   - retries transient upstream failures (HTTP 408/429/5xx, network
 *     resets) via {@link fetchWithRetry} so a single ArcGIS hiccup
 *     doesn't paint the row red.
 *
 * It does NOT handle paginated responses (the `exceededTransferLimit`
 * flag) — every adapter in this sprint queries by point intersection,
 * which returns at most a handful of rows.
 */

import { AdapterRunError } from "./types";
import { fetchWithRetry } from "./retry";

/**
 * Identifying User-Agent the helper sends on every request. See the
 * docstring above the `headers:` block in `arcgisPointQuery` for why
 * — Apache front doors on several of our upstream hosts 406 requests
 * with a missing/unrecognized UA.
 */
const ARC_GIS_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

export interface ArcGisPointQueryInput {
  serviceUrl: string;
  latitude: number;
  longitude: number;
  /** Comma-separated attribute list ("*" for everything). */
  outFields?: string;
  /** When true, include feature geometries in the response. */
  returnGeometry?: boolean;
  /** Spatial reference of the input point. Defaults to WGS84 (4326). */
  inSpatialReference?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Friendly upstream label used in retry / failure messages — e.g.
   * "FEMA NFHL" or "Grand County, UT GIS parcels". Defaults to
   * "ArcGIS" so legacy callers keep the historical wording.
   */
  upstreamLabel?: string;
}

export interface ArcGisFeature {
  attributes: Record<string, unknown>;
  geometry?: Record<string, unknown> | null;
}

export interface ArcGisQueryResult {
  features: ArcGisFeature[];
  /** Effective field types as ArcGIS reports them; useful for debugging. */
  fields?: ReadonlyArray<{ name: string; type: string }>;
  /** Raw envelope for debugging — adapters should not depend on this. */
  raw: unknown;
}

/**
 * Query an ArcGIS service layer for features intersecting the given
 * point. Throws an {@link AdapterRunError} on any deterministic upstream
 * failure (HTTP non-2xx after retries, ArcGIS error envelope, malformed
 * JSON).
 */
export async function arcgisPointQuery(
  input: ArcGisPointQueryInput,
): Promise<ArcGisQueryResult> {
  const sr = input.inSpatialReference ?? 4326;
  const label = input.upstreamLabel ?? "ArcGIS";
  const url = new URL(`${input.serviceUrl.replace(/\/$/, "")}/query`);
  url.searchParams.set("f", "json");
  url.searchParams.set(
    "geometry",
    JSON.stringify({
      x: input.longitude,
      y: input.latitude,
      spatialReference: { wkid: sr },
    }),
  );
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", String(sr));
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", input.outFields ?? "*");
  url.searchParams.set(
    "returnGeometry",
    input.returnGeometry ? "true" : "false",
  );

  const {
    response: res,
    attempts,
    bodyExcerpt,
    throwExcerpt,
  } = await fetchWithRetry(
    url.toString(),
    {
      signal: input.signal,
      // Several upstream ArcGIS hosts (Grand County, Lemhi County, the
      // FCC NBM tile server, EJScreen broker) sit behind Apache front
      // doors that 406 requests without a recognized `User-Agent` and
      // a permissive `Accept`. Send both explicitly so Node's fetch
      // doesn't trigger that gate in production.
      headers: {
        "User-Agent": ARC_GIS_USER_AGENT,
        Accept: "application/json, */*;q=0.1",
      },
    },
    {
      fetchImpl: input.fetchImpl,
      signal: input.signal,
      upstreamLabel: label,
      // QA-22 reopen follow-on — let `fetchWithRetry` collapse a
      // fetch-throw (DNS / TLS / ECONNREFUSED / ECONNRESET) into the
      // `!res.ok` branch below so the failure pill can name the
      // actual network failure mode. cortex-api-00020-85n showed
      // Grand County requests failing with "fetch failed" + no
      // body — operator can't tell DNS-from-firewall apart without
      // this.
      captureThrowsAsResult: true,
    },
  );
  if (!res.ok) {
    if (throwExcerpt) {
      // The request never got a response back — DNS resolution, TLS
      // handshake, connection establishment, or stream read failed
      // before the upstream's HTTP layer answered. `throwExcerpt`
      // names the underlying network failure mode (e.g. `ENOTFOUND
      // getaddrinfo gis.grandcountyutah.net`) so the operator can
      // choose the mitigation off the pill alone.
      throw new AdapterRunError(
        "network-error",
        `${label} did not get a response after ${attempts} attempt${attempts === 1 ? "" : "s"}. Network error: ${throwExcerpt}. Use Force refresh to retry.`,
      );
    }
    // QA-22 reopen: append the upstream body excerpt so the layer-
    // failure pill carries the ArcGIS error envelope's `message`
    // (or a Cloudflare interstitial / maintenance-window banner /
    // empty body) — operators don't need Cloud Run access to choose
    // between schema-drift and transient-blip diagnoses.
    const suffix = bodyExcerpt ? ` Upstream response: ${bodyExcerpt}` : "";
    throw new AdapterRunError(
      "upstream-error",
      `${label} responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}.${suffix} Use Force refresh to retry.`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new AdapterRunError(
      "parse-error",
      `${label} response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!json || typeof json !== "object") {
    throw new AdapterRunError(
      "parse-error",
      `${label} response was not a JSON object`,
    );
  }
  // ArcGIS surfaces in-band errors as `{ error: { code, message } }`
  // with HTTP 200. Translate to an upstream-error so the adapter
  // fails deterministically.
  const errorEnv = (json as { error?: { code?: number; message?: string } })
    .error;
  if (errorEnv) {
    throw new AdapterRunError(
      "upstream-error",
      `${label} error ${errorEnv.code ?? "?"}: ${errorEnv.message ?? "unknown"}`,
    );
  }

  const featuresRaw = (json as { features?: unknown }).features;
  if (!Array.isArray(featuresRaw)) {
    throw new AdapterRunError(
      "parse-error",
      `${label} response missing \`features\` array`,
    );
  }
  const features: ArcGisFeature[] = featuresRaw.map((f) => {
    const feat = f as { attributes?: unknown; geometry?: unknown };
    return {
      attributes:
        feat.attributes && typeof feat.attributes === "object"
          ? (feat.attributes as Record<string, unknown>)
          : {},
      geometry:
        feat.geometry && typeof feat.geometry === "object"
          ? (feat.geometry as Record<string, unknown>)
          : null,
    };
  });
  const fieldsRaw = (json as { fields?: unknown }).fields;
  const fields = Array.isArray(fieldsRaw)
    ? (fieldsRaw as ReadonlyArray<{ name: string; type: string }>)
    : undefined;
  return { features, fields, raw: json };
}
