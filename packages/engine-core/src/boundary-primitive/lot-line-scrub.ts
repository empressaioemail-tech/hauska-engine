/**
 * F3 lot-line geometry scrub (BDC downtown drill STEP 3).
 *
 * TxGIO / stratmap rings often carry sub-survey micro-edges and mis-joined
 * shared-lot-line vertices. Those corrupt per-edge inward normals and
 * property-line tags upstream of inset, producing jagged envelopes or null
 * rings (geometry.ts:181 / :199-200). Scrub from authoritative county parcel
 * geometry, snap shared edges inside a cohort, then rebuild boundary primitive.
 */

import {
  openRing,
  projectRing,
  SURVEY_NOISE_THRESHOLD_M,
  type Ring,
} from "../depth-warm/geometry.js";
import {
  ringSelfIntersects,
  signedArea,
  type PlanarPoint,
} from "../geometry/polygon-inset.js";
import type { ParcelIndexEntry } from "./types.js";

export const BASTROP_BCAD_PARCELS_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/Cadastral_BP/Bastrop_County_Parcels/FeatureServer/0";

export interface LotLineScrubOptions {
  /** Drop edges shorter than this (metres). Default SURVEY_NOISE_THRESHOLD_M (1.5). */
  minEdgeM?: number;
  /** Cross-product tolerance for collinear vertex removal (local metres). */
  collinearTolM?: number;
  /** Shared lot-line vertex snap tolerance (metres). */
  snapTolM?: number;
}

export interface NearRectEnvelopeCheck {
  pass: boolean;
  reasons: string[];
  parcelEdgeCount: number;
  insetVertexCount: number;
}

const DEFAULT_SCRUB: Required<LotLineScrubOptions> = {
  minEdgeM: SURVEY_NOISE_THRESHOLD_M,
  collinearTolM: 0.05,
  snapTolM: 0.45,
};

function closeRing(open: Array<[number, number]>): Ring {
  if (open.length === 0) return [];
  const first = open[0]!;
  const last = open[open.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) {
    return open.map(([lng, lat]) => [lng, lat] as [number, number]);
  }
  return [...open.map(([lng, lat]) => [lng, lat] as [number, number]), [first[0], first[1]]];
}

function unprojectPoint(p: PlanarPoint, frame: NonNullable<ReturnType<typeof projectRing>>): [number, number] {
  return [
    frame.originLng + p.x / frame.mPerDegLng,
    frame.originLat + p.y / frame.mPerDegLat,
  ];
}

function turnAngleDeg(a: PlanarPoint, b: PlanarPoint, c: PlanarPoint): number {
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (l1 < 1e-9 || l2 < 1e-9) return 0;
  const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI);
}

/** Drop vertices where the path is nearly straight (digitization / shared-edge jog). */
export function removeNearlyStraightVertices(
  points: PlanarPoint[],
  maxTurnDeg = 12,
): PlanarPoint[] {
  let pts = points.map((p) => ({ x: p.x, y: p.y }));
  let changed = true;
  let guard = 0;
  while (changed && pts.length > 3 && guard++ < 48) {
    changed = false;
    const n = pts.length;
    const targetArea = Math.abs(signedArea(pts));
    for (let v = 0; v < n; v++) {
      const prev = pts[(v + n - 1) % n]!;
      const cur = pts[v]!;
      const next = pts[(v + 1) % n]!;
      const turn = turnAngleDeg(prev, cur, next);
      if (turn >= maxTurnDeg) continue;

      const candidate = pts.filter((_, i) => i !== v);
      if (candidate.length < 3) continue;
      const nextArea = Math.abs(signedArea(candidate));
      if (nextArea < targetArea * 0.998) continue;
      if (ringSelfIntersects(candidate)) continue;

      pts = candidate;
      changed = true;
      break;
    }
  }
  return pts;
}

function removeCollinearVertices(points: PlanarPoint[], tol: number): PlanarPoint[] {
  const n = points.length;
  if (n < 3) return points.map((p) => ({ x: p.x, y: p.y }));
  const out: PlanarPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 1) % n]!;
    const b = points[i]!;
    const c = points[(i + 1) % n]!;
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > tol) {
      out.push({ x: b.x, y: b.y });
    }
  }
  return out.length >= 3 ? out : points.map((p) => ({ x: p.x, y: p.y }));
}

/**
 * Remove vertices incident to sub-survey edges without carving real area.
 * Fails closed on self-intersection.
 */
export function removeShortEdgeVertices(
  points: PlanarPoint[],
  minEdgeM: number,
): PlanarPoint[] {
  let pts = points.map((p) => ({ x: p.x, y: p.y }));
  let changed = true;
  let guard = 0;
  while (changed && pts.length > 3 && guard++ < 48) {
    changed = false;
    const n = pts.length;
    const targetArea = Math.abs(signedArea(pts));
    for (let v = 0; v < n; v++) {
      const prev = pts[(v + n - 1) % n]!;
      const cur = pts[v]!;
      const next = pts[(v + 1) % n]!;
      const lenIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const lenOut = Math.hypot(next.x - cur.x, next.y - cur.y);
      if (lenIn >= minEdgeM && lenOut >= minEdgeM) continue;

      const candidate = pts.filter((_, i) => i !== v);
      if (candidate.length < 3) continue;
      const nextArea = Math.abs(signedArea(candidate));
      if (nextArea < targetArea * 0.998) continue;
      if (ringSelfIntersects(candidate)) continue;

      pts = candidate;
      changed = true;
      break;
    }
  }
  return pts;
}

/** Scrub one parcel ring: dedupe, drop collinear + sub-survey vertices. */
export function scrubLotLineRing(
  ring: Ring,
  options?: LotLineScrubOptions,
): Ring {
  const opts = { ...DEFAULT_SCRUB, ...options };
  const open = openRing(ring);
  if (open.length < 3) return ring;

  const frame = projectRing(open);
  if (!frame) return ring;

  let pts = frame.points.map((p) => ({ x: p.x, y: p.y }));
  pts = removeCollinearVertices(pts, opts.collinearTolM);
  pts = removeNearlyStraightVertices(pts);
  pts = removeShortEdgeVertices(pts, opts.minEdgeM);
  pts = removeNearlyStraightVertices(pts);
  pts = removeCollinearVertices(pts, opts.collinearTolM);

  if (pts.length < 3 || ringSelfIntersects(pts)) return ring;

  const scrubbedOpen = pts.map((p) => unprojectPoint(p, frame));
  return closeRing(scrubbedOpen);
}

function snapCluster(lngLats: Array<[number, number]>, snapTolM: number): [number, number] {
  const frame = projectRing(lngLats);
  if (!frame) {
    const lng = lngLats.reduce((s, p) => s + p[0], 0) / lngLats.length;
    const lat = lngLats.reduce((s, p) => s + p[1], 0) / lngLats.length;
    return [lng, lat];
  }
  const cx = frame.points.reduce((s, p) => s + p.x, 0) / frame.points.length;
  const cy = frame.points.reduce((s, p) => s + p.y, 0) / frame.points.length;
  return unprojectPoint({ x: cx, y: cy }, frame);
}

function vertexKey(lng: number, lat: number, snapTolM: number): string {
  const scale = Math.max(1, Math.round(1 / snapTolM));
  return `${Math.round(lng * scale * 1e5)},${Math.round(lat * scale * 1e5)}`;
}

/**
 * Snap shared lot-line vertices across a cohort so adjacent parcels agree
 * on coordinates before adjacency + boundary emit.
 */
export function snapSharedLotLineVertices(
  rings: ReadonlyMap<string, Ring>,
  options?: LotLineScrubOptions,
): Map<string, Ring> {
  const opts = { ...DEFAULT_SCRUB, ...options };
  const clusters = new Map<string, Array<[number, number]>>();

  for (const ring of rings.values()) {
    for (const [lng, lat] of openRing(ring)) {
      const key = vertexKey(lng, lat, opts.snapTolM);
      const arr = clusters.get(key) ?? [];
      arr.push([lng, lat]);
      clusters.set(key, arr);
    }
  }

  const canonical = new Map<string, [number, number]>();
  for (const [key, pts] of clusters) {
    if (pts.length < 2) continue;
    canonical.set(key, snapCluster(pts, opts.snapTolM));
  }

  const out = new Map<string, Ring>();
  for (const [propId, ring] of rings) {
    const open = openRing(ring);
    const snapped = open.map(([lng, lat]) => {
      const key = vertexKey(lng, lat, opts.snapTolM);
      return canonical.get(key) ?? [lng, lat];
    });
    out.set(propId, closeRing(snapped));
  }
  return out;
}

/** Scrub + snap a manifest cohort; returns updated ParcelIndexEntry rows. */
export function scrubParcelCohortEntries(
  entries: ReadonlyArray<ParcelIndexEntry>,
  options?: LotLineScrubOptions,
): ParcelIndexEntry[] {
  const scrubbed = new Map<string, Ring>();
  for (const entry of entries) {
    scrubbed.set(entry.propId, scrubLotLineRing(entry.ring, options));
  }
  const snapped = snapSharedLotLineVertices(scrubbed, options);

  return entries.map((entry) => ({
    ...entry,
    ring: snapped.get(entry.propId) ?? entry.ring,
  }));
}

/** True when open ring has 4–5 edges and bearings are near-orthogonal. */
export function isNearRectangularParcelRing(ring: Ring): boolean {
  const open = openRing(ring);
  if (open.length < 4 || open.length > 6) return false;

  const frame = projectRing(open);
  if (!frame) return false;

  for (let i = 0; i < frame.points.length; i++) {
    const a = frame.points[(i + frame.points.length - 1) % frame.points.length]!;
    const b = frame.points[i]!;
    const c = frame.points[(i + 1) % frame.points.length]!;
    const turn = turnAngleDeg(a, b, c);
    if (turn < 12) continue;
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 0.3 || l2 < 0.3) continue;
    if (turn < 75 || turn > 105) return false;
  }
  return true;
}

/** WDLL F3 invariant: near-rect parcel → near-rect envelope (≤ maxInsetVerts). */
export function nearRectEnvelopeCheck(
  parcelRing: Ring,
  insetRing: Ring | null,
  maxInsetVerts = 6,
): NearRectEnvelopeCheck {
  const reasons: string[] = [];
  const parcelEdgeCount = openRing(parcelRing).length;
  const insetVertexCount = insetRing ? openRing(insetRing).length : 0;

  if (!insetRing) reasons.push("inset ring is null");
  if (!isNearRectangularParcelRing(parcelRing)) {
    reasons.push("parcel ring is not near-rectangular");
  }
  if (insetRing && insetVertexCount > maxInsetVerts) {
    reasons.push(
      `inset vertex count ${insetVertexCount} exceeds ${maxInsetVerts}`,
    );
  }

  return {
    pass: reasons.length === 0,
    reasons,
    parcelEdgeCount,
    insetVertexCount,
  };
}

export interface BcadParcelFetchResult {
  propId: string;
  ring: Ring;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

/** Fetch authoritative BCAD parcel rings for a prop_id list (public endpoint). */
export async function fetchBcadParcelRings(
  propIds: ReadonlyArray<string | number>,
  fetchImpl: typeof fetch = fetch,
  queryUrl = BASTROP_BCAD_PARCELS_URL,
): Promise<BcadParcelFetchResult[]> {
  if (!propIds.length) return [];
  const idList = propIds.map((id) => Number(id)).filter(Number.isFinite);
  if (!idList.length) return [];

  const url = new URL(`${queryUrl.replace(/\/$/, "")}/query`);
  url.searchParams.set("where", `prop_id IN (${idList.join(",")})`);
  url.searchParams.set("outFields", "prop_id");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("outSR", "4326");

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`BCAD parcel fetch failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    features?: Array<{
      properties?: { prop_id?: number };
      geometry?: { type?: string; coordinates?: number[][][] };
    }>;
  };

  const out: BcadParcelFetchResult[] = [];
  for (const feature of body.features ?? []) {
    const propId = String(feature.properties?.prop_id ?? "");
    const coords = feature.geometry?.coordinates?.[0];
    if (!propId || !Array.isArray(coords) || coords.length < 4) continue;

    const ring = coords.map(
      (c) => [c[0]!, c[1]!] as [number, number],
    ) as Ring;
    const lngs = coords.map((c) => c[0]!);
    const lats = coords.map((c) => c[1]!);
    out.push({
      propId,
      ring,
      westLng: Math.min(...lngs),
      southLat: Math.min(...lats),
      eastLng: Math.max(...lngs),
      northLat: Math.max(...lats),
    });
  }
  return out;
}
