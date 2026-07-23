/**
 * Property reasoning atom instance shapes (Phase 1b).
 *
 * Mirrors Gate B / pending @empressaio/atom-contract@1.9.0 property kinds.
 * TODO: replace local mirrors with contract exports when 1.9.0 publishes.
 */

import type {
  AtomInputRef,
  ReasoningChain,
} from "@empressaio/atom-contract/reasoning";
import type {
  PropertyConsequence,
  ReasoningThreeAxisConfidence,
  WidthedConfidence,
} from "@empressaio/atom-contract/read-contract";

import type { AccessPolicy } from "@hauska-engine/atom-contract-pin";

import type { CodeAtomInstance } from "./instances.js";

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

export type MatchBasis = "exact" | "prefix" | "fallback";

/** Typed citation to a code-section atom (not a bare string). */
export interface SourceCodeAtomRef {
  atomDid: string;
  entityType: "code-section";
  sectionNumber?: string;
  editionId?: string;
}

export interface PropertyAtomBase {
  entityType: PropertyEntityType;
  entityId: string;
  jurisdictionTenant: string;
  /** Parcel node `{fips}:{propId}` — invariant anchor for calibration overlay. */
  parcelNodeId: string;
  fetchedAt: string;
  extractedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  sourceCitation: string;
  contentHash: string;
  accessPolicy: AccessPolicy;
  atomTier: "data";
  status: PropertyAtomStatus;
  versionStamp: string;
  reasoningChain: ReasoningChain;
  readAxes: ReasoningThreeAxisConfidence;
  retiredAt?: string;
  supersedesEntityId?: string;
}

export interface ZoningFactAtomInstance extends PropertyAtomBase {
  entityType: "zoning-fact";
  districtCode: string;
  districtLabel?: string;
  matchBasis: MatchBasis;
  prefixMatched?: string;
}

export interface SetbackDimensions {
  frontFt: number;
  rearFt: number;
  sideFt: number;
  sideCornerFt: number;
  maxHeightFt?: number;
  maxLotCoveragePct?: number;
  maxImperviousPct?: number;
}

export interface SetbackRuleAtomInstance extends PropertyAtomBase {
  entityType: "setback-rule";
  districtCode: string;
  matchBasis: MatchBasis;
  prefixMatched?: string;
  setbacks: SetbackDimensions;
  sourceCodeAtomRef: SourceCodeAtomRef;
  /** Per-field confidence consumed from setback JSON provenance. */
  fieldConfidence: Readonly<Record<keyof SetbackDimensions, WidthedConfidence>>;
}

export type EnvelopeHonestOutcome =
  | { kind: "buildable"; areaSqFt: number }
  | { kind: "no-buildable-area"; reason: string }
  | { kind: "provisional-front-edge"; reason: string };

export interface BuildableEnvelopeAtomInstance extends PropertyAtomBase {
  entityType: "buildable-envelope";
  derivationMethod: string;
  inputAtomRefs: ReadonlyArray<AtomInputRef>;
  outcome: EnvelopeHonestOutcome;
}

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
    typeof candidate.entityId === "string" &&
    typeof candidate.parcelNodeId === "string"
  );
}

export type StoredAtomInstance = CodeAtomInstance | PropertyAtomInstance;
