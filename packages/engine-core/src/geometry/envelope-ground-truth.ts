/**
 * FIX 3 (2026-08-06 differential audit + process-retro R3): shared
 * envelope/parcel ground-truth predicate — ONE implementation, imported
 * (never re-derived) at every gate that needs to know whether a promoted
 * buildable-envelope is geometrically correct against its parcel.
 *
 * The process-retro's core finding (R2 candidate a/e): a real containment
 * check (Warden envelopeSanity v1.2) existed but was never wired as a
 * REQUIRED gate at the closing decision that mattered (WS1's operator-twelve
 * close relied on serveTruthEdgeLabels — a role-at-index comparison that
 * cannot see geometry — and 48021:31308 shipped with 2 of 4 inset vertices
 * outside the true parcel ring). The fix is not a new predicate; it's ONE
 * predicate wired everywhere a promote/serve/verify decision is made, so a
 * fix to the predicate propagates automatically instead of being reasoned
 * about locally per call site (process-retro R2 candidate d, R3).
 *
 * Three parts, each delegating to the SAME shared primitive the rest of the
 * engine already uses for that concern — never a locally re-derived check:
 *
 *   P1 containment  — envelope ring fully inside the parcel ring, tolerance-
 *                      bounded. Delegates to polygon-inset.ts:pointInOrOnPolygon
 *                      (the same function geometryCorrectnessGate uses).
 *   P2 inset distance — each envelope edge's inset distance from its
 *                      GEOMETRICALLY-determined corresponding parcel edge
 *                      (index-matched by parallel offset + overlap, never by
 *                      stored role label) matches the district setback for
 *                      that edge's role. Delegates to
 *                      measure-inset.ts:measurePerEdgeInsetForRings (R32) —
 *                      the same index-matched measurement cert-grade and
 *                      warm-verify already share (cert-equivalent-gates.ts).
 *   P3 front-on-street — the front-labeled edge is the street-adjacent edge
 *                      given road geometry. Delegates to
 *                      edgeLabeling.ts:labelEdgesFromRoads (the same fresh
 *                      road-proximity labeling R30/R31 already use) — never
 *                      trusts a stored role.
 *
 * Wired at (per dispatch): (a) PROMOTE — fail-closed, a candidate failing
 * this predicate is not persisted; (b) Warden envelopeSanity (v1.2 upgrade
 * to call this module instead of its own local containment/parallelism
 * logic); (c) exported for the smoke/vitest suite.
 */

import {
  measurePerEdgeInsetForRings,
  type MeasuredEdgeInset,
} from "../depth-warm/measure-inset.js";
import { labelEdgesFromRoads } from "../depth-warm/edgeLabeling.js";
import {
  buildFlatSetbackFallback,
  resolveInsetFeetForEdge,
} from "../depth-warm/warm-compute.js";
import { openRing, projectRing, type Ring } from "../depth-warm/geometry.js";
import { pointInOrOnPolygon } from "./polygon-inset.js";
import type { WarmEdgeRole, WarmRoadSource } from "../depth-warm/types.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";

export type EnvelopeGroundTruthFailureReason =
  | "invalid-parcel-ring"
  | "invalid-envelope-ring"
  | "p1-envelope-outside-parcel"
  | "p2-inset-distance-mismatch"
  | "p3-front-not-street-adjacent";

export interface EnvelopeGroundTruthOptions {
  /** P1 containment tolerance in metres. Default 0.12 (matches geometryCorrectnessGate). */
  containmentToleranceM?: number;
  /** P2 per-edge inset tolerance in feet. Default 1.0 (matches R32 DEFAULT_R32_INSET_TOL_FT). */
  insetToleranceFt?: number;
}

export interface EnvelopeGroundTruthInput {
  parcelRing: Ring;
  envelopeRing: Ring;
  descriptor: JurisdictionDescriptor;
  district: string;
  roads: ReadonlyArray<WarmRoadSource>;
  /** Optional — when absent, P3 is skipped as a determinable check (honest absence, not a failure). */
  situsAddress?: string | null;
  /**
   * Optional pre-resolved edge roles (index -> role). When supplied, P2 uses
   * these roles ONLY to resolve the district setback NUMBER for a
   * geometrically-matched edge — never to decide WHICH parcel edge an
   * envelope edge corresponds to (that correspondence is always geometric,
   * per measurePerEdgeInsetForRings). Falls back to fresh labelEdgesFromRoads
   * when omitted.
   */
  edgeRoles?: ReadonlyMap<number, WarmEdgeRole>;
  options?: EnvelopeGroundTruthOptions;
}

export interface EnvelopeGroundTruthP1Result {
  pass: boolean;
  outsideVertexCount: number;
}

export interface EnvelopeGroundTruthP2EdgeResult {
  edgeIndex: number;
  role: WarmEdgeRole | null;
  measuredFt: number | null;
  expectedFt: number | null;
  pass: boolean;
  /**
   * 2026-08-07 OFFSET-CORE-VARIABLE-DISTANCE redesign (master planner
   * ruling 2, PR #269): true when measure-inset.ts's structural
   * correspondence pass determined this edge's own candidate boundary
   * belongs to a more restrictive, near-parallel ADJACENT lot edge — this
   * edge's constraint is satisfied by containment (the envelope already
   * sits farther inward than this edge's own setback requires), not
   * genuinely mismatched. `measuredFt` in that case reflects the OTHER
   * edge's boundary distance from THIS edge's own line, not a dedicated
   * measurement of this edge — callers must not compare it to
   * `expectedFt` when this flag is set (the `pass` field already accounts
   * for it).
   */
  satisfiedByMoreRestrictiveNeighbor?: boolean;
}

export interface EnvelopeGroundTruthP2Result {
  pass: boolean;
  edges: EnvelopeGroundTruthP2EdgeResult[];
}

export interface EnvelopeGroundTruthP3Result {
  /** null when orientation is not determinable (no situs / no roads) — honest absence, not failure. */
  pass: boolean | null;
  frontEdgeIndex: number | null;
  frontIsStreetAdjacent: boolean | null;
  reason?: string;
}

export interface EnvelopeGroundTruthResult {
  pass: boolean;
  failureReason: EnvelopeGroundTruthFailureReason | null;
  p1: EnvelopeGroundTruthP1Result;
  p2: EnvelopeGroundTruthP2Result;
  p3: EnvelopeGroundTruthP3Result;
}

const DEFAULT_CONTAINMENT_TOL_M = 0.12;
const DEFAULT_INSET_TOL_FT = 1.0;

/**
 * P1 — envelope ring fully contained in the parcel ring (tolerance-bounded).
 * Exported standalone (not just via checkEnvelopeGroundTruth) so a caller
 * that only has parcel/envelope rings — no descriptor/roads for P2/P3, e.g.
 * Warden envelopeSanity's existing input shape — can still run the SAME
 * containment predicate rather than re-deriving its own pointInOrOnPolygon
 * loop. Every call site importing this function instead of writing its own
 * containment check is exactly the FIX 3 requirement: one implementation,
 * never re-derived locally.
 */
export function checkEnvelopeContainment(
  parcelRing: Ring,
  envelopeRing: Ring,
  toleranceM: number = DEFAULT_CONTAINMENT_TOL_M,
): EnvelopeGroundTruthP1Result | null {
  const parcelProj = projectRing(parcelRing);
  if (!parcelProj) return null;
  const envOpen = openRing(envelopeRing);
  if (envOpen.length < 3) return null;

  let outsideVertexCount = 0;
  for (const [lng, lat] of envOpen) {
    const p = {
      x: (lng - parcelProj.originLng) * parcelProj.mPerDegLng,
      y: (lat - parcelProj.originLat) * parcelProj.mPerDegLat,
    };
    if (!pointInOrOnPolygon(p, parcelProj.points, toleranceM)) outsideVertexCount++;
  }
  return { pass: outsideVertexCount === 0, outsideVertexCount };
}

/**
 * P2 — each envelope edge's inset distance from its GEOMETRICALLY-matched
 * parcel edge (measurePerEdgeInsetForRings, index-matched by parallel
 * offset + overlap — never by stored label) must match the district
 * setback for that edge's role.
 */
function checkInsetDistances(
  parcelRing: Ring,
  envelopeRing: Ring,
  descriptor: JurisdictionDescriptor,
  district: string,
  toleranceFt: number,
  edgeRoles: ReadonlyMap<number, WarmEdgeRole> | undefined,
  roads: ReadonlyArray<WarmRoadSource>,
  situsAddress: string | null | undefined,
): EnvelopeGroundTruthP2Result | null {
  const measured = measurePerEdgeInsetForRings(parcelRing, envelopeRing);
  if (!measured) return null;

  let roleByIndex = edgeRoles;
  if (!roleByIndex) {
    const fresh = labelEdgesFromRoads({ parcelRing, roads, situsAddress: situsAddress ?? null });
    roleByIndex = fresh.ok
      ? new Map(fresh.edgeLabels.map((e) => [e.index, e.label]))
      : new Map<number, WarmEdgeRole>();
  }

  const flatFallback = buildFlatSetbackFallback(descriptor, district);
  const edges: EnvelopeGroundTruthP2EdgeResult[] = measured.map((m: MeasuredEdgeInset) => {
    const role = roleByIndex!.get(m.edgeIndex) ?? null;
    const expectedFt = role
      ? resolveInsetFeetForEdge(descriptor, district, { label: role }, flatFallback)
      : null;
    const measuredFt = m.insetFeet;
    // 2026-08-07 OFFSET-CORE-VARIABLE-DISTANCE redesign (ruling 2): honor
    // measure-inset.ts's structural correspondence result — a
    // satisfiedByMoreRestrictiveNeighbor edge is honestly non-comparable
    // (satisfied by containment via a more restrictive adjacent edge), the
    // SAME category as "no determinable role," never compared against
    // expectedFt.
    const pass =
      role == null || expectedFt == null || measuredFt == null || m.satisfiedByMoreRestrictiveNeighbor
        ? true // no determinable role, or honestly non-comparable — not a P2 failure
        : Math.abs(measuredFt - expectedFt) <= toleranceFt;
    return {
      edgeIndex: m.edgeIndex,
      role,
      measuredFt,
      expectedFt,
      pass,
      satisfiedByMoreRestrictiveNeighbor: m.satisfiedByMoreRestrictiveNeighbor,
    };
  });

  return { pass: edges.every((e) => e.pass), edges };
}

/**
 * P3 — the front-labeled edge is the street-adjacent edge given road
 * geometry. Delegates entirely to labelEdgesFromRoads (fresh, geometric —
 * never trusts a stored role for the correspondence itself).
 */
function checkFrontOnStreet(
  parcelRing: Ring,
  roads: ReadonlyArray<WarmRoadSource>,
  situsAddress: string | null | undefined,
  edgeRoles: ReadonlyMap<number, WarmEdgeRole> | undefined,
): EnvelopeGroundTruthP3Result {
  if (roads.length === 0) {
    return { pass: null, frontEdgeIndex: null, frontIsStreetAdjacent: null, reason: "no-roads-available" };
  }
  const fresh = labelEdgesFromRoads({ parcelRing, roads, situsAddress: situsAddress ?? null });
  if (!fresh.ok) {
    return { pass: null, frontEdgeIndex: null, frontIsStreetAdjacent: null, reason: fresh.decline };
  }
  const freshFront = fresh.edgeLabels.find((e) => e.label === "front");
  if (!freshFront) {
    return { pass: null, frontEdgeIndex: null, frontIsStreetAdjacent: null, reason: "no-front-edge-resolved" };
  }

  // The claimed front role (from edgeRoles, i.e. what was actually stored/
  // promoted) must be the SAME edge index the fresh geometric labeling
  // resolves as street-adjacent front. When edgeRoles is omitted, the
  // predicate checks the freshly-resolved front against itself (trivially
  // true) — callers that care about a STORED role's correctness must pass
  // edgeRoles.
  if (!edgeRoles) {
    return { pass: true, frontEdgeIndex: freshFront.index, frontIsStreetAdjacent: true };
  }
  const claimedFrontIndex = [...edgeRoles.entries()].find(([, role]) => role === "front")?.[0] ?? null;
  const frontIsStreetAdjacent = claimedFrontIndex === freshFront.index;
  return {
    pass: frontIsStreetAdjacent,
    frontEdgeIndex: claimedFrontIndex,
    frontIsStreetAdjacent,
    reason: frontIsStreetAdjacent
      ? undefined
      : `claimed front edge ${claimedFrontIndex} != geometrically street-adjacent edge ${freshFront.index}`,
  };
}

/**
 * The shared ground-truth predicate. Returns pass=false with a
 * failureReason on the FIRST unmet part in P1 -> P2 -> P3 order (P1/P2 are
 * hard failures; P3 fails closed only when it IS determinable and
 * disagrees — an honestly-undeterminable P3 does not fail the predicate).
 */
export function checkEnvelopeGroundTruth(
  input: EnvelopeGroundTruthInput,
): EnvelopeGroundTruthResult {
  const opts = input.options ?? {};
  const containmentToleranceM = opts.containmentToleranceM ?? DEFAULT_CONTAINMENT_TOL_M;
  const insetToleranceFt = opts.insetToleranceFt ?? DEFAULT_INSET_TOL_FT;

  const parcelProj = projectRing(input.parcelRing);
  if (!parcelProj) {
    return {
      pass: false,
      failureReason: "invalid-parcel-ring",
      p1: { pass: false, outsideVertexCount: 0 },
      p2: { pass: false, edges: [] },
      p3: { pass: null, frontEdgeIndex: null, frontIsStreetAdjacent: null },
    };
  }
  if (openRing(input.envelopeRing).length < 3) {
    return {
      pass: false,
      failureReason: "invalid-envelope-ring",
      p1: { pass: false, outsideVertexCount: 0 },
      p2: { pass: false, edges: [] },
      p3: { pass: null, frontEdgeIndex: null, frontIsStreetAdjacent: null },
    };
  }

  const p1 = checkEnvelopeContainment(input.parcelRing, input.envelopeRing, containmentToleranceM) ?? {
    pass: false,
    outsideVertexCount: -1,
  };

  const p2 = checkInsetDistances(
    input.parcelRing,
    input.envelopeRing,
    input.descriptor,
    input.district,
    insetToleranceFt,
    input.edgeRoles,
    input.roads,
    input.situsAddress,
  ) ?? { pass: false, edges: [] };

  const p3 = checkFrontOnStreet(input.parcelRing, input.roads, input.situsAddress, input.edgeRoles);

  let failureReason: EnvelopeGroundTruthFailureReason | null = null;
  if (!p1.pass) failureReason = "p1-envelope-outside-parcel";
  else if (!p2.pass) failureReason = "p2-inset-distance-mismatch";
  else if (p3.pass === false) failureReason = "p3-front-not-street-adjacent";

  const pass = p1.pass && p2.pass && p3.pass !== false;

  return { pass, failureReason, p1, p2, p3 };
}
