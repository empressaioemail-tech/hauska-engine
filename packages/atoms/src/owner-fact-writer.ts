/**
 * `owner-fact` writer SEAM.
 *
 * THE ONE PAID PROPERTY ATOM. Every sibling writer emits `public-free`; this
 * one emits `public-paid` because owner identity was ruled the paid facet at
 * the atom level. The contract schema rejects any other policy, so a writer
 * cannot leak owner identity onto the free tier even by mistake.
 *
 * Source is the CAD roll only — `cad_property.owner_name` /
 * `owner_mailing_address` / `exemption_codes`. Cotality is extinguished.
 *
 * `entityId` is `${parcelNodeId}:${taxYear}`, matching cad-parcel-roll and
 * land-use-fact so all three CAD-derived facts share one identity discipline.
 *
 * EXEMPTION CODES NEVER LEAVE THIS SEAM. `deriveExemptionFlags` reduces raw
 * CAD exemption codes to four booleans before they reach an atom. Homestead
 * and over-65 codes imply occupancy and household composition; the flag
 * answers the underwriting question without republishing the implication.
 */

import {
  countyCoverageParcelNodeId,
  createOwnerFact,
  type OwnerExemptionFlags,
  type OwnerFactAbsence,
} from "@empressaio/atom-contract/property";

import { factClaimContentHash, ownerFactAtomDid } from "./fact-writer-ids.js";
import { finalizeParcelFactAtom } from "./parcel-write-identity.js";
import type {
  EnginePropertyPersistence,
  OwnerFactAtomInstance,
} from "./property-instances.js";
import type { PropertyFactWriteProvenance } from "./cad-parcel-roll-writer.js";

export type { PropertyFactWriteProvenance };

export interface PresentOwnerFactObservation {
  parcelNodeId: string;
  taxYear: number;
  ownerName: string;
  ownerMailingAddress?: string;
  exemptionFlags?: OwnerExemptionFlags;
  asOf?: string;
}

export interface OwnerFactAbsenceObservation {
  parcelNodeId: string;
  taxYear: number;
  absenceKind: OwnerFactAbsence["kind"];
  reason: string;
  asOf?: string;
}

export interface CountyOwnerCoverageAbsenceObservation {
  countyFips: string;
  taxYear: number;
  provenanceScope: ReadonlyArray<string>;
  asOf?: string;
}

/**
 * Texas CAD exemption-code prefixes, reduced to flags.
 *
 * Deliberately prefix-matched rather than exact-matched: appraisal districts
 * emit local variants (`HS`, `HB`, `HS1`, `DV1`-`DV4`, `OV65`, `O65`), and an
 * exact-match table would silently drop a variant and under-report the flag.
 * A false negative here reads as "no homestead", which is a factual claim we
 * would be getting wrong, so the match is deliberately generous.
 */
export function deriveExemptionFlags(
  exemptionCodes: ReadonlyArray<string> | null | undefined,
): OwnerExemptionFlags | undefined {
  if (!exemptionCodes || exemptionCodes.length === 0) return undefined;

  const codes = exemptionCodes
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length > 0);

  if (codes.length === 0) return undefined;

  const has = (...prefixes: string[]): boolean =>
    codes.some((code) => prefixes.some((p) => code.startsWith(p)));

  return {
    homestead: has("HS", "HB", "HT"),
    seniorOrDisability: has("OV65", "O65", "DP", "DI"),
    agricultural: has("AG", "1D", "OS", "TIM", "WL"),
    veteran: has("DV", "VET"),
  };
}

function entityIdOf(parcelNodeId: string, taxYear: number): string {
  return `${parcelNodeId}:${taxYear}`;
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

export function ownerFactClaimContentHash(parts: {
  parcelNodeId: string;
  taxYear: number;
  sourceTier: string;
  ownerName?: string | null;
  ownerMailingAddress?: string | null;
  exemptionFlags?: OwnerExemptionFlags | null;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.taxYear,
    parts.sourceTier,
    parts.ownerName ?? null,
    parts.ownerMailingAddress ?? null,
    parts.exemptionFlags
      ? [
          parts.exemptionFlags.homestead,
          parts.exemptionFlags.seniorOrDisability,
          parts.exemptionFlags.agricultural,
          parts.exemptionFlags.veteran,
        ]
      : null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
  ]);
}

export function buildPresentOwnerFactAtom(
  observation: PresentOwnerFactObservation,
  provenance: PropertyFactWriteProvenance,
): OwnerFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const atomDid = ownerFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    taxYear: observation.taxYear,
  });

  const contractAtom = createOwnerFact({
    entityType: "owner-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    taxYear: observation.taxYear,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "cad-authoritative",
    ownerName: observation.ownerName,
    ...(observation.ownerMailingAddress
      ? { ownerMailingAddress: observation.ownerMailingAddress }
      : {}),
    ...(observation.exemptionFlags
      ? { exemptionFlags: observation.exemptionFlags }
      : {}),
    accessPolicy: "public-paid",
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

  return finalizeParcelFactAtom(
    {
      ...contractAtom,
      ...persistenceOf(
        entityIdOf(observation.parcelNodeId, observation.taxYear),
        provenance,
        observedAt,
      ),
    },
    [String(observation.taxYear)],
  );
}

export function buildOwnerFactAbsenceAtom(
  observation: OwnerFactAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): OwnerFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const atomDid = ownerFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    taxYear: observation.taxYear,
  });

  const contractAtom = createOwnerFact({
    entityType: "owner-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    taxYear: observation.taxYear,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "cad-authoritative",
    absence: {
      kind: observation.absenceKind,
      reason: observation.reason,
    },
    accessPolicy: "public-paid",
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

  return finalizeParcelFactAtom(
    {
      ...contractAtom,
      ...persistenceOf(
        entityIdOf(observation.parcelNodeId, observation.taxYear),
        provenance,
        observedAt,
      ),
    },
    [String(observation.taxYear)],
  );
}

export function buildCountyOwnerCoverageAbsenceAtom(
  observation: CountyOwnerCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): OwnerFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);
  const atomDid = ownerFactAtomDid({
    parcelNodeId,
    taxYear: observation.taxYear,
  });

  const contractAtom = createOwnerFact({
    entityType: "owner-fact",
    atomDid,
    parcelNodeId,
    taxYear: observation.taxYear,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "absent",
    verifiedAbsence: {
      evaluated: true,
      provenanceScope: [...observation.provenanceScope],
    },
    accessPolicy: "public-paid",
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
      entityIdOf(parcelNodeId, observation.taxYear),
      provenance,
      observedAt,
    ),
  };
}
