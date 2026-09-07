/**
 * SAMPLE-POINT CONTAINMENT — the meaning-shaped check on `flood-hazard-fact`.
 *
 * WHY THIS EXISTS. `tier2` flood was retired for asking FEMA about a
 * 0.005-degree tile centre, a measured median 227 m from the parcel it answered
 * for. The replacement asks about the parcel centroid instead, which is nearer
 * but is still only a POINT, and nothing in the record said whether that point
 * was in the parcel. Two things in the write path can put it outside:
 *
 *   1. `ringCentroid` is the arithmetic mean of the outer ring's VERTICES. For
 *      a concave parcel — an L, a crescent, a flag lot — the mean can lie
 *      outside the ring entirely. It is also vertex-density weighted, so a ring
 *      that is finely sampled along one edge drags the mean toward that edge.
 *   2. When the ring is unusable the writer falls back to the centre of the
 *      parcel's BOUNDING BOX. That is the tier2 defect at parcel scale: a
 *      determination made at a point that is not the parcel.
 *
 * WHAT MAKES IT MEANING-SHAPED. A presence-shaped check has one input and asks
 * whether it is there. This has two independently derived inputs and asks
 * whether they AGREE: the query point on one side, the parcel's own ring on the
 * other, joined by a ray cast that is a different computation from the vertex
 * mean that produced the point. No sentinel satisfies both at once — a tile
 * centre, a bbox centre, a (0,0), a NaN, or a point copied from a neighbouring
 * parcel all fail containment, and a fabricated ring produces no verdict rather
 * than a passing one.
 *
 * THREE STATES, NEVER TWO. `contained`, `not-contained` and `unmeasurable` are
 * different facts and this module refuses to collapse them. A parcel with no
 * ring has not failed the check; it has not been checked. The POLICY over those
 * states lives in `floodDeterminationGate` below, deliberately separated from
 * the classifier so that a policy change can never quietly redefine a state.
 */

import { pointInGeoJson, type BBox, type LngLat } from "./geo.js";

/**
 * How the query point was obtained. This is recorded, not inferred, because
 * `geometryCentroid(g) ?? bboxCentre(...)` erased the distinction at the point
 * of use and no consumer could tell a ring-derived point from a bbox-derived
 * one.
 */
export type SamplePointDerivation =
  /** Vertex mean of the outer ring of a Polygon, or of a MultiPolygon's first part. */
  | "ring-centroid"
  /** The source publishes a Point for this parcel; the point IS the parcel's own location. */
  | "point-geometry"
  /** No usable geometry; centre of the stored bounding box. The tier2 shape, smaller. */
  | "bbox-centre"
  /**
   * The caller asserted a point and supplied no ring to test it against. Same
   * trust class as a bounding-box centre: nothing ties it to the parcel.
   */
  | "declared"
  /** Neither geometry nor a finite bbox. No point exists. */
  | "none";

export type ContainmentState = "contained" | "not-contained" | "unmeasurable";

/**
 * The states a PUBLISHED determination is allowed to carry.
 *
 * This is a TYPE, not a check, and that is deliberate. A runtime guard has a
 * trigger that can be missing and a call site that can be skipped; a type has
 * neither. `PlannedPresentFloodHazard` and `PlannedAbsentFloodHazard` are
 * stamped with this rather than with `ContainmentState`, so a `not-contained`
 * determination cannot be placed in `plan.planned` at all — not by a new branch,
 * not by a future edit, not by a caller who has not read this file. The
 * compiler rejects it at every consumer.
 *
 * The runtime throw in `buildAtomForPlannedFloodHazard` is a belt for the
 * untyped side: the county writer is a `.mjs` script and TypeScript does not
 * check it.
 */
export type EmittableContainmentState = Exclude<
  ContainmentState,
  "not-contained"
>;

export interface ContainmentVerdict {
  state: ContainmentState;
  /** Why this state, in words a close can quote. Always populated. */
  basis: string;
  /**
   * Which MultiPolygon part contained the point, 0-based. Null when the state
   * is not `contained` or the geometry is a single Polygon.
   */
  partIndex: number | null;
  /** Rings actually tested. 0 means nothing was testable, hence `unmeasurable`. */
  ringsTested: number;
}

export interface SamplePoint {
  point: LngLat | null;
  derivation: SamplePointDerivation;
  /** Why this derivation and not a better one. Always populated. */
  basis: string;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isUsableRing(coords: unknown): boolean {
  if (!Array.isArray(coords) || coords.length < 3) return false;
  let usable = 0;
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) return false;
    if (!finite(Number(c[0])) || !finite(Number(c[1]))) return false;
    usable += 1;
  }
  return usable >= 3;
}

/**
 * Count the outer rings this geometry offers to a containment test.
 *
 * Deliberately counts OUTER rings only: a hole is a reason a point can be
 * outside, never a reason it can be inside, so a geometry that is nothing but
 * holes has nothing to test against.
 */
export function countTestableRings(geometry: unknown): number {
  if (!geometry || typeof geometry !== "object") return 0;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    return isUsableRing(g.coordinates[0]) ? 1 : 0;
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    let n = 0;
    for (const poly of g.coordinates) {
      if (Array.isArray(poly) && isUsableRing(poly[0])) n += 1;
    }
    return n;
  }
  return 0;
}

/**
 * Derive the FEMA query point AND say where it came from.
 *
 * This replaces the writer's `geometryCentroid(g) ?? bboxCentre(...)`. The
 * value it returns for the ring case is bit-identical to what that expression
 * returned — the change is that the derivation is now a first-class field
 * instead of a silent branch of a `??`.
 */
export function deriveFloodSamplePoint(
  geometry: unknown,
  bbox: Partial<BBox> | null | undefined,
  centroidOf: (geometry: unknown) => LngLat | null,
): SamplePoint {
  const g =
    geometry && typeof geometry === "object"
      ? (geometry as { type?: string })
      : null;

  const centroid = centroidOf(geometry);
  if (centroid && finite(centroid[0]) && finite(centroid[1])) {
    if (g?.type === "Point") {
      return {
        point: centroid,
        derivation: "point-geometry",
        basis:
          "source publishes a Point geometry for this parcel; the query point is the parcel's own published location and there is no ring to test it against",
      };
    }
    return {
      point: centroid,
      derivation: "ring-centroid",
      basis: `vertex mean of the outer ring of ${g?.type ?? "the parcel geometry"}`,
    };
  }

  const west = Number(bbox?.westLng);
  const south = Number(bbox?.southLat);
  const east = Number(bbox?.eastLng);
  const north = Number(bbox?.northLat);
  if (finite(west) && finite(south) && finite(east) && finite(north)) {
    return {
      point: [(west + east) / 2, (south + north) / 2],
      derivation: "bbox-centre",
      basis:
        "no usable parcel ring; query point is the centre of the stored bounding box and is NOT tied to the parcel shape",
    };
  }

  return {
    point: null,
    derivation: "none",
    basis: "no usable parcel geometry and no finite bounding box",
  };
}

/**
 * The containment check itself.
 *
 * Returns `unmeasurable` — never `not-contained` — when there is no ring to
 * test against, because "we did not check" and "we checked and it failed" are
 * different facts and a reader who cannot tell them apart has been misled in
 * the direction of confidence.
 */
export function classifySamplePointContainment(
  point: LngLat | null | undefined,
  geometry: unknown,
): ContainmentVerdict {
  const ringsTested = countTestableRings(geometry);

  if (!point || !finite(point[0]) || !finite(point[1])) {
    return {
      state: "unmeasurable",
      basis: "no finite query point to test",
      partIndex: null,
      ringsTested: 0,
    };
  }

  if (ringsTested === 0) {
    return {
      state: "unmeasurable",
      basis:
        "parcel carries no usable outer ring (geometry null, non-polygonal, or fewer than three finite vertices) — containment cannot be evaluated, which is NOT the same as failing it",
      partIndex: null,
      ringsTested: 0,
    };
  }

  const [lng, lat] = point;
  const g = geometry as { type?: string; coordinates?: unknown };

  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    for (let i = 0; i < g.coordinates.length; i++) {
      const poly = g.coordinates[i];
      if (!Array.isArray(poly)) continue;
      if (pointInGeoJson(lng, lat, { type: "Polygon", coordinates: poly })) {
        return {
          state: "contained",
          basis: `query point falls inside MultiPolygon part ${i} of ${g.coordinates.length}`,
          partIndex: i,
          ringsTested,
        };
      }
    }
    return {
      state: "not-contained",
      basis: `query point falls outside all ${g.coordinates.length} MultiPolygon parts of the parcel it answers for`,
      partIndex: null,
      ringsTested,
    };
  }

  if (pointInGeoJson(lng, lat, geometry)) {
    return {
      state: "contained",
      basis: "query point falls inside the parcel ring",
      partIndex: 0,
      ringsTested,
    };
  }

  return {
    state: "not-contained",
    basis:
      "query point falls outside the parcel ring it answers for (outside the outer ring, or inside a hole)",
    partIndex: null,
    ringsTested,
  };
}

export type FloodDeterminationDecision = "emit" | "refuse";

export type FloodEmitReasonCode = "contained" | "point-geometry-unmeasurable";

export type FloodRefusalReasonCode =
  | "sample-point-outside-parcel"
  | "sample-point-not-tied-to-parcel"
  | "no-sample-point";

/**
 * A DISCRIMINATED UNION, not a struct with two independent fields.
 *
 * With `decision` and `reasonCode` as free-standing fields nothing stops
 * `{ decision: "emit", reasonCode: "sample-point-outside-parcel" }` from being
 * constructed, and that object is a fail-open wearing the shape of a control.
 * Narrowing on `decision` now narrows `reasonCode` with it, so the impossible
 * pairing is a compile error rather than a code-review responsibility.
 */
export type FloodDeterminationGateResult =
  | { decision: "emit"; reasonCode: FloodEmitReasonCode; basis: string }
  | { decision: "refuse"; reasonCode: FloodRefusalReasonCode; basis: string };

/**
 * THE POLICY, kept separate from the classifier on purpose.
 *
 * The classifier answers a question about the world. This answers a question
 * about what we are willing to publish. Fusing them is how a state gets
 * quietly redefined by a policy change, so they are two functions and the
 * states are the interface between them.
 *
 * `not-contained` refuses. It does not score lower — a determination made at a
 * point outside the parcel is not a weaker answer about the parcel, it is an
 * answer about somewhere else, which is the exact sentence that retired tier2.
 *
 * `unmeasurable` splits, because it covers two genuinely different situations.
 * Where the source publishes a Point for the parcel, the query point IS the
 * parcel's own published location and the only thing missing is a ring to
 * confirm it with, so the determination is emitted and marked. Where the point
 * is a bbox centre, NEITHER derivation ties it to the parcel and it refuses.
 */
export function floodDeterminationGate(
  verdict: ContainmentVerdict,
  derivation: SamplePointDerivation,
): FloodDeterminationGateResult {
  if (verdict.state === "contained") {
    return {
      decision: "emit",
      reasonCode: "contained",
      basis: verdict.basis,
    };
  }

  if (verdict.state === "not-contained") {
    return {
      decision: "refuse",
      reasonCode: "sample-point-outside-parcel",
      basis: `REFUSED: ${verdict.basis}`,
    };
  }

  if (derivation === "point-geometry") {
    return {
      decision: "emit",
      reasonCode: "point-geometry-unmeasurable",
      basis:
        "containment unmeasurable, but the query point is the parcel's own published Point geometry rather than a derived stand-in",
    };
  }

  if (derivation === "none") {
    return {
      decision: "refuse",
      reasonCode: "no-sample-point",
      basis: "REFUSED: no query point could be derived for this parcel",
    };
  }

  return {
    decision: "refuse",
    reasonCode: "sample-point-not-tied-to-parcel",
    basis:
      `REFUSED: containment unmeasurable and the query point derivation is ${derivation}, so neither derivation ties the point to the parcel — the tier2 failure shape at parcel scale`,
  };
}

export interface ContainmentTally {
  contained: number;
  notContained: number;
  unmeasurable: number;
  byDerivation: Record<SamplePointDerivation, number>;
  emitted: number;
  refused: number;
  byReasonCode: Record<string, number>;
  countingRule: string;
}

export function emptyContainmentTally(): ContainmentTally {
  return {
    contained: 0,
    notContained: 0,
    unmeasurable: 0,
    byDerivation: {
      "ring-centroid": 0,
      "point-geometry": 0,
      "bbox-centre": 0,
      declared: 0,
      none: 0,
    },
    emitted: 0,
    refused: 0,
    byReasonCode: {},
    countingRule:
      "one count per PLANNABLE parcel (post key-normalisation and dedupe), never per source row. contained + notContained + unmeasurable = the plannable population, measured not subtracted. emitted + refused = the same population.",
  };
}

export function tallyContainment(
  tally: ContainmentTally,
  verdict: ContainmentVerdict,
  derivation: SamplePointDerivation,
  gate: FloodDeterminationGateResult,
): void {
  if (verdict.state === "contained") tally.contained += 1;
  else if (verdict.state === "not-contained") tally.notContained += 1;
  else tally.unmeasurable += 1;
  tally.byDerivation[derivation] += 1;
  if (gate.decision === "emit") tally.emitted += 1;
  else tally.refused += 1;
  tally.byReasonCode[gate.reasonCode] =
    (tally.byReasonCode[gate.reasonCode] ?? 0) + 1;
}
