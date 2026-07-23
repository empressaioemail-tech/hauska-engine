/**
 * Property reasoning atom instances (Gate C / Phase 1c).
 *
 * Contract shapes come from `@empressaio/atom-contract/property` (1.9.0+).
 * Engine persistence fields (`entityId`, `contentHash`, `status`, …) layer on
 * top so StoragePort + MCP `AtomInstanceBase` stay compatible. Do not invent
 * a parallel SourceAttribution type — obligations reuse actor-record +
 * ObligationAtomInstance from the contract.
 */

import type {
  BuildableEnvelopeAtomInstance as ContractBuildableEnvelopeAtomInstance,
  SetbackMatchBasis,
  SetbackRuleAtomInstance as ContractSetbackRuleAtomInstance,
  ZoningFactAtomInstance as ContractZoningFactAtomInstance,
} from "@empressaio/atom-contract/property";

import type { CodeAtomInstance } from "./instances.js";

export type {
  ZoningAbsence,
  SetbackAbsence,
  SetbackMatchBasis,
  SetbackFieldProvenance,
  SetbackFieldProvenanceEntry,
  ZoningFactAtomInstance as ContractZoningFactAtomInstance,
  SetbackRuleAtomInstance as ContractSetbackRuleAtomInstance,
  BuildableEnvelopeAtomInstance as ContractBuildableEnvelopeAtomInstance,
} from "@empressaio/atom-contract/property";

export {
  ZONING_ABSENCE_KIND,
  SETBACK_ABSENCE_KIND,
  SETBACK_MATCH_BASIS_VALUES,
  PROPERTY_ATOM_TIER,
  PROPERTY_DEFAULT_ACCESS_POLICY,
  BUILDABLE_ENVELOPE_DERIVATION_METHOD,
  createZoningFact,
  createSetbackRule,
  createBuildableEnvelope,
} from "@empressaio/atom-contract/property";

export type PropertyEntityType =
  | "zoning-fact"
  | "setback-rule"
  | "buildable-envelope";

export const PROPERTY_ENTITY_TYPES: ReadonlyArray<PropertyEntityType> = [
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
];

export type PropertyAtomStatus = "active" | "retired";

/** Alias kept for emitter call sites. */
export type MatchBasis = SetbackMatchBasis;

/**
 * Engine + MCP persistence fields layered on the contract property payload.
 * Canonical active `entityId` is the parcel node id (MCP
 * `did:hauska:<entityType>:<parcelNodeId>`).
 */
export interface EnginePropertyPersistence {
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  status: PropertyAtomStatus;
  versionStamp?: string;
  retiredAt?: string;
  supersedesEntityId?: string;
}

/** Optional envelope geometry outcome (engine extension; not a confidence multiply). */
export type EnvelopeHonestOutcome =
  | { kind: "buildable"; areaSqFt: number }
  | { kind: "no-buildable-area"; reason: string }
  | { kind: "provisional-front-edge"; reason: string };

/** Dimensional helper used by setback table resolution (maps to contract front/side/rear). */
export interface SetbackDimensions {
  frontFt: number;
  rearFt: number;
  sideFt: number;
  sideCornerFt: number;
  maxHeightFt?: number;
  maxLotCoveragePct?: number;
  maxImperviousPct?: number;
}

export type ZoningFactAtomInstance = ContractZoningFactAtomInstance &
  EnginePropertyPersistence & {
    districtLabel?: string;
    matchBasis?: MatchBasis;
    prefixMatched?: string;
  };

export type SetbackRuleAtomInstance = ContractSetbackRuleAtomInstance &
  EnginePropertyPersistence & {
    districtCode?: string;
    prefixMatched?: string;
    sideCornerFt?: number;
    maxHeightFt?: number;
    maxLotCoveragePct?: number;
    maxImperviousPct?: number;
  };

export type BuildableEnvelopeAtomInstance = ContractBuildableEnvelopeAtomInstance &
  EnginePropertyPersistence & {
    outcome?: EnvelopeHonestOutcome;
  };

export type PropertyAtomInstance =
  | ZoningFactAtomInstance
  | SetbackRuleAtomInstance
  | BuildableEnvelopeAtomInstance;

export function isPropertyEntityType(
  value: string,
): value is PropertyEntityType {
  return (PROPERTY_ENTITY_TYPES as ReadonlyArray<string>).includes(value);
}

export function isPropertyAtomInstance(
  body: unknown,
): body is PropertyAtomInstance {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<PropertyAtomInstance>;
  return (
    typeof candidate.entityType === "string" &&
    isPropertyEntityType(candidate.entityType) &&
    typeof candidate.parcelNodeId === "string" &&
    (typeof candidate.atomDid === "string" ||
      typeof candidate.entityId === "string")
  );
}

export type StoredAtomInstance = CodeAtomInstance | PropertyAtomInstance;
