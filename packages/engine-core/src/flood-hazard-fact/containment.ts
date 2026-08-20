/**
 * SAMPLE-POINT CONTAINMENT — store-gated, three states, never collapsed.
 *
 * The check has two independently derived inputs: the query point, and the
 * parcel ring loaded from a ParcelRingStore by county_fips + parcelKey.
 * The ring does NOT travel with the atom, the fixture, or the caller's
 * geometry argument. That is the contamination the previous harness had:
 * classifySamplePointContainment(point, geometry) let tests pass the same
 * GeoJSON to the centroid and the check, so the check reported clean for
 * the same reason a self-join does.
 *
 * Production store is txgio_parcel (cortex-prod neondb), keyed the same way
 * the flood writer keys parcels: prop_id, or `_feature-${feature_index}`
 * when prop_id is null. parcel-node is an entity_type inside atoms, not a
 * table. There is no FK to a parcel-node table.
 *
 * THREE STATES. `contained` / `not-contained` / `unmeasurable` are different
 * facts. A missing ring is unmeasurable, never not-contained. A point outside
 * a loaded ring is not-contained, never unmeasurable.
 *
 * POLICY is floodDeterminationGate, kept separate from the classifier so a
 * policy change cannot quietly redefine a state. not-contained refuses.
 * unmeasurable on a finite point refuses. Null centroid never reaches this
 * module — B5 already routes that to typed absence.
 */

import { pointInGeoJson, type LngLat } from "./geo.js";

export type ContainmentState = "contained" | "not-contained" | "unmeasurable";

/**
 * A published present determination may only carry `contained`. This is a
 * TYPE, not a check: `not-contained` cannot be placed on PlannedPresent.
 */
export type EmittableContainmentState = Extract<ContainmentState, "contained">;

export interface ParcelRingRef {
  countyFips: string;
  parcelKey: string;
}

export type ParcelRingLoad =
  | { status: "present"; geometry: unknown }
  | { status: "absent" };

export interface ParcelRingStore {
  /** Where rings come from. Production adapter sets `txgio_parcel`. */
  readonly source: string;
  getRing(ref: ParcelRingRef): ParcelRingLoad;
}

export interface ContainmentVerdict {
  state: ContainmentState;
  /** Why this state. Always populated. Not parsed by the gate. */
  basis: string;
  /**
   * Discriminant the gate reads. Separate from `basis` so a wording change
   * cannot quietly reclassify unmeasurable as not-contained.
   */
  cause:
    | "inside"
    | "outside"
    | "no-point"
    | "ring-missing"
    | "ring-unusable";
  partIndex: number | null;
  ringsTested: number;
  /** Quoted so a close can show which store answered. */
  storeSource: string;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isUsableRing(coords: unknown): boolean {
  if (!Array.isArray(coords) || coords.length < 3) return false;
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) return false;
    if (!finite(Number(c[0])) || !finite(Number(c[1]))) return false;
  }
  return true;
}

/**
 * Count OUTER rings a containment test can run against.
 * Holes can exclude a point; they cannot include one.
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

function classifyAgainstLoadedGeometry(
  point: LngLat,
  geometry: unknown,
  storeSource: string,
): ContainmentVerdict {
  const ringsTested = countTestableRings(geometry);
  if (ringsTested === 0) {
    return {
      state: "unmeasurable",
      cause: "ring-unusable",
      basis:
        "store returned geometry with no usable outer ring (null, non-polygonal, or fewer than three finite vertices) — containment cannot be evaluated, which is NOT the same as failing it",
      partIndex: null,
      ringsTested: 0,
      storeSource,
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
          cause: "inside",
          basis: `query point falls inside MultiPolygon part ${i} of ${g.coordinates.length} (store=${storeSource})`,
          partIndex: i,
          ringsTested,
          storeSource,
        };
      }
    }
    return {
      state: "not-contained",
      cause: "outside",
      basis: `query point falls outside all ${g.coordinates.length} MultiPolygon parts loaded from ${storeSource}`,
      partIndex: null,
      ringsTested,
      storeSource,
    };
  }

  if (pointInGeoJson(lng, lat, geometry)) {
    return {
      state: "contained",
      cause: "inside",
      basis: `query point falls inside the parcel ring loaded from ${storeSource}`,
      partIndex: 0,
      ringsTested,
      storeSource,
    };
  }

  return {
    state: "not-contained",
    cause: "outside",
    basis: `query point falls outside the parcel ring loaded from ${storeSource} (outside the outer ring, or inside a hole)`,
    partIndex: null,
    ringsTested,
    storeSource,
  };
}

/**
 * The containment check. The ring is loaded from `store` by `ref`.
 * There is no geometry argument. Callers cannot pass the atom's GeoJSON.
 */
export function classifySamplePointContainment(
  point: LngLat | null | undefined,
  ref: ParcelRingRef,
  store: ParcelRingStore,
): ContainmentVerdict {
  if (typeof store?.getRing !== "function") {
    throw new Error(
      "classifySamplePointContainment requires a ParcelRingStore; the ring must not travel with the caller",
    );
  }
  const storeSource = store.source;

  if (!point || !finite(point[0]) || !finite(point[1])) {
    return {
      state: "unmeasurable",
      cause: "no-point",
      basis: "no finite query point to test",
      partIndex: null,
      ringsTested: 0,
      storeSource,
    };
  }

  const loaded = store.getRing(ref);
  if (loaded.status === "absent") {
    return {
      state: "unmeasurable",
      cause: "ring-missing",
      basis: `parcel ring missing from ${storeSource} for ${ref.countyFips}:${ref.parcelKey} — containment cannot be evaluated, which is NOT the same as failing it`,
      partIndex: null,
      ringsTested: 0,
      storeSource,
    };
  }

  return classifyAgainstLoadedGeometry(point, loaded.geometry, storeSource);
}

export type FloodDeterminationDecision = "emit" | "refuse";

export type FloodEmitReasonCode = "contained";

export type FloodRefusalReasonCode =
  | "sample-point-outside-parcel"
  | "parcel-ring-unmeasurable"
  | "no-sample-point";

export type FloodDeterminationGateResult =
  | { decision: "emit"; reasonCode: FloodEmitReasonCode; basis: string }
  | { decision: "refuse"; reasonCode: FloodRefusalReasonCode; basis: string };

/**
 * POLICY over the three classifier states. not-contained never emits.
 * unmeasurable on a finite point never emits — a missing ring is not a
 * weaker answer, it is an unchecked one.
 */
export function floodDeterminationGate(
  verdict: ContainmentVerdict,
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

  if (verdict.cause === "no-point") {
    return {
      decision: "refuse",
      reasonCode: "no-sample-point",
      basis: "REFUSED: no query point could be derived for this parcel",
    };
  }

  return {
    decision: "refuse",
    reasonCode: "parcel-ring-unmeasurable",
    basis: `REFUSED: ${verdict.basis}`,
  };
}

export interface ContainmentTally {
  contained: number;
  notContained: number;
  unmeasurable: number;
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
    emitted: 0,
    refused: 0,
    byReasonCode: {},
    countingRule:
      "one count per FINITE-POINT plannable parcel. contained + notContained + unmeasurable = that population, measured not subtracted. Null centroid is B5 absence and is not a containment class. emitted + refused = the same finite-point population.",
  };
}

export function tallyContainment(
  tally: ContainmentTally,
  verdict: ContainmentVerdict,
  gate: FloodDeterminationGateResult,
): void {
  if (verdict.state === "contained") tally.contained += 1;
  else if (verdict.state === "not-contained") tally.notContained += 1;
  else tally.unmeasurable += 1;
  if (gate.decision === "emit") tally.emitted += 1;
  else tally.refused += 1;
  tally.byReasonCode[gate.reasonCode] =
    (tally.byReasonCode[gate.reasonCode] ?? 0) + 1;
}

function ringId(countyFips: string, parcelKey: string): string {
  return `${countyFips}\0${parcelKey}`;
}

/**
 * Test / prefetch store. Production fills this from a txgio_parcel SELECT
 * (see txgio-parcel-ring-store.ts). Tests MUST construct rings independently
 * of the atom under test.
 */
export class MemoryParcelRingStore implements ParcelRingStore {
  private readonly rings = new Map<string, unknown>();

  constructor(readonly source: string = "memory") {}

  set(countyFips: string, parcelKey: string, geometry: unknown): void {
    this.rings.set(ringId(countyFips, parcelKey), geometry);
  }

  getRing(ref: ParcelRingRef): ParcelRingLoad {
    const id = ringId(ref.countyFips, ref.parcelKey);
    if (!this.rings.has(id)) return { status: "absent" };
    return { status: "present", geometry: this.rings.get(id) };
  }
}

/**
 * Independently constructed squares around each finite centroid.
 * Used by existing plan tests so they still reach zone evaluation.
 * NOT the contamination path: the square is a new object, not the
 * atom geometry and not the centroid tuple.
 */
export function memoryStoreContainingCentroids(
  countyFips: string,
  parcels: ReadonlyArray<{ parcelKey: string; centroid: LngLat | null }>,
  half = 1,
): MemoryParcelRingStore {
  const store = new MemoryParcelRingStore("memory");
  for (const p of parcels) {
    if (
      !p.centroid ||
      !finite(p.centroid[0]) ||
      !finite(p.centroid[1])
    ) {
      continue;
    }
    const lng = p.centroid[0];
    const lat = p.centroid[1];
    store.set(countyFips, p.parcelKey, {
      type: "Polygon",
      coordinates: [
        [
          [lng - half, lat - half],
          [lng + half, lat - half],
          [lng + half, lat + half],
          [lng - half, lat + half],
          [lng - half, lat - half],
        ],
      ],
    });
  }
  return store;
}
