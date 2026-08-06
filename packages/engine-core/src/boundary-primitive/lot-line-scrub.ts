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
  isConvexPlanarRing,
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
  protectedIndices?: ReadonlySet<number>,
): PlanarPoint[] {
  let pts = points.map((p) => ({ x: p.x, y: p.y }));
  let changed = true;
  let guard = 0;
  while (changed && pts.length > 3 && guard++ < 48) {
    changed = false;
    const n = pts.length;
    const targetArea = Math.abs(signedArea(pts));
    for (let v = 0; v < n; v++) {
      if (protectedIndices?.has(v)) continue;
      const prev = pts[(v + n - 1) % n]!;
      const cur = pts[v]!;
      const next = pts[(v + 1) % n]!;
      const turn = turnAngleDeg(prev, cur, next);
      if (turn >= maxTurnDeg) continue;

      const candidate = pts.filter((_, i) => i !== v);
      if (candidate.length < 3) continue;
      const nextArea = Math.abs(signedArea(candidate));
      /** Micro-jogs (<5°) may shed slightly more area when collapsing digitization noise. */
      const areaFloor = turn < 5 ? 0.99 : 0.998;
      if (nextArea < targetArea * areaFloor) continue;
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
  protectedIndices?: ReadonlySet<number>,
): PlanarPoint[] {
  let pts = points.map((p) => ({ x: p.x, y: p.y }));
  let changed = true;
  let guard = 0;
  while (changed && pts.length > 3 && guard++ < 48) {
    changed = false;
    const n = pts.length;
    const targetArea = Math.abs(signedArea(pts));
    for (let v = 0; v < n; v++) {
      if (protectedIndices?.has(v)) continue;
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

function protectedVertexIndices(
  open: Array<[number, number]>,
  snapTolM: number,
  sharedKeys: ReadonlySet<string>,
  minCornerTurnDeg = 5,
): Set<number> {
  const frame = projectRing(open);
  if (!frame) return new Set();
  const out = new Set<number>();
  const pts = frame.points;
  open.forEach(([lng, lat], i) => {
    const key = vertexKey(lng, lat, snapTolM);
    if (!sharedKeys.has(key)) return;
    const a = pts[(i + pts.length - 1) % pts.length]!;
    const b = pts[i]!;
    const c = pts[(i + 1) % pts.length]!;
    const turn = turnAngleDeg(a, b, c);
    /** Shared micro-jogs (<5°) may collapse — they corrupt inset, not real lot corners. */
    if (turn >= minCornerTurnDeg) out.add(i);
  });
  return out;
}

function sharedLotLineVertexKeys(
  rings: ReadonlyMap<string, Ring>,
  snapTolM: number,
): Set<string> {
  const counts = new Map<string, number>();
  for (const ring of rings.values()) {
    for (const [lng, lat] of openRing(ring)) {
      const key = vertexKey(lng, lat, snapTolM);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const shared = new Set<string>();
  for (const [key, n] of counts) {
    if (n >= 2) shared.add(key);
  }
  return shared;
}

/** Scrub one parcel ring: dedupe, drop collinear + sub-survey vertices. */
export function scrubLotLineRing(
  ring: Ring,
  options?: LotLineScrubOptions & { protectedVertexKeys?: ReadonlySet<string> },
): Ring {
  const opts = { ...DEFAULT_SCRUB, ...options };
  const open = openRing(ring);
  if (open.length < 3) return ring;

  const frame = projectRing(open);
  if (!frame) return ring;

  const protectedIdx = options?.protectedVertexKeys
    ? protectedVertexIndices(open, opts.snapTolM, options.protectedVertexKeys)
    : undefined;

  let pts = frame.points.map((p) => ({ x: p.x, y: p.y }));
  pts = removeCollinearVertices(pts, opts.collinearTolM);
  pts = removeNearlyStraightVertices(pts, 12, protectedIdx);
  pts = removeShortEdgeVertices(pts, opts.minEdgeM, protectedIdx);
  pts = removeNearlyStraightVertices(pts, 12, protectedIdx);
  pts = removeCollinearVertices(pts, opts.collinearTolM);
  pts = removeNearlyStraightVertices(pts, 8, protectedIdx);
  pts = removeShortEdgeVertices(pts, opts.minEdgeM, protectedIdx);

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
    const snapped: Array<[number, number]> = open.map(([lng, lat]) => {
      const key = vertexKey(lng, lat, opts.snapTolM);
      const canonicalPt = canonical.get(key);
      return canonicalPt ?? ([lng, lat] as [number, number]);
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
  const opts = { ...DEFAULT_SCRUB, ...options };
  const preRings = new Map<string, Ring>(
    entries.map((e) => [e.propId, e.ring]),
  );
  const preSnapped = snapSharedLotLineVertices(preRings, options);
  const sharedKeys = sharedLotLineVertexKeys(preSnapped, opts.snapTolM);

  const scrubbed = new Map<string, Ring>();
  for (const entry of entries) {
    scrubbed.set(
      entry.propId,
      scrubLotLineRing(preSnapped.get(entry.propId) ?? entry.ring, {
        ...options,
        protectedVertexKeys: sharedKeys,
      }),
    );
  }
  const snapped = snapSharedLotLineVertices(scrubbed, options);

  return entries.map((entry) => ({
    ...entry,
    ring: snapped.get(entry.propId) ?? entry.ring,
  }));
}

/**
 * True when open ring has 4–6 edges, every significant corner is near-orthogonal,
 * AND the ring is CONVEX (all significant turns same-signed — no reflex/notch
 * vertex). The convexity requirement is load-bearing for R29: a genuinely
 * irregular lot (L-shape / notched hexagon hugging an interior alley, e.g.
 * 48021:34121) can scrub down to 6 all-orthogonal corners yet carry ONE reflex
 * vertex. Its buildable envelope is legitimately non-convex. Classifying such a
 * lot as near-rect wrongly fired the R5 convexity assertion in verify-mechanical
 * and false-rejected a valid inset. Requiring turn-sign consistency here keeps
 * the R5 corruption gate on truly near-rect (convex) downtown lots — the six
 * clean Block-13 parcels stay classified near-rect — while letting genuinely
 * irregular lots fall through to the plain validity gate (geometryCorrectnessGate).
 */
export function isNearRectangularParcelRing(ring: Ring): boolean {
  const open = openRing(ring);
  if (open.length < 4 || open.length > 6) return false;

  const frame = projectRing(open);
  if (!frame) return false;

  let turnSign = 0;
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
    // Near-rect requires a single consistent turn direction. A reflex corner
    // (opposite sign) is a genuine notch — the lot is irregular, not near-rect.
    const cross = v1x * v2y - v1y * v2x;
    const s = Math.sign(cross);
    if (s === 0) continue;
    if (turnSign === 0) turnSign = s;
    else if (s !== turnSign) return false;
  }
  return turnSign !== 0;
}

/** WDLL F3 / R5 invariant: near-rect parcel → convex inset matching topology. */
export function nearRectEnvelopeCheck(
  parcelRing: Ring,
  insetRing: Ring | null,
  maxInsetVerts?: number,
): NearRectEnvelopeCheck {
  const reasons: string[] = [];
  const parcelEdgeCount = openRing(parcelRing).length;
  const insetVertexCount = insetRing ? openRing(insetRing).length : 0;
  const vertCap = maxInsetVerts ?? parcelEdgeCount + 1;

  if (!insetRing) reasons.push("inset ring is null");
  if (!isNearRectangularParcelRing(parcelRing)) {
    reasons.push("parcel ring is not near-rectangular");
  }
  if (insetRing && insetVertexCount > vertCap) {
    reasons.push(
      `inset vertex count ${insetVertexCount} exceeds ${vertCap} (parcel has ${parcelEdgeCount} edges)`,
    );
  }
  if (insetRing) {
    const insetFrame = projectRing(insetRing);
    if (insetFrame && !isConvexPlanarRing(insetFrame.points)) {
      reasons.push("inset ring is not convex");
    }
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
  propIdField = "prop_id",
): Promise<BcadParcelFetchResult[]> {
  if (!propIds.length) return [];
  const idStrings = propIds.map((id) => String(id).trim()).filter(Boolean);
  if (!idStrings.length) return [];
  const allNumeric = idStrings.every(
    (id) => /^-?\d+(\.\d+)?$/.test(id) && Number.isFinite(Number(id)),
  );
  const whereClause = allNumeric
    ? `${propIdField} IN (${idStrings.map((id) => Number(id)).join(",")})`
    : `${propIdField} IN (${idStrings.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`;

  const url = new URL(`${queryUrl.replace(/\/$/, "")}/query`);
  url.searchParams.set("where", whereClause);
  url.searchParams.set("outFields", propIdField);
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("outSR", "4326");

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`BCAD parcel fetch failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    features?: Array<{
      properties?: Record<string, unknown>;
      geometry?: { type?: string; coordinates?: number[][][] };
    }>;
  };

  const propIdFieldLower = propIdField.toLowerCase();
  const out: BcadParcelFetchResult[] = [];
  for (const feature of body.features ?? []) {
    // ArcGIS echoes the layer's actual field casing in the geojson properties
    // ("prop_id" on BCAD/Guadalupe, "Prop_ID" on Caldwell CAD, "pid" on Ellis
    // Halff) even though the where/outFields clauses are case-insensitive —
    // match the key case-insensitively or cased-field counties drop every ring.
    const props = feature.properties ?? {};
    const propIdKey = Object.keys(props).find(
      (k) => k.toLowerCase() === propIdFieldLower,
    );
    const propId = String((propIdKey ? props[propIdKey] : undefined) ?? "");
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
