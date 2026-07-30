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

/** Edge role for setback axis lookup (front/side/rear/corner). */
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

/** R22/R24/R25/R26 — full-field + disclosure metadata carried on a setback row. */
export interface SetbackRowDisplayMeta {
  min_lot_size?: string;
  side_fire_code_deferral?: boolean;
  side_city_language?: string;
  resolved_district_code?: string | null;
  split_zone_minor_zones?: Array<{ district_code: string | null; shape_area?: number }>;
  second_source?: { source: string; note: string; citation_url?: string };
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
  /** R22/R24/R25/R26 — surfaced on the emitted atom for the PE card. */
  display_meta?: SetbackRowDisplayMeta;
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
  /** Authoritative setback VALUE source (district → front/side/rear/corner). */
  setbackTable?: SetbackTableDescriptor;
  /**
   * DEPRECATED as a setback-VALUE source (WDLL 7 / RULING 2, 2026-07-29).
   * Resolvers ignore this table. Roads remain a twin for edge ROLE / frontage /
   * rendering only. Kept optional for legacy fixture archaeology.
   */
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
  /**
   * Optional reasoning-chain override. Defaults to `{ reasoningKind: "observed" }`.
   * COMPLETE-BASTROP A1 may attach a TRANSFORM step documenting the breadth
   * bake (bake is not the district origin).
   */
  reasoningChain?: {
    reasoningKind: "observed";
    transformSteps?: ReadonlyArray<{
      kind: "TRANSFORM";
      adapter: string;
      sourceUrl?: string;
      note?: string;
    }>;
  };
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
