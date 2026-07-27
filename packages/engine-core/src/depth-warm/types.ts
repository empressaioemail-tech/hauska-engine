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
  };
}

export interface PromotedDepthWarmBundle {
  parcelNodeId: string;
  setbackRuleAtomDid: string;
  buildableEnvelopeAtomDid: string;
  promotedAt: string;
}

/** Marker written on promoted atoms — read path uses this to skip cold derive. */
export const DEPTH_WARM_PROMOTION_MARKER = "depth-warm-promoted-v1" as const;

export const DEPTH_WARM_SOURCE_CITATION =
  "depth-warm-verified mechanical promote (27c R3 WDLL 6)" as const;
