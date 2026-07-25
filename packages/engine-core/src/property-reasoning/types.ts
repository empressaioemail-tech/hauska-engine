/**
 * Jurisdiction descriptor + parcel observation inputs (config only).
 *
 * Jurisdiction-specific values live ONLY in descriptor fixtures and adapter
 * data — never in reasoning modules (WDLL 3.8 / I-B).
 */

import type { AtomInputRef } from "@empressaio/atom-contract/property";
import type { WidthedConfidence } from "@empressaio/atom-contract/read-contract";
import type {
  AccessPolicy,
  MatchBasis,
  RoadClassification,
  SetbackDimensions,
} from "@hauska-engine/atoms";
import type { AssumedRowWidthTable } from "../road-intake/types.js";

/** Edge role keyed in the road-class setback table (27c WDLL 4). */
export type RoadEdgeRole = "front" | "side" | "rear" | "side_corner";

/** Per-field provenance carried in setback table JSON (fan gift). */
export interface SetbackFieldProvenance {
  value: number;
  confidence: number;
  verification_state?: "human-verified" | "transcribed" | "unverified";
  /**
   * True when the code is SILENT on this scalar (build-to-line / stories /
   * blank column). Value is typically 0 as a sentinel — never treat as a
   * real zero-foot setback.
   */
  not_specified?: boolean;
}

export interface SetbackTableRowProvenance {
  atom_did: string;
  match_basis: MatchBasis;
  district_code: string;
  prefix_matched?: string;
  front_ft?: SetbackFieldProvenance;
  rear_ft?: SetbackFieldProvenance;
  side_ft?: SetbackFieldProvenance;
  side_corner_ft?: SetbackFieldProvenance;
  max_height_ft?: SetbackFieldProvenance;
  max_lot_coverage_pct?: SetbackFieldProvenance;
  max_impervious_pct?: SetbackFieldProvenance;
}

export interface SetbackTableDescriptor {
  rows: ReadonlyArray<SetbackTableRowProvenance>;
}

/** One (road-class, edge-role) cell in the jurisdiction descriptor (27c R2). */
export interface RoadClassSetbackEntry {
  road_class: RoadClassification;
  edge_role: RoadEdgeRole;
  setback_ft: SetbackFieldProvenance;
}

export interface RoadClassSetbackRowProvenance {
  atom_did: string;
  match_basis: MatchBasis;
  district_code: string;
  prefix_matched?: string;
  entries: ReadonlyArray<RoadClassSetbackEntry>;
}

export interface RoadClassSetbackTableDescriptor {
  rows: ReadonlyArray<RoadClassSetbackRowProvenance>;
}

export interface JurisdictionDescriptor {
  key: string;
  displayName: string;
  jurisdictionTenant: string;
  /** FIPS prefix for parcel nodes `{fips}:{propId}`. */
  parcelFips: string;
  defaultAccessPolicy: AccessPolicy;
  setbackTable?: SetbackTableDescriptor;
  /** Indexed by (road-class, edge-role); jurisdiction knowledge only. */
  roadClassSetbackTable?: RoadClassSetbackTableDescriptor;
  /** v1 assumed ROW width by road class (feet). */
  assumedRowWidthFt?: AssumedRowWidthTable;
  sourceAdapter: string;
  sourceUrl: string;
}

export interface ParcelZoningObservation {
  parcelNodeId: string;
  /** Null or empty => honest-absence atom with absence.kind no-zoning-stamp. */
  districtCode: string | null;
  districtLabel?: string;
  matchBasis: MatchBasis;
  prefixMatched?: string;
  sourceCitation: string;
  extractedAt: string;
  /** Optional overlay key override; defaults to parcelNodeId zoning atom id. */
  calibrationAtomId?: string;
}

export interface HonestAbsence {
  kind: "honest-absence";
  parcelNodeId: string;
  reason: string;
  code: string;
}

export interface EmitBuildableEnvelopeInputs {
  descriptor: JurisdictionDescriptor;
  parcelNodeId: string;
  zoningFactAtomDid: string;
  setbackRuleAtomDid: string;
  geometryRefId: string;
  frontEdgeRefId: string;
  outcome: import("@hauska-engine/atoms").EnvelopeHonestOutcome;
  inputAssertedConfidences: ReadonlyArray<WidthedConfidence>;
  sourceCitation: string;
  extractedAt: string;
  version?: number;
}

export interface ResolvedSetbackRow {
  districtCode: string;
  matchBasis: MatchBasis;
  prefixMatched?: string;
  setbacks: SetbackDimensions;
  /** Typed AtomInputRef with required role (rule|fact) — never a bare string. */
  sourceCodeAtomRef: AtomInputRef;
  fieldConfidence: Readonly<Record<keyof SetbackDimensions, WidthedConfidence>>;
}
