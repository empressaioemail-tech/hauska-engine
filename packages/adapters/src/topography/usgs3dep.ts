/**
 * USGS 3DEP DEM raster client — bbox-clipped GeoTIFF fetcher for the
 * 2D-site-context sprint (Phase 2D.1).
 *
 * Companion to (but distinct from) the existing `usgs:ned-elevation`
 * federal Adapter in `lib/adapters/src/federal/usgs-ned.ts`. That
 * adapter hits USGS EPQS for a single elevation value at a lat/lng;
 * it is a point query and returns a JSON number. This module fetches
 * the full elevation raster for a bbox so the downstream Phase 2D.1.4
 * contour derivation and Phase 2D.2 hydrology worker have something
 * to compute over.
 *
 * Endpoint
 * --------
 * USGS publishes the 3D Elevation Program (3DEP) raster product as an
 * ArcGIS ImageServer at
 * `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer`.
 * We hit its `/exportImage` operation:
 *
 *   GET .../3DEPElevation/ImageServer/exportImage
 *     ?bbox=<xmin,ymin,xmax,ymax>
 *     &bboxSR=4326                  // input bbox is WGS84 lat/lng
 *     &imageSR=4326                 // output raster is WGS84
 *     &size=<widthPx>,<heightPx>    // we compute from bbox + resolution
 *     &format=tiff                  // GeoTIFF body
 *     &pixelType=F32                // 32-bit float meters above ellipsoid
 *     &interpolation=RSP_BilinearInterpolation
 *     &f=image                      // raw bytes (not the JSON envelope)
 *
 * Public-domain federal dataset; no authentication. Per the canonical
 * spec `40d_cortex_site_context_sprint.md`, this is the federal
 * coverage that subsumes the Utah-only `ugrc:dem` adapter — that one
 * returns 200ft contour-band polygon attributes from a UGRC feature
 * service and is unavailable for non-Utah engagements; 3DEP is
 * nationwide.
 *
 * Scope of this module
 * --------------------
 * Just the network client. The bbox is opaque input; the parcel +
 * upstream-catchment bbox computation belongs to the ingest worker
 * (Phase 2D.1.2). Contour derivation, hillshade, hydrology — all
 * downstream of this module. Keeping the surface narrow means a
 * regression in any one stage cannot cascade through the others, and
 * the live-endpoint surface is the only thing this file is responsible
 * for getting right.
 */

const USGS_3DEP_EXPORT_ENDPOINT =
  "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";

const USGS_3DEP_LABEL = "USGS 3DEP";

/**
 * Hard upper bound on raster dimensions per axis. A 4096×4096 F32
 * GeoTIFF is ~64 MB on the wire — already at the high end of what we
 * want to round-trip through Cloud Run + GCS for a single engagement.
 * The bbox + resolution combinations that actually exceed this cap
 * imply either a misconfiguration (a parcel-scale resolution applied
 * to a catchment-scale bbox) or an unbounded watershed; either way we
 * fail fast rather than silently downsample.
 */
const MAX_PIXELS_PER_AXIS = 4096;

/** Lower bound — anything smaller than 16px is degenerate. */
const MIN_PIXELS_PER_AXIS = 16;

/**
 * Default request budget. Raster export is heavier than a feature
 * query (the ImageServer regenerates the clip on demand against the
 * national mosaic) so 60s is the floor — observed p95 against the
 * live service is ~5-15s for parcel-scale extents, with occasional
 * 30s spikes when the ImageServer is under load.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Meters per degree latitude — a constant in the WGS84 ellipsoid
 * approximation we use to size the request. Longitude scales by
 * cos(latitude); see {@link bboxMetersExtent}.
 */
const METERS_PER_DEG_LAT = 111_320;

/** Bbox in WGS84 (EPSG:4326). Conventional order: west, south, east, north. */
export interface BboxWgs84 {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface FetchUsgs3depDemOptions {
  /**
   * Target raster resolution in meters per pixel. The two practically
   * useful choices against 3DEP are 1 (where lidar-derived 1m DEMs are
   * staged — most of CONUS now) and 10 (the 1/3 arc-second national
   * fallback). The client does not silently round; 0.5 or 30 are
   * accepted as long as the resulting pixel grid stays within
   * {@link MIN_PIXELS_PER_AXIS}-{@link MAX_PIXELS_PER_AXIS} on each
   * axis.
   */
  resolutionMeters: number;
  /**
   * Optional fetch implementation. Defaults to global `fetch`. The
   * test suite injects a stub so unit tests do not touch the live
   * service.
   */
  fetchImpl?: typeof fetch;
  /**
   * Caller-supplied abort. Composed with the timeout-derived abort
   * via `AbortSignal.any` so either source ends the request.
   */
  signal?: AbortSignal;
  /**
   * Override the default {@link DEFAULT_TIMEOUT_MS} budget. Pass `0`
   * to disable the timeout entirely (only the caller signal applies).
   */
  timeoutMs?: number;
}

export interface FetchUsgs3depDemResult {
  /** Raw GeoTIFF bytes returned by the ImageServer. */
  bytes: Uint8Array;
  /** Response `Content-Type` header — expected to be `image/tiff`. */
  contentType: string;
  /** Echo of the requested bbox, for provenance / atom payload. */
  bbox: BboxWgs84;
  /**
   * Echo of the REQUESTED resolution. This is what we asked the
   * ImageServer to resample to; it is NOT necessarily the native
   * resolution of the source raster the mosaic drew from. Retained for
   * backward compatibility; new consumers should read the explicit
   * `resolutionMetersRequested` / `resolutionMetersActual` pair below so
   * the requested-vs-measured distinction is not silently conflated.
   */
  resolutionMeters: number;
  /**
   * The resolution (meters per pixel) the caller asked the ImageServer
   * to resample the clip to. Identical to {@link resolutionMeters}; named
   * explicitly so the coverage-honesty consumer reads "requested" and is
   * never tempted to treat it as measured native resolution.
   */
  resolutionMetersRequested: number;
  /**
   * The ACTUAL native resolution of the source raster behind the clip,
   * when known. Always `null` on the `/exportImage?f=image` path: that
   * operation returns raw resampled GeoTIFF bytes and exposes NO
   * source-raster metadata (neither a native cellsize header nor a
   * source-dataset id) in the response headers or body. The ImageServer
   * resamples the national mosaic to our requested `size`, so the pixel
   * grid we get back reflects our request, not the source cellsize.
   *
   * We deliberately leave this `null` rather than echo the requested
   * value into it: presenting the requested resolution as the actual one
   * would fabricate a coverage claim (structural commitment #2, never an
   * unearned number presented as earned). Resolving the true native
   * resolution requires either the `/exportImage?f=json` envelope's
   * `pixelSizeX/Y` (a separate call) or the ImageServer `identify` /
   * source-raster catalog; both are out of scope for this narrow client
   * and are the honest place to fill this field in later.
   */
  resolutionMetersActual: number | null;
  /** Computed raster width in pixels. */
  widthPx: number;
  /** Computed raster height in pixels. */
  heightPx: number;
  /** The fully-resolved request URL, for provenance / replay. */
  endpoint: string;
  /** ISO8601 timestamp at request initiation. */
  fetchedAt: string;
}

/** Stable error-code taxonomy. The ingest worker switches on `code`. */
export type Usgs3depFetchErrorCode =
  | "invalid-bbox"
  | "invalid-resolution"
  | "raster-too-large"
  | "raster-too-small"
  | "upstream-error"
  | "non-image-response"
  | "timeout"
  | "aborted"
  | "network-error";

export class Usgs3depFetchError extends Error {
  readonly code: Usgs3depFetchErrorCode;
  readonly httpStatus?: number;
  constructor(code: Usgs3depFetchErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "Usgs3depFetchError";
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertValidBbox(bbox: BboxWgs84): void {
  const { westLng, southLat, eastLng, northLat } = bbox;
  if (
    !isFiniteNumber(westLng) ||
    !isFiniteNumber(southLat) ||
    !isFiniteNumber(eastLng) ||
    !isFiniteNumber(northLat)
  ) {
    throw new Usgs3depFetchError(
      "invalid-bbox",
      "bbox corners must be finite numbers",
    );
  }
  if (westLng < -180 || westLng > 180 || eastLng < -180 || eastLng > 180) {
    throw new Usgs3depFetchError(
      "invalid-bbox",
      `bbox longitudes out of WGS84 range: ${westLng}, ${eastLng}`,
    );
  }
  if (southLat < -90 || southLat > 90 || northLat < -90 || northLat > 90) {
    throw new Usgs3depFetchError(
      "invalid-bbox",
      `bbox latitudes out of WGS84 range: ${southLat}, ${northLat}`,
    );
  }
  if (eastLng <= westLng) {
    throw new Usgs3depFetchError(
      "invalid-bbox",
      `eastLng (${eastLng}) must be greater than westLng (${westLng})`,
    );
  }
  if (northLat <= southLat) {
    throw new Usgs3depFetchError(
      "invalid-bbox",
      `northLat (${northLat}) must be greater than southLat (${southLat})`,
    );
  }
}

/**
 * Bbox extent in meters at the bbox's mean latitude. Used to size the
 * pixel grid for an `exportImage` request. Cosine-of-latitude scaling
 * for longitude is sufficient at the parcel-to-catchment extents this
 * client handles — 3DEP usage will never span a meridian where the
 * approximation matters.
 */
export function bboxMetersExtent(bbox: BboxWgs84): {
  widthM: number;
  heightM: number;
} {
  const meanLat = (bbox.southLat + bbox.northLat) / 2;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  const widthM = (bbox.eastLng - bbox.westLng) * METERS_PER_DEG_LAT * cosLat;
  const heightM = (bbox.northLat - bbox.southLat) * METERS_PER_DEG_LAT;
  return { widthM, heightM };
}

/**
 * Compute the (widthPx, heightPx) the ImageServer should produce so
 * the output raster has ~`resolutionMeters` resolution at the bbox's
 * mean latitude. Validates the result against the
 * {@link MIN_PIXELS_PER_AXIS}/{@link MAX_PIXELS_PER_AXIS} bounds and
 * throws a typed error rather than silently clamping.
 */
export function computeRasterSize(
  bbox: BboxWgs84,
  resolutionMeters: number,
): { widthPx: number; heightPx: number } {
  if (!isFiniteNumber(resolutionMeters) || resolutionMeters <= 0) {
    throw new Usgs3depFetchError(
      "invalid-resolution",
      `resolutionMeters must be a positive finite number; got ${resolutionMeters}`,
    );
  }
  const { widthM, heightM } = bboxMetersExtent(bbox);
  const widthPx = Math.ceil(widthM / resolutionMeters);
  const heightPx = Math.ceil(heightM / resolutionMeters);
  if (widthPx < MIN_PIXELS_PER_AXIS || heightPx < MIN_PIXELS_PER_AXIS) {
    throw new Usgs3depFetchError(
      "raster-too-small",
      `computed raster ${widthPx}x${heightPx} below ${MIN_PIXELS_PER_AXIS}px floor; widen bbox or tighten resolution`,
    );
  }
  if (widthPx > MAX_PIXELS_PER_AXIS || heightPx > MAX_PIXELS_PER_AXIS) {
    throw new Usgs3depFetchError(
      "raster-too-large",
      `computed raster ${widthPx}x${heightPx} exceeds ${MAX_PIXELS_PER_AXIS}px cap; narrow bbox or relax resolution`,
    );
  }
  return { widthPx, heightPx };
}

/**
 * Compose the caller's signal with a timeout-derived signal. Either
 * one aborting cancels the in-flight `fetch`. Skipped when the caller
 * disables the timeout (`timeoutMs === 0`) AND provides no signal.
 *
 * `AbortSignal.any` is Node 20+ / modern-browser; the package's
 * minimum Node target via the workspace's typescript + @types/node
 * catalog covers it.
 */
function composeAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs <= 0) {
    return { signal: callerSignal, cleanup: () => undefined };
  }
  const timer = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) {
    return { signal: timer, cleanup: () => undefined };
  }
  // AbortSignal.any composes — either signal firing aborts the result.
  const combined = AbortSignal.any([callerSignal, timer]);
  return { signal: combined, cleanup: () => undefined };
}

/**
 * Fetch a parcel-clipped DEM raster from USGS 3DEP as a GeoTIFF.
 *
 * Returns the raw bytes plus the request provenance (bbox, resolution,
 * computed pixel grid, fully-resolved URL, fetched-at timestamp) so a
 * caller storing the result onto an atom event can carry the
 * reproduction recipe alongside the storage reference.
 *
 * Errors are surfaced as {@link Usgs3depFetchError} with a stable
 * `code`. Network errors, an upstream non-2xx, a JSON error envelope
 * instead of a binary body, a caller-cancelled signal, and a
 * timeout-exceeded signal each map to a distinct code so the ingest
 * worker can decide whether to retry, surface a partial-coverage UI
 * banner, or fail the run.
 */
export async function fetchUsgs3depDem(
  bbox: BboxWgs84,
  opts: FetchUsgs3depDemOptions,
): Promise<FetchUsgs3depDemResult> {
  assertValidBbox(bbox);
  const { widthPx, heightPx } = computeRasterSize(bbox, opts.resolutionMeters);

  const url = new URL(USGS_3DEP_EXPORT_ENDPOINT);
  url.searchParams.set(
    "bbox",
    `${bbox.westLng},${bbox.southLat},${bbox.eastLng},${bbox.northLat}`,
  );
  url.searchParams.set("bboxSR", "4326");
  url.searchParams.set("imageSR", "4326");
  url.searchParams.set("size", `${widthPx},${heightPx}`);
  url.searchParams.set("format", "tiff");
  url.searchParams.set("pixelType", "F32");
  url.searchParams.set("interpolation", "RSP_BilinearInterpolation");
  url.searchParams.set("f", "image");

  const endpoint = url.toString();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { signal, cleanup } = composeAbort(opts.signal, timeoutMs);
  const fetchedAt = new Date().toISOString();

  let res: Response;
  try {
    res = await fetchImpl(endpoint, { signal });
  } catch (err) {
    cleanup();
    // Distinguish caller-cancelled from timeout from generic network
    // error so the ingest worker can retry only the recoverable
    // categories.
    if (err instanceof Error) {
      if (err.name === "TimeoutError") {
        throw new Usgs3depFetchError(
          "timeout",
          `${USGS_3DEP_LABEL} timed out after ${timeoutMs}ms`,
        );
      }
      if (err.name === "AbortError") {
        // Caller-supplied signal fired (not the timeout).
        if (opts.signal?.aborted) {
          throw new Usgs3depFetchError(
            "aborted",
            `${USGS_3DEP_LABEL} request aborted by caller`,
          );
        }
        throw new Usgs3depFetchError(
          "timeout",
          `${USGS_3DEP_LABEL} timed out after ${timeoutMs}ms`,
        );
      }
    }
    throw new Usgs3depFetchError(
      "network-error",
      `${USGS_3DEP_LABEL} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  cleanup();

  if (!res.ok) {
    // Read a short prefix of the body for the error message — the
    // ImageServer sometimes returns HTML for 5xx, sometimes JSON for
    // 4xx; either way a hint helps operator triage. Cap at 256 bytes
    // so a runaway upstream cannot blow up the log line.
    let bodyHint = "";
    try {
      const text = await res.text();
      bodyHint = text.slice(0, 256);
    } catch {
      /* swallow — primary error already captures status */
    }
    throw new Usgs3depFetchError(
      "upstream-error",
      `${USGS_3DEP_LABEL} responded HTTP ${res.status}${bodyHint ? ` — ${bodyHint}` : ""}`,
      res.status,
    );
  }

  // The ImageServer returns `application/json` (with an `error` object)
  // when `f=image` is set but the request was malformed — e.g. a bbox
  // outside coverage, or an invalid `size`. The HTTP status is still
  // 200 in this case, so we have to inspect the content-type.
  const contentType = res.headers.get("content-type") ?? "";
  if (!/image\/(tiff|tif)/i.test(contentType)) {
    let bodyHint = "";
    try {
      const text = await res.text();
      bodyHint = text.slice(0, 256);
    } catch {
      /* swallow */
    }
    throw new Usgs3depFetchError(
      "non-image-response",
      `${USGS_3DEP_LABEL} returned content-type "${contentType}"${bodyHint ? ` — ${bodyHint}` : ""}`,
    );
  }

  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  return {
    bytes,
    contentType,
    bbox,
    resolutionMeters: opts.resolutionMeters,
    // Coverage-honesty pair: we know what we asked for, we do NOT know
    // the source raster's native resolution from this response, so
    // `actual` stays null rather than echoing the request into it.
    resolutionMetersRequested: opts.resolutionMeters,
    resolutionMetersActual: null,
    widthPx,
    heightPx,
    endpoint,
    fetchedAt,
  };
}

/** Re-exported constants for callers that want to surface them in their own UI. */
export {
  USGS_3DEP_EXPORT_ENDPOINT,
  USGS_3DEP_LABEL,
  MAX_PIXELS_PER_AXIS,
  MIN_PIXELS_PER_AXIS,
  DEFAULT_TIMEOUT_MS,
};
