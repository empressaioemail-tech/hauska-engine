/**
 * Road node atom instances (27c WDLL 3 / R1).
 *
 * Vendored from @empressaio/atom-contract 1.11.0 road-node export until
 * the package is published; remove this alias when ^1.11.0 is on npm.
 */

import type { AccessPolicy } from "@empressaio/atom-contract";
import type { ReasoningReadContract } from "@empressaio/atom-contract/read-contract";

import type { PropertyAtomStatus } from "./property-instances.js";

export type RoadClassification =
  | "highway"
  | "major_collector"
  | "minor_collector"
  | "residential"
  | "alley"
  | "gravel"
  | "unclassified";

export const ROAD_CLASSIFICATION_VALUES: ReadonlyArray<RoadClassification> = [
  "highway",
  "major_collector",
  "minor_collector",
  "residential",
  "alley",
  "gravel",
  "unclassified",
];

export type GeoCoord = readonly [number, number];

export interface RoadCenterline {
  type: "LineString";
  coordinates: ReadonlyArray<GeoCoord>;
}

export interface RowProvenance {
  kind: "approximate-assumed-per-class";
  assumedWidthTableKey: string;
  osmHighwayTag: string;
  note?: string;
}

export interface RoadRow {
  assumedWidthFt: number;
  provenance: RowProvenance;
  leftEdge: RoadCenterline;
  rightEdge: RoadCenterline;
}

export interface RoadAttachPoint {
  kind: "infra-slot";
  refKey: string;
  position: GeoCoord;
  note?: string;
}

export interface ContractRoadNodeAtomInstance {
  entityType: "road-node";
  atomDid: string;
  roadNodeId: string;
  displayName?: string;
  countyFips: string;
  osmWayId: number;
  classification: RoadClassification;
  centerline: RoadCenterline;
  row: RoadRow;
  attachPoints: ReadonlyArray<RoadAttachPoint>;
  reasoningChain: { reasoningKind: "observed" };
  accessPolicy: AccessPolicy;
  sourceCitation: string;
  extractedAt: string;
  asOf?: string;
  atomTier: "data";
  readContract?: ReasoningReadContract;
}

export type RoadEntityType = "road-node";

export const ROAD_ENTITY_TYPES: ReadonlyArray<RoadEntityType> = ["road-node"];

export const ROAD_NODE_ID_PATTERN = /^\d{5}:road:\d+$/;

export function roadNodeIdFromParts(countyFips: string, osmWayId: number): string {
  return `${countyFips}:road:${osmWayId}`;
}

export interface EngineRoadPersistence {
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  status: PropertyAtomStatus;
  versionStamp?: string;
  retiredAt?: string;
}

export type RoadNodeAtomInstance = ContractRoadNodeAtomInstance & EngineRoadPersistence;

export function isRoadEntityType(value: string): value is RoadEntityType {
  return (ROAD_ENTITY_TYPES as ReadonlyArray<string>).includes(value);
}

export function isRoadNodeAtomInstance(body: unknown): body is RoadNodeAtomInstance {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<RoadNodeAtomInstance>;
  return (
    candidate.entityType === "road-node" &&
    typeof candidate.roadNodeId === "string" &&
    ROAD_NODE_ID_PATTERN.test(candidate.roadNodeId) &&
    (typeof candidate.atomDid === "string" || typeof candidate.entityId === "string")
  );
}
