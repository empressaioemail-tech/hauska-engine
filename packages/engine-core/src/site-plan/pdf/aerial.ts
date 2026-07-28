import type { BboxWgs84 } from "../../site-topography/index.js";
import type { LocalPoint } from "../ring-geometry.js";
import type { PageXY } from "./layout.js";

/**
 * Aerial-context page (sheet 3) support: server-side Esri World Imagery
 * static export for the parcel's padded bbox, plus the Web-Mercator
 * (EPSG:3857) projection math that keeps the vector overlay aligned with
 * the imagery pixels.
 *
 * ALIGNMENT CONTRACT: the imagery is requested with `bboxSR=3857&imageSR=3857`,
 * so the returned PNG is a linear map of the requested mercator bbox. The
 * overlay projects every local-ENU model point through the EXACT inverse of
 * the forward projection that built `ringLocal` (`projectWgs84ToLocalEnu`,
 * equirectangular about the DEM bbox — both directions linear, exactly
 * invertible), then WGS84 -> 3857 -> the same linear page mapping the image
 * occupies. Any point therefore lands on the same page position as the
 * imagery pixel for that ground coordinate.
 *
 * HONESTY: the imagery is the provider's current published basemap; its
 * capture date is NOT verified and it is NOT surveyed data. The page must
 * carry `AERIAL_NOT_A_SURVEY_LINE` and `AERIAL_IMAGERY_ATTRIBUTION` verbatim.
 */

/** Public, key-free Esri World Imagery static-export endpoint. */
export const ESRI_WORLD_IMAGERY_EXPORT_BASE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export";

/** Required provider attribution, drawn verbatim in the sheet fine print. */
export const AERIAL_IMAGERY_ATTRIBUTION =
  "Source: Esri World Imagery - Esri, Maxar, Earthstar Geographics, and the GIS User Community.";

/** Honesty line drawn verbatim on the aerial page. */
export const AERIAL_NOT_A_SURVEY_LINE =
  "Aerial imagery for visual context only - not a survey. Imagery is the provider's current published basemap; its capture date is not verified.";

/** Honest note drawn when the imagery fetch fails or times out. */
export const AERIAL_UNAVAILABLE_NOTE = "aerial imagery unavailable (fetch failed)";

/** Fraction of the parcel's mercator extent added on EACH side for context. */
export const AERIAL_CONTEXT_PAD_FRACTION = 0.4;

/** Bounded imagery fetch: the whole export must survive a dead endpoint. */
export const AERIAL_FETCH_TIMEOUT_MS = 8_000;

const WEB_MERCATOR_RADIUS = 6378137;
const METERS_PER_DEGREE_LAT = 111_320; // must match parcel-terrain/mesh.ts

export interface MercatorXY {
  x: number;
  y: number;
}

export interface MercatorBbox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

/** WGS84 lng/lat -> Web Mercator (EPSG:3857) metres. */
export function lngLatToWebMercator(lng: number, lat: number): MercatorXY {
  const x = (WEB_MERCATOR_RADIUS * lng * Math.PI) / 180;
  const y = WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return { x, y };
}

/**
 * EXACT inverse of `projectWgs84ToLocalEnu` (parcel-terrain/mesh.ts):
 * origin = bbox SW corner, equirectangular with one cos(meanLat) longitude
 * correction. Both directions are linear, so the roundtrip is lossless —
 * this is what lets the aerial overlay re-derive WGS84 from the model's
 * local-ENU geometry without carrying a second copy of the ring.
 */
export function localEnuToWgs84(point: LocalPoint, bbox: BboxWgs84): { lng: number; lat: number } {
  const meanLatDegrees = (bbox.southLat + bbox.northLat) / 2;
  const cosLat = Math.cos((meanLatDegrees * Math.PI) / 180);
  return {
    lng: bbox.westLng + point.x / (METERS_PER_DEGREE_LAT * cosLat),
    lat: bbox.southLat + point.y / METERS_PER_DEGREE_LAT,
  };
}

/** local-ENU model point -> Web Mercator, via the exact ENU inverse. */
export function localEnuToWebMercator(point: LocalPoint, bbox: BboxWgs84): MercatorXY {
  const { lng, lat } = localEnuToWgs84(point, bbox);
  return lngLatToWebMercator(lng, lat);
}

/**
 * Mercator bbox for the imagery request: the parcel ring's mercator extent,
 * padded by `padFraction` of the larger span on each side (context), then
 * expanded symmetrically on the deficient axis to match `aspect`
 * (width/height) exactly — so the returned PNG maps onto the page image box
 * without distortion and the overlay math stays a single linear transform.
 */
export function computeAerialMercatorBbox(
  ringLocal: LocalPoint[],
  bbox: BboxWgs84,
  aspect: number,
  padFraction: number = AERIAL_CONTEXT_PAD_FRACTION,
): MercatorBbox {
  if (ringLocal.length < 3) {
    throw new Error(`Aerial bbox requires a parcel ring (>=3 points); got ${ringLocal.length}.`);
  }
  if (!(aspect > 0) || !Number.isFinite(aspect)) {
    throw new Error(`Aerial bbox requires a positive finite aspect; got ${aspect}.`);
  }
  const merc = ringLocal.map((p) => localEnuToWebMercator(p, bbox));
  const xs = merc.map((p) => p.x);
  const ys = merc.map((p) => p.y);
  let xmin = Math.min(...xs);
  let xmax = Math.max(...xs);
  let ymin = Math.min(...ys);
  let ymax = Math.max(...ys);
  const span = Math.max(xmax - xmin, ymax - ymin, 1);
  const pad = span * padFraction;
  xmin -= pad;
  xmax += pad;
  ymin -= pad;
  ymax += pad;

  // Expand (never shrink) the deficient axis to hit the target aspect.
  const width = xmax - xmin;
  const height = ymax - ymin;
  if (width / height < aspect) {
    const grow = (height * aspect - width) / 2;
    xmin -= grow;
    xmax += grow;
  } else if (width / height > aspect) {
    const grow = (width / aspect - height) / 2;
    ymin -= grow;
    ymax += grow;
  }
  return { xmin, ymin, xmax, ymax };
}

/**
 * Longest image dimension requested from the export endpoint (px). The
 * World_Imagery export operation advertises maxImageWidth 4096 but returns
 * HTTP 500 ("Error: bytes") above ~1300px at parcel zoom (live-probed
 * 2026-07-28: 1300 ok, 1350+ fails); 1024 leaves a comfortable margin and
 * is ample for a Letter-sheet embed.
 */
export const AERIAL_IMAGE_MAX_PX = 1024;

export function aerialImagePixelSize(mercBbox: MercatorBbox): { width: number; height: number } {
  const aspect = (mercBbox.xmax - mercBbox.xmin) / (mercBbox.ymax - mercBbox.ymin);
  if (aspect >= 1) {
    return { width: AERIAL_IMAGE_MAX_PX, height: Math.max(1, Math.round(AERIAL_IMAGE_MAX_PX / aspect)) };
  }
  return { width: Math.max(1, Math.round(AERIAL_IMAGE_MAX_PX * aspect)), height: AERIAL_IMAGE_MAX_PX };
}

/** Builds the keyless Esri World Imagery export URL for the mercator bbox. */
export function buildAerialExportUrl(mercBbox: MercatorBbox, size: { width: number; height: number }): string {
  const params = new URLSearchParams({
    bbox: `${mercBbox.xmin},${mercBbox.ymin},${mercBbox.xmax},${mercBbox.ymax}`,
    bboxSR: "3857",
    imageSR: "3857",
    size: `${size.width},${size.height}`,
    format: "png",
    f: "image",
  });
  return `${ESRI_WORLD_IMAGERY_EXPORT_BASE}?${params.toString()}`;
}

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The one aerial overlay transform: local-ENU model point -> page points,
 * via exact-ENU-inverse -> WGS84 -> EPSG:3857 -> the linear mapping of the
 * requested mercator bbox onto the page image rect. Mercator y increases
 * north and PDF page y increases up, so the mapping is direct (no flip).
 */
export function makeAerialOverlayTransform(
  mercBbox: MercatorBbox,
  imageRect: PageRect,
  bbox: BboxWgs84,
): (point: LocalPoint) => PageXY {
  const sx = imageRect.width / (mercBbox.xmax - mercBbox.xmin);
  const sy = imageRect.height / (mercBbox.ymax - mercBbox.ymin);
  return (point: LocalPoint): PageXY => {
    const merc = localEnuToWebMercator(point, bbox);
    return {
      x: imageRect.x + (merc.x - mercBbox.xmin) * sx,
      y: imageRect.y + (merc.y - mercBbox.ymin) * sy,
    };
  };
}

/**
 * Page points per GROUND metre at the bbox's centre latitude (mercator plane
 * distances are inflated by 1/cos(lat); divide back out for the scale bar).
 */
export function aerialPagePointsPerGroundMeter(mercBbox: MercatorBbox, imageRect: PageRect, bbox: BboxWgs84): number {
  const sx = imageRect.width / (mercBbox.xmax - mercBbox.xmin);
  const meanLatDegrees = (bbox.southLat + bbox.northLat) / 2;
  const cosLat = Math.cos((meanLatDegrees * Math.PI) / 180);
  return sx / cosLat;
}

export type AerialImageFetcher = (url: string, init: { signal: AbortSignal }) => Promise<Uint8Array>;

export type AerialImageryResult =
  | { ok: true; bytes: Uint8Array; url: string }
  | { ok: false; reason: string; url: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

const defaultAerialImageFetcher: AerialImageFetcher = async (url, init) => {
  const res = await fetch(url, { signal: init.signal, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from imagery endpoint`);
  }
  return new Uint8Array(await res.arrayBuffer());
};

/**
 * Bounded, never-throwing imagery fetch. ANY failure (timeout, network
 * refusal, HTTP error, or a non-PNG body — the Esri endpoint can return a
 * JSON error document with status 200) degrades to an honest `ok: false`
 * result; the PDF export must never fail because the aerial fetch did.
 */
export async function fetchAerialImagery(
  url: string,
  options: { fetchImage?: AerialImageFetcher; timeoutMs?: number } = {},
): Promise<AerialImageryResult> {
  const timeoutMs = options.timeoutMs ?? AERIAL_FETCH_TIMEOUT_MS;
  const fetchImage = options.fetchImage ?? defaultAerialImageFetcher;
  try {
    const bytes = await fetchImage(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!looksLikePng(bytes)) {
      return { ok: false, reason: "imagery endpoint returned a non-PNG body", url };
    }
    return { ok: true, bytes, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message, url };
  }
}
