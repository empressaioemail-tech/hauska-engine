/**
 * Warden check 5 — envelopeSanity (files-never-fixes: READ ONLY).
 *
 * Per-parcel geometry sanity over the stored buildable-envelope geojson vs
 * the txgio_parcel cadastral ring. Flags when:
 *
 *   (a) an envelope polygon is not contained in the parcel ring,
 *   (b) envelope area / parcel area ratio is outside the district-regime
 *       bounds (SF-1 typical 0.30–0.95; degenerate slivers <0.05; full-lot
 *       mis-inset ≥0.995),
 *   (c) inset edges are not roughly parallel to a corresponding lot edge
 *       (angle tolerance default 12°).
 *
 * Honest declines (warmVerifyDecline*, outcome no-buildable-area /
 * provisional-front-edge, or no buildable envelope on record) produce NO
 * flag — the Warden reports shape anomalies only when a drawable envelope
 * was actually stored.
 */
import {
  openRing,
  projectRing,
  ringAreaSqFt,
  type Ring,
} from "../depth-warm/geometry.js";
import {
  pointInOrOnPolygon,
  ringHasSelfTouch,
  ringSelfIntersects,
  signedArea,
  type PlanarPoint,
} from "../geometry/polygon-inset.js";
import type { WardenFindingEvent } from "./types.js";

export type EnvelopeSanityAnomalyKind =
  | "envelope-outside-parcel"
  | "area-ratio-sliver"
  | "area-ratio-full-lot"
  | "area-ratio-below-regime"
  | "area-ratio-above-regime"
  | "inset-edge-not-parallel"
  | "envelope-self-intersects"
  | "missing-envelope-geometry";

export interface AreaRatioBounds {
  readonly minRatio: number;
  readonly maxRatio: number;
  readonly sliverThreshold: number;
  readonly fullLotThreshold: number;
}

export interface EnvelopeSanityParcelInput {
  readonly parcelNodeId: string;
  readonly district: string | null;
  readonly envelopeBody: Record<string, unknown> | null;
  readonly parcelRing: Ring | null;
}

export interface EnvelopeSanityOptions {
  readonly parallelAngleToleranceDeg?: number;
  readonly containmentToleranceM?: number;
  readonly minEdgeLengthM?: number;
  readonly areaRatioBoundsForDistrict?: (district: string | null) => AreaRatioBounds;
}

const DEFAULT_PARALLEL_TOL_DEG = 12;
const DEFAULT_CONTAINMENT_TOL_M = 0.12;
const DEFAULT_MIN_EDGE_LEN_M = 1.0;

const DEFAULT_SF_RESIDENTIAL_BOUNDS: AreaRatioBounds = {
  minRatio: 0.3,
  maxRatio: 0.95,
  sliverThreshold: 0.05,
  fullLotThreshold: 0.995,
};

const DEFAULT_COMMERCIAL_BOUNDS: AreaRatioBounds = {
  minRatio: 0.15,
  maxRatio: 0.98,
  sliverThreshold: 0.05,
  fullLotThreshold: 0.995,
};

export function defaultAreaRatioBoundsForDistrict(district: string | null): AreaRatioBounds {
  const token = district?.split(/\s+/)[0]?.trim().toUpperCase() ?? "";
  if (/^SF-/.test(token) || token === "D" || token === "PUD") {
    return DEFAULT_SF_RESIDENTIAL_BOUNDS;
  }
  if (/^(GC|LI|HI|MU|CBD|P-)/.test(token)) {
    return DEFAULT_COMMERCIAL_BOUNDS;
  }
  return DEFAULT_SF_RESIDENTIAL_BOUNDS;
}

/** Extract the first polygon exterior ring from a depth-warm geojson payload. */
export function extractEnvelopeRingFromGeojson(geojson: unknown): Ring | null {
  const coords = (geojson as { features?: Array<{ geometry?: { coordinates?: unknown } }> })
    ?.features?.[0]?.geometry?.coordinates?.[0];
  if (!Array.isArray(coords) || coords.length < 3) return null;
  const ring: Ring = [];
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    ring.push([lng, lat]);
  }
  return ring.length >= 3 ? ring : null;
}

export function extractEnvelopeRingFromAtomBody(body: Record<string, unknown> | null): Ring | null {
  if (!body) return null;
  return extractEnvelopeRingFromGeojson(body.geojson);
}

/** True when the latest envelope atom is an honest decline/absence — not a shape to grade. */
export function isHonestEnvelopeDecline(body: Record<string, unknown> | null): boolean {
  if (!body) return true;
  if (typeof body.warmVerifyDecline === "string" && body.warmVerifyDecline.trim().length > 0) {
    return true;
  }
  if (typeof body.warmVerifyDeclineCode === "string" && body.warmVerifyDeclineCode.trim().length > 0) {
    return true;
  }
  const outcome = body.outcome as { kind?: string } | undefined;
  if (outcome?.kind === "no-buildable-area" || outcome?.kind === "provisional-front-edge") {
    return true;
  }
  if (outcome?.kind !== "buildable" && !body.geojson) return true;
  return false;
}

function edgeUnitVector(a: PlanarPoint, b: PlanarPoint, minLenM: number): PlanarPoint | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < minLenM) return null;
  return { x: dx / len, y: dy / len };
}

function edgesParallel(u1: PlanarPoint, u2: PlanarPoint, tolDeg: number): boolean {
  const dot = Math.abs(u1.x * u2.x + u1.y * u2.y);
  return dot >= Math.cos((tolDeg * Math.PI) / 180);
}

function projectRingInFrame(ring: Ring, frame: NonNullable<ReturnType<typeof projectRing>>): PlanarPoint[] | null {
  const open = openRing(ring);
  if (!open.length) return null;
  return open.map(([lng, lat]) => ({
    x: (lng - frame.originLng) * frame.mPerDegLng,
    y: (lat - frame.originLat) * frame.mPerDegLat,
  }));
}

export function checkInsetEdgesParallelToLot(
  parcelPoints: readonly PlanarPoint[],
  envelopePoints: readonly PlanarPoint[],
  options?: { readonly parallelAngleToleranceDeg?: number; readonly minEdgeLengthM?: number },
): { readonly pass: boolean; readonly misalignedEdgeIndexes: readonly number[] } {
  const tolDeg = options?.parallelAngleToleranceDeg ?? DEFAULT_PARALLEL_TOL_DEG;
  const minLen = options?.minEdgeLengthM ?? DEFAULT_MIN_EDGE_LEN_M;
  const lotUnits: PlanarPoint[] = [];
  for (let i = 0; i < parcelPoints.length; i++) {
    const u = edgeUnitVector(parcelPoints[i]!, parcelPoints[(i + 1) % parcelPoints.length]!, minLen);
    if (u) lotUnits.push(u);
  }
  if (lotUnits.length === 0) return { pass: true, misalignedEdgeIndexes: [] };

  const misaligned: number[] = [];
  for (let i = 0; i < envelopePoints.length; i++) {
    const envU = edgeUnitVector(envelopePoints[i]!, envelopePoints[(i + 1) % envelopePoints.length]!, minLen);
    if (!envU) continue;
    const parallel = lotUnits.some((lotU) => edgesParallel(envU, lotU, tolDeg));
    if (!parallel) misaligned.push(i);
  }
  return { pass: misaligned.length === 0, misalignedEdgeIndexes: misaligned };
}

export interface EnvelopeSanityClassification {
  readonly anomalies: readonly EnvelopeSanityAnomalyKind[];
  readonly evidence: Record<string, unknown>;
}

/**
 * Pure classifier — unit-testable, no I/O. Returns null when the parcel is
 * skipped (no parcel ring, honest envelope decline, or nothing to grade).
 */
export function classifyEnvelopeSanityForParcel(
  input: EnvelopeSanityParcelInput,
  options?: EnvelopeSanityOptions,
): EnvelopeSanityClassification | null {
  if (!input.parcelRing) return null;
  if (isHonestEnvelopeDecline(input.envelopeBody)) return null;

  const envelopeRing = extractEnvelopeRingFromAtomBody(input.envelopeBody);
  if (!envelopeRing) {
    const outcome = input.envelopeBody?.outcome as { kind?: string } | undefined;
    if (outcome?.kind === "buildable") {
      return {
        anomalies: ["missing-envelope-geometry"],
        evidence: { note: "buildable outcome without geojson ring" },
      };
    }
    return null;
  }

  const parcelProj = projectRing(input.parcelRing);
  if (!parcelProj) return null;
  const envelopeProj = projectRingInFrame(envelopeRing, parcelProj);
  if (!envelopeProj || envelopeProj.length < 3) {
    return {
      anomalies: ["missing-envelope-geometry"],
      evidence: { note: "envelope geojson is not a valid polygon" },
    };
  }

  const anomalies: EnvelopeSanityAnomalyKind[] = [];
  const evidence: Record<string, unknown> = {
    district: input.district,
    parcelVertexCount: parcelProj.points.length,
    envelopeVertexCount: envelopeProj.length,
  };

  const containmentTol = options?.containmentToleranceM ?? DEFAULT_CONTAINMENT_TOL_M;
  let outsideVertexCount = 0;
  for (const p of envelopeProj) {
    if (!pointInOrOnPolygon(p, parcelProj.points, containmentTol)) outsideVertexCount++;
  }
  if (outsideVertexCount > 0) {
    anomalies.push("envelope-outside-parcel");
    evidence.outsideVertexCount = outsideVertexCount;
  }

  if (ringSelfIntersects(envelopeProj)) {
    anomalies.push("envelope-self-intersects");
  } else if (ringHasSelfTouch(envelopeProj)) {
    anomalies.push("envelope-self-intersects");
    evidence.selfTouch = true;
  }

  const parcelAreaSqFt = ringAreaSqFt(input.parcelRing);
  const envelopeAreaSqFt = ringAreaSqFt(envelopeRing);
  const areaRatio = parcelAreaSqFt > 0 ? envelopeAreaSqFt / parcelAreaSqFt : 0;
  evidence.parcelAreaSqFt = parcelAreaSqFt;
  evidence.envelopeAreaSqFt = envelopeAreaSqFt;
  evidence.areaRatio = areaRatio;

  const bounds = (options?.areaRatioBoundsForDistrict ?? defaultAreaRatioBoundsForDistrict)(
    input.district,
  );
  evidence.areaRatioBounds = bounds;

  if (areaRatio < bounds.sliverThreshold) {
    anomalies.push("area-ratio-sliver");
  } else if (areaRatio >= bounds.fullLotThreshold) {
    anomalies.push("area-ratio-full-lot");
  } else if (areaRatio < bounds.minRatio) {
    anomalies.push("area-ratio-below-regime");
  } else if (areaRatio > bounds.maxRatio) {
    anomalies.push("area-ratio-above-regime");
  }

  const parallel = checkInsetEdgesParallelToLot(parcelProj.points, envelopeProj, {
    parallelAngleToleranceDeg: options?.parallelAngleToleranceDeg,
    minEdgeLengthM: options?.minEdgeLengthM,
  });
  if (!parallel.pass) {
    anomalies.push("inset-edge-not-parallel");
    evidence.misalignedEdgeIndexes = parallel.misalignedEdgeIndexes;
    evidence.parallelAngleToleranceDeg = options?.parallelAngleToleranceDeg ?? DEFAULT_PARALLEL_TOL_DEG;
  }

  if (anomalies.length === 0) return null;
  evidence.anomalies = anomalies;
  if (signedArea(envelopeProj) <= 0) evidence.envelopeOrientation = "cw-or-zero";
  return { anomalies, evidence };
}

/**
 * Classifies a cohort sample — one flag finding per parcel with any anomaly.
 */
export function classifyEnvelopeSanity(params: {
  readonly sweepId: string;
  readonly fips: string;
  readonly rowId: string;
  readonly parcels: readonly EnvelopeSanityParcelInput[];
  readonly now: () => Date;
  readonly options?: EnvelopeSanityOptions;
}): WardenFindingEvent[] {
  const { sweepId, fips, rowId, parcels, now, options } = params;
  const artifactRef = `warden-sweep:${sweepId}:envelopeSanity`;
  const findings: WardenFindingEvent[] = [];

  for (const parcel of parcels) {
    const result = classifyEnvelopeSanityForParcel(parcel, options);
    if (!result) continue;
    findings.push({
      ts: now().toISOString(),
      sweepId,
      rowId,
      fips,
      parcelNodeId: parcel.parcelNodeId,
      checkId: "envelopeSanity",
      defectClass: "ENVELOPE-SHAPE-ANOMALY",
      evidence: result.evidence,
      severity: "flag",
      artifactRef,
    });
  }

  return findings;
}
