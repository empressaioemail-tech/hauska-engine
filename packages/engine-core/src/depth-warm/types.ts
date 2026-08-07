/**
 * Depth-warm Tier-2 candidate shapes (27c R3 WDLL 6).
 * Cheap working memory — promote only after mechanical verify passes.
 */

import type { RoadClassification } from "@hauska-engine/atoms";

import type { GeometryCorrectnessResult, Ring } from "./geometry.js";

export type WarmEdgeRole = "front" | "side" | "rear" | "side_corner";

export type WarmRoadProvenanceKind =
  | "county-roadway-authoritative"
  | "county-surveyed-2016"
  | "osm-fallback";

/** Road input attached during warm compute — OSM fallback or county-surveyed. */
export interface WarmRoadSource {
  osmWayId: number;
  osmHighwayTag: string;
  surface?: string;
  name?: string;
  classification: RoadClassification;
  polyline: Ring;
  provenanceKind?: WarmRoadProvenanceKind;
  countySegmentObjectId?: number;
}

export interface WarmEdgeInfo {
  index: number;
  label: WarmEdgeRole;
  roadClass?: RoadClassification;
  /** Source tag used for mechanical classification-vs-source verify. */
  osmHighwayTag?: string;
  /** OSM surface=* paired with osmHighwayTag for service/unpaved→gravel parity. */
  osmSurfaceTag?: string;
  roadProvenanceKind?: WarmRoadProvenanceKind;
  insetFeet: number;
}

/** Lossy warm output — not durable until verify + promote. */
export interface WarmCandidate {
  parcelNodeId: string;
  district: string;
  parcelRing: Ring;
  insetRing: Ring | null;
  insetFeetPerEdge: number[];
  edges: WarmEdgeInfo[];
  roads: WarmRoadSource[];
  buildableAreaSqFt: number;
  parcelAreaSqFt: number;
  empty: boolean;
  emptyReason?: string;
  warmAt: string;
  warmAgentId: string;
  /**
   * Miter points collapseNearCollinearOffsetNotches (polygon-inset.ts)
   * produced building insetRing, WGS84. Carried on the candidate so any
   * SECOND, independent call to geometryCorrectnessGate downstream (e.g.
   * verifyWarmCandidateMechanically, which re-derives geometry from the
   * candidate alone) is not blind to a legitimate notch collapse (2026-08-06
   * live-pipeline fix — the prior gap: WarmCandidate carried no such field,
   * so a real corner-lot envelope that insetPerEdge/insetPerEdgeFromPrimitive
   * already validated correctly could still fail the mechanical verify
   * gate's OWN geometryCorrectnessGate call).
   */
  miterPointsWgs84?: Ring;
  /**
   * GROUND-TRUTH FRAME LAW (2026-08-07, master planner ruling — third
   * instance of "gate against an internal representation instead of ground
   * truth"): the RAW parcel ring, exactly as read from the source-of-truth
   * store (txgio_parcel / BCAD), BEFORE any lot-line scrub. `parcelRing`
   * above may be a scrubbed/cleaned ring (fed to the inset computation so a
   * genuine digitization artifact doesn't corrupt an inward normal) — but
   * the ground-truth predicate (checkEnvelopeGroundTruth: P1 containment,
   * P2 inset distance, P3 front-on-street) and any write-then-verify
   * read-back MUST evaluate the served envelope against THIS ring, never
   * the scrubbed one. Verified root cause: 48021:31299's served envelope
   * (correct relative to its own scrubbed 4-edge ring: 5/25/15/25ft, exact)
   * measures 0.41/27.6/20.6/23.3ft against the RAW 5-edge ring — the
   * scrubbed ring silently dropped a real 2.428m (7.97ft) boundary edge,
   * and every downstream gate that checked "is the envelope right"
   * answered only "is it right relative to the ring the engine itself
   * built," never "is it right relative to the parcel." Optional only for
   * back-compat with callers that never scrub (rawParcelRing === parcelRing
   * in that case, e.g. the twelve-parcel harness's direct fixture rings) —
   * REQUIRED for any caller whose parcelRing may differ from source, i.e.
   * every live promote path.
   */
  rawParcelRing?: Ring;
}

export interface MechanicalGateResult {
  pass: boolean;
  reasons: string[];
}

export interface VerifyResult {
  pass: boolean;
  gates: {
    geometry: GeometryCorrectnessResult;
    roadClassification: MechanicalGateResult;
    setbackEdgeDistance: MechanicalGateResult;
    /** R31 — front edge must match fresh road/situs labeling, not merely magnitudes. */
    frontOrientation: MechanicalGateResult;
    /** R33 / R32 — per-edge inset remeasure (cert-equivalent). */
    r32PerEdgeInset: MechanicalGateResult;
    /** R33 — situs front-street token matches resolved OSM road name. */
    facesAnswer: MechanicalGateResult;
  };
}

export interface PromotedDepthWarmBundle {
  parcelNodeId: string;
  setbackRuleAtomDid: string;
  buildableEnvelopeAtomDid: string;
  /** property-boundary-edge atom DIDs written at promote (WS1 Option A). */
  boundaryEdgeAtomDids: string[];
  promotedAt: string;
}

/** Marker written on promoted atoms — read path uses this to skip cold derive. */
export const DEPTH_WARM_PROMOTION_MARKER = "depth-warm-promoted-v1" as const;

/**
 * The recipe version a promoted atom was warmed under — the REWARM TRIGGER
 * (OPS-4). Every promoted atom carries this; the performance ledger compares a
 * jurisdiction's atoms' recipeVersion against the current RECIPE_VERSION to know
 * what needs rewarming after a recipe improvement. Distinct from the promotion
 * marker (which says "this came from a warm"): recipeVersion says "under which
 * version of the correctness recipe." Bump on any recipe ruling change.
 */
export const RECIPE_VERSION = "1.0.0" as const;

export const DEPTH_WARM_SOURCE_CITATION =
  "depth-warm-verified mechanical promote (27c R3 WDLL 6)" as const;
