/**
 * `special-district-fact` writer SEAM.
 *
 * BINARY MEMBERSHIP ONLY: point-in-polygon against TCEQ water-district
 * boundaries. Do NOT add proximity, buffer, or adjacency semantics — a parcel
 * beside a MUD is NOT in the MUD, and implying otherwise is a false tax claim.
 *
 * Scoped absence when no polygon intersects — NOT a statewide negative.
 */

import {
  countyCoverageParcelNodeId,
  createSpecialDistrictFact,
  type SpecialDistrictAbsence,
  type SpecialDistrictTaxRate,
} from "@empressaio/atom-contract/property";

import {
  factClaimContentHash,
  specialDistrictFactAtomDid,
} from "./fact-writer-ids.js";
import type {
  EnginePropertyPersistence,
  SpecialDistrictFactAtomInstance,
} from "./property-instances.js";
import type { PropertyFactWriteProvenance } from "./cad-parcel-roll-writer.js";

export type { PropertyFactWriteProvenance };

/** Phrases that must never appear in absence copy (statewide false negatives). */
export const BANNED_STATEWIDE_ABSENCE_PHRASES = [
  "no special district",
  "not in a mud",
  "not in any mud",
  "not in any special district",
  "statewide",
  "no district",
] as const;

export function assertAbsenceReasonIsScoped(reason: string): void {
  const lower = reason.toLowerCase();
  for (const phrase of BANNED_STATEWIDE_ABSENCE_PHRASES) {
    if (lower.includes(phrase)) {
      throw new Error(
        `absence reason contains banned statewide-negative phrase: ${phrase}`,
      );
    }
  }
}

export function buildOutsideSourceAbsenceReason(countyFips: string): string {
  return (
    `Parcel centroid in county ${countyFips} does not intersect any polygon in ` +
    `tx_special_district (TCEQ Public/WaterDistricts MapServer/0). ` +
    `Finding is scoped to that source only; Comptroller registry omissions, ESD, PID, ` +
    `and other district types outside this layer may still apply.`
  );
}

export interface PresentSpecialDistrictFactObservation {
  parcelNodeId: string;
  districtName: string;
  districtId: string;
  districtType: string;
  countyFips: string;
  taxRate?: SpecialDistrictTaxRate;
  asOf?: string;
}

export interface SpecialDistrictFactAbsenceObservation {
  parcelNodeId: string;
  absenceKind: SpecialDistrictAbsence["kind"];
  reason: string;
  asOf?: string;
}

export interface CountySpecialDistrictCoverageAbsenceObservation {
  countyFips: string;
  provenanceScope: ReadonlyArray<string>;
  asOf?: string;
}

function entityIdForPresent(
  parcelNodeId: string,
  districtId: string,
): string {
  return `${parcelNodeId}:sd:${districtId}`;
}

function entityIdForOutside(parcelNodeId: string): string {
  return `${parcelNodeId}:sd:outside`;
}

function persistenceOf(
  entityId: string,
  provenance: PropertyFactWriteProvenance,
  observedAt: string,
): EnginePropertyPersistence {
  return {
    entityId,
    jurisdictionTenant: provenance.jurisdictionTenant,
    fetchedAt: observedAt,
    sourceAdapter: provenance.sourceAdapter,
    sourceUrl: provenance.sourceUrl,
    contentHash: provenance.contentHash,
    status: "active",
  };
}

export function specialDistrictFactClaimContentHash(parts: {
  parcelNodeId: string;
  sourceTier: string;
  districtId?: string | null;
  districtType?: string | null;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.sourceTier,
    parts.districtId ?? null,
    parts.districtType ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
  ]);
}

export function buildPresentSpecialDistrictFactAtom(
  observation: PresentSpecialDistrictFactObservation,
  provenance: PropertyFactWriteProvenance,
): SpecialDistrictFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const atomDid = specialDistrictFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    districtId: observation.districtId,
  });

  const contractAtom = createSpecialDistrictFact({
    entityType: "special-district-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "tceq-water-districts",
    districtName: observation.districtName,
    districtId: observation.districtId,
    districtType: observation.districtType,
    countyFips: observation.countyFips,
    membershipBasis: "point-in-polygon",
    ...(observation.taxRate ? { taxRate: observation.taxRate } : {}),
    accessPolicy: "public-free",
    sourceCitation: provenance.sourceCitation,
    extractedAt: observedAt,
    ...(observation.asOf ? { asOf: observation.asOf } : {}),
    ...(provenance.sourceVintage
      ? { sourceVintage: provenance.sourceVintage }
      : {}),
    verificationStatus: provenance.verificationStatus ?? "machine",
    sourceAdapter: provenance.sourceAdapter,
    evaluatedAt: observedAt,
    atomTier: "data",
  });

  return {
    ...contractAtom,
    ...persistenceOf(
      entityIdForPresent(observation.parcelNodeId, observation.districtId),
      provenance,
      observedAt,
    ),
  };
}

export function buildSpecialDistrictFactAbsenceAtom(
  observation: SpecialDistrictFactAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): SpecialDistrictFactAtomInstance {
  assertAbsenceReasonIsScoped(observation.reason);
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const atomDid = specialDistrictFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    districtId: "outside",
  });

  const contractAtom = createSpecialDistrictFact({
    entityType: "special-district-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "tceq-water-districts",
    absence: {
      kind: observation.absenceKind,
      reason: observation.reason,
    },
    accessPolicy: "public-free",
    sourceCitation: provenance.sourceCitation,
    extractedAt: observedAt,
    ...(observation.asOf ? { asOf: observation.asOf } : {}),
    ...(provenance.sourceVintage
      ? { sourceVintage: provenance.sourceVintage }
      : {}),
    verificationStatus: provenance.verificationStatus ?? "machine",
    sourceAdapter: provenance.sourceAdapter,
    evaluatedAt: observedAt,
    atomTier: "data",
  });

  return {
    ...contractAtom,
    ...persistenceOf(
      entityIdForOutside(observation.parcelNodeId),
      provenance,
      observedAt,
    ),
  };
}

export function buildCountySpecialDistrictCoverageAbsenceAtom(
  observation: CountySpecialDistrictCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): SpecialDistrictFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);
  const atomDid = specialDistrictFactAtomDid({
    parcelNodeId,
    districtId: "_county_coverage",
  });

  const contractAtom = createSpecialDistrictFact({
    entityType: "special-district-fact",
    atomDid,
    parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "absent",
    verifiedAbsence: {
      evaluated: true,
      provenanceScope: [...observation.provenanceScope],
    },
    accessPolicy: "public-free",
    sourceCitation: provenance.sourceCitation,
    extractedAt: observedAt,
    ...(observation.asOf ? { asOf: observation.asOf } : {}),
    ...(provenance.sourceVintage
      ? { sourceVintage: provenance.sourceVintage }
      : {}),
    verificationStatus: provenance.verificationStatus ?? "machine",
    sourceAdapter: provenance.sourceAdapter,
    evaluatedAt: observedAt,
    atomTier: "data",
  });

  return {
    ...contractAtom,
    ...persistenceOf(parcelNodeId, provenance, observedAt),
  };
}
