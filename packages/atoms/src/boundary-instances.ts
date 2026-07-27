/**
 * Property boundary edge atom instances (27f S2-U2 / WDLL 4–5).
 *
 * Vendored contract shape until @empressaio/atom-contract publishes
 * property-boundary-edge; mirrors road-node vendoring pattern.
 */

import type { AccessPolicy } from "@empressaio/atom-contract";
import type { ReasoningReadContract } from "@empressaio/atom-contract/read-contract";

import type { PropertyAtomStatus } from "./property-instances.js";
import type { RoadClassification } from "./road-instances.js";

/** `{county_fips}:{prop_id}:boundary:{edgeIndex}` */
export const BOUNDARY_EDGE_ID_PATTERN =
  /^\d{5}:[A-Za-z0-9._-]+:boundary:\d+$/;

export type BoundaryAdjacencyKind =
  | "ROW"
  | "alley"
  | "neighbor-parcel"
  | "unmapped";

export interface BoundaryFacingRoad {
  roadNodeId: string;
  classification: RoadClassification;
  provenance: string;
  osmHighwayTag?: string;
}

export interface BoundaryResolvedSetback {
  feet: number;
  provenance: string;
  atomCitation?: string;
}

export interface BoundarySetbackAbsence {
  kind: "no-setback-row" | "unmapped-adjacency";
  reason: string;
}

export interface BoundaryInteriorFrame {
  ringCcw: boolean;
  centroidInside: boolean;
  inwardNormal: { x: number; y: number };
  /**
   * Local-ENU metres from depth-warm `projectRing` (centroid origin, +X east,
   * +Y north) — NOT raw WGS84 lng/lat. Used for GIS property-line-tags.
   */
  edgeEndpoints: [[number, number], [number, number]];
}

/**
 * GIS-approximate bearing + distance on a boundary edge (never survey-grade).
 * Honesty string must stay machine-checkable (WDLL anti-fabrication).
 */
export interface BoundaryPropertyLineTags {
  bearing: string;
  distanceFeet: number;
  provenance: {
    kind: "gis-approximate";
    honesty: string;
    source: string;
  };
}

export interface ContractBoundaryEdgeAtomInstance {
  entityType: "property-boundary-edge";
  atomDid: string;
  boundaryEdgeId: string;
  parcelNodeId: string;
  countyFips: string;
  propId: string;
  edgeIndex: number;
  role: "front" | "side" | "rear" | "side_corner";
  adjacencyKind: BoundaryAdjacencyKind;
  parcelNeighborPropId: string | null;
  facingRoad: BoundaryFacingRoad | null;
  setback: BoundaryResolvedSetback | BoundarySetbackAbsence;
  interior: BoundaryInteriorFrame;
  /** GIS-approx from ring endpoints; optional until backfill lands. */
  propertyLineTags?: BoundaryPropertyLineTags;
  effectiveDate: string;
  status: "active" | "retired";
  supersedesEntityId: string | null;
  reasoningChain: { reasoningKind: "observed" };
  accessPolicy: AccessPolicy;
  sourceCitation: string;
  extractedAt: string;
  asOf?: string;
  atomTier: "data";
  readContract?: ReasoningReadContract;
}

export type BoundaryEntityType = "property-boundary-edge";

export const BOUNDARY_ENTITY_TYPES: ReadonlyArray<BoundaryEntityType> = [
  "property-boundary-edge",
];

export interface EngineBoundaryPersistence {
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  status: PropertyAtomStatus;
  versionStamp?: string;
  retiredAt?: string;
  supersedesEntityId?: string | null;
}

export type BoundaryEdgeAtomInstance = ContractBoundaryEdgeAtomInstance &
  EngineBoundaryPersistence;

export function boundaryEdgeIdFromParts(
  countyFips: string,
  propId: string,
  edgeIndex: number,
): string {
  return `${countyFips}:${propId}:boundary:${edgeIndex}`;
}

export function isBoundaryEntityType(value: string): value is BoundaryEntityType {
  return (BOUNDARY_ENTITY_TYPES as ReadonlyArray<string>).includes(value);
}

export function isBoundaryEdgeAtomInstance(
  body: unknown,
): body is BoundaryEdgeAtomInstance {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<BoundaryEdgeAtomInstance>;
  return (
    candidate.entityType === "property-boundary-edge" &&
    typeof candidate.boundaryEdgeId === "string" &&
    BOUNDARY_EDGE_ID_PATTERN.test(candidate.boundaryEdgeId) &&
    typeof candidate.parcelNodeId === "string" &&
    (typeof candidate.atomDid === "string" || typeof candidate.entityId === "string")
  );
}
