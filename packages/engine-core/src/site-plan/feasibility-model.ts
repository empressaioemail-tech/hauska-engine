import type { DischargePointResolver, NamedDischargePoint } from "./discharge-point.js";

/**
 * Per-section fact TYPES shared across every report product (P-32 wave 1,
 * carried forward into the P-120 reports re-cut).
 *
 * The COMPOSITION that fills these in used to live here as
 * `composeFeasibilityModel` / `FeasibilityModel` — Feasibility was the only
 * caller. It has been promoted to `report-model.ts`'s `composeParcelReport`
 * / `ParcelReportModel` (2026-09-07, R1), which every report product reads
 * from, so a second product never re-derives (and disagrees with) the same
 * fact. This file keeps exactly the parts that were never feasibility-
 * specific: the per-section shapes and the present/absent helper.
 *
 * Every section is `FeasibilityFactState<T>`: present-with-citation or
 * absent-with-reason. Nothing here is guessed or defaulted — an atom that
 * does not exist for a parcel produces `status: "absent"`, never a zero or
 * an empty string standing in for unknown (ENFORCEMENT.md fail-closed).
 */

/** One typed fact slot: present (with the value + provenance) or a named
 * absence. The generic keeps ~12 sections from repeating this shape by hand
 * while staying a real discriminated union (not a generic Maybe<T>). */
export type FeasibilityFactState<T> =
  | ({ status: "present"; sourceCitation?: string; asOfIso?: string; consequence?: string } & T)
  | { status: "absent"; kind: AbsenceKind; reason: string; consequence?: string };

/**
 * WHICH KIND OF NOTHING was found (P-120 content revision, R-04).
 *
 * The previous two-state union flattened five genuinely different situations
 * into one gray UNAVAILABLE chip, which is why a thoroughly-checked parcel
 * read as a mostly-empty report. Same facts, same honesty, wrong impression:
 * a refusal to guess looked identical to a broken pipeline.
 *
 * This is a TYPE rather than a rendering convention on purpose. If the five
 * live only in the renderer they drift, and this repo has watched exactly that
 * happen. Making `kind` required means the compiler asks every producer which
 * kind of nothing it found, at every call site, and a new producer cannot skip
 * the question.
 *
 * - `clear`             checked against a source that covers this parcel, and
 *                       the answer is GOOD NEWS. No MUD, no special
 *                       assessment. This is a finding, not a gap, and it is
 *                       the one that changes how the document reads.
 * - `not-applicable`    the field cannot apply to this parcel (year built on
 *                       vacant land).
 * - `out-of-scope`      a scope decision rather than a gap. Says what it would
 *                       take, and is a sales conversation, not a defect.
 * - `blocked-at-source` the source genuinely does not publish it, or does not
 *                       cover this parcel. Authoritative to say so.
 * - `failed-this-run`   a system gap. Never dress this as any of the above;
 *                       it is the only one that means WE failed, and it is
 *                       the one that must never quietly read as "clear".
 *
 * `clear` and `blocked-at-source` are the pair most easily confused, and the
 * test is coverage: only claim `clear` when the source actually covers this
 * parcel. "We looked everywhere and found none" is clear; "no row came back
 * from a source with partial coverage" is blocked-at-source.
 */
export type AbsenceKind =
  | "clear"
  | "not-applicable"
  | "out-of-scope"
  | "blocked-at-source"
  | "failed-this-run";

export function present<T extends object>(
  value: T,
  provenance?: { sourceCitation?: string; asOfIso?: string; consequence?: string },
): FeasibilityFactState<T> {
  return { status: "present", ...provenance, ...value };
}

/**
 * `kind` is REQUIRED and deliberately first: it is the question the caller
 * must answer, not an option they may pass. `consequence` says what the
 * absence MEANS for the reader, because a fact without a consequence is data
 * and a fact with one is a deliverable.
 */
export function absent<T extends object>(
  kind: AbsenceKind,
  reason: string,
  consequence?: string,
): FeasibilityFactState<T> {
  return { status: "absent", kind, reason, ...(consequence ? { consequence } : {}) };
}

// ── Section 3: location and jurisdiction ────────────────────────────────
export interface JurisdictionFacts {
  countyFips: string | null;
  countyName?: string;
  /** No city-limits or ETJ atom type exists in this engine today (gap matrix
   * row 35: no adapter). Always the honest three-state "unresolved" per the
   * approved spec — never fabricated, never silently omitted. */
  cityLimitsStatus: "unresolved";
  etjStatus: "unresolved";
}

// ── Section 4: parcel and ownership ─────────────────────────────────────
export interface ParcelOwnershipFacts {
  legalDescription?: string;
  exemptionCodes?: ReadonlyArray<string>;
  marketValue?: number;
  assessedValue?: number;
  landValue?: number;
  improvementValue?: number;
  yearBuilt?: number;
  livingAreaSqft?: number;
  ownerName?: string;
  ownerMailingAddress?: string;
  /** Derived, never fabricated: present only when both situs and mailing
   * address are on file and differ. */
  absenteeOwner?: boolean;
  landUseCode?: string;
  landUseLabel?: string;
}

// ── Section 6: flood (screening fact) ───────────────────────────────────
// The real parcel-scoped drainage study is a SIBLING top-level model field
// (`ParcelReportModel.drainage` in report-model.ts), never a boolean here.
// R3 (2026-09-07): this interface previously carried `studyAvailable` and
// `supersedesScreeningFact`, both driven by a caller-supplied
// `floodStudyAvailable` boolean nothing ever checked. Removing the fields is
// the whole control — a caller cannot reintroduce a fake "on file" claim
// because there is no field left to carry one. Whether the real study
// supersedes this screening fact is derived where needed by comparing
// `ParcelReportModel.drainage.status` directly against this section, never
// stored redundantly on either side.
export interface FloodFacts {
  inSpecialFloodHazardArea: boolean;
  floodZone?: string | null;
  baseFloodElevation?: number | null;
}

// ── item 19: named downstream discharge point ───────────────────────────
// A separate top-level section, not nested in FloodFacts: its presence
// depends on a flood-drainage-study flow exit and the county-hydrography
// registry, not on flood-hazard-fact atom presence — those are independent
// facts and must be free to disagree on present/absent.
export interface DischargePointFacts {
  point: NamedDischargePoint;
}

// ── Section 7: special districts ────────────────────────────────────────
export interface SpecialDistrictFacts {
  districts: ReadonlyArray<{
    districtName?: string;
    districtType?: string;
  }>;
}

// ── Section 8: wells and pipelines ──────────────────────────────────────
export interface WellsPipelinesFacts {
  wells: ReadonlyArray<{ wellStatus?: string; wellType?: string; orphaned?: boolean }>;
  nearPipeline?: boolean;
  nearestPipelineDistanceMeters?: number;
  pipelineOperatorName?: string;
}

// ── Section 9: terrain and site conditions ──────────────────────────────
export interface TerrainFacts {
  elevationRangeMeters: { min: number; max: number };
  contourIntervalMeters: number;
}

// ── Section 10: utilities who-serves ────────────────────────────────────
export interface UtilityWhoServesFacts {
  holders: ReadonlyArray<{
    serviceKind: "water" | "sewer" | "electric" | "water-district";
    territoryName: string | null;
  }>;
  /** Always carried when measured — a territory holder is never a tap,
   * capacity, or extension commitment. */
  residual: string;
}

/** Injected resolver for the who-serves read — mirrors this codebase's
 * existing pattern for cross-service reads (`ParcelGeometryResolver`,
 * `AerialImageFetcher`): an interface at the boundary, never a direct import
 * of another repo's or another package's read. The assembler must not block
 * on this failing (spec item 8). Originally specified against a cross-repo
 * `legacy-design-tools GET /api/who-serves` endpoint backed by an internal
 * utility-territory table; neither exists (2026-09-09 CTX-FAMILIES CP1), so
 * the live implementation (`who-serves-electric-only.ts`) answers from the
 * one utility type this repo can actually check today. The interface itself
 * is unchanged by that — a future resolver backed by the originally-intended
 * source is a drop-in replacement. */
export interface WhoServesResolver {
  resolve(input: { latitude: number; longitude: number }): Promise<
    | { status: "measured"; holders: UtilityWhoServesFacts["holders"]; residual: string; asOf: string | null }
    /** `kind` defaults to `blocked-at-source` when omitted (the original,
     * sole behavior this resolver interface had) — but a resolver whose
     * underlying read genuinely FAILED this run (a thrown network error, a
     * timeout) must say `failed-this-run` rather than let a live outage
     * misreport as an honest declared absence. */
    | { status: "unmeasured"; basis: string; kind?: AbsenceKind }
  >;
}

// ── Section 11: HOA and recorded restrictions ───────────────────────────
export interface HoaFacts {
  /** Always "not searched" in wave 1 — the P-85/courthouse-easements
   * reconciliation is explicitly open and does not block this shell
   * (`_decisions/2026-09-03_p32_feasibility_unfrozen.md`). */
  searchStatus: "not-searched";
  mountedDocumentCitation?: string;
}

// ── Section 12: existing structures / footprint ─────────────────────────
export interface FootprintFacts {
  footprints: ReadonlyArray<{ footprintId: string; structureRole?: string; sourceTier?: string }>;
}

// ── Section 13/14: data quality + open items (generated, not read) ──────
export interface DataQualityNote {
  supersededNotes: ReadonlyArray<string>;
}

export interface OpenItem {
  section: string;
  actionSentence: string;
}

// Re-exported so a caller resolving a discharge point doesn't need a second
// import path for this boundary type.
export type { DischargePointResolver };
