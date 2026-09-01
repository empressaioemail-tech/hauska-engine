/**
 * `cad-parcel-roll` writer SEAM.
 *
 * Turns an already-resolved CAD observation into a contract-valid
 * `cad-parcel-roll` atom. No acquisition, no database access.
 *
 * Persistence: `entityId` is `${parcelNodeId}:${taxYear}` so StoragePort's
 * `did:hauska:cad-parcel-roll:<entityId>` keys never collide across years.
 * Body `atomDid` stays the contract `cadroll_<16-hex>` form.
 */

import {
  countyCoverageParcelNodeId,
  createCadParcelRoll,
  type CadParcelRollAbsence,
  type ParcelKeyKind,
} from "@empressaio/atom-contract/property";

import {
  cadParcelRollAtomDid,
  factClaimContentHash,
} from "./fact-writer-ids.js";
import { finalizeParcelFactAtom } from "./parcel-write-identity.js";
import type {
  CadParcelRollAtomInstance,
  EnginePropertyPersistence,
} from "./property-instances.js";

export interface PropertyFactWriteProvenance {
  sourceAdapter: string;
  sourceCitation: string;
  sourceUrl: string;
  sourceVintage?: string;
  observedAt?: string;
  jurisdictionTenant: string;
  contentHash: string;
  verificationStatus?: "machine" | "human" | "unsurveyed";
}

export interface PresentCadParcelRollObservation {
  countyFips: string;
  parcelKey: string;
  taxYear: number;
  keyKind: ParcelKeyKind;
  joinPassedOwnerMatchGate: boolean;
  sourceFile: string;
  /** Owner fields live on `owner-fact` (public-paid), never on cad-parcel-roll. */
  situsAddress?: string;
  situsCity?: string;
  situsZip?: string;
  legalDescription?: string;
  exemptionCodes?: ReadonlyArray<string>;
  landValue?: number;
  improvementValue?: number;
  marketValue?: number;
  assessedValue?: number;
  yearBuilt?: number;
  livingAreaSqft?: number;
  landAcres?: string | number;
  propertyUseCode?: string;
  asOf?: string;
}

export interface CadParcelRollAbsenceObservation {
  countyFips: string;
  parcelKey: string;
  taxYear: number;
  keyKind: ParcelKeyKind;
  absenceKind: CadParcelRollAbsence["kind"];
  reason: string;
  sourceFile?: string;
  asOf?: string;
}

export interface CountyCadRollCoverageAbsenceObservation {
  countyFips: string;
  taxYear: number;
  provenanceScope: ReadonlyArray<string>;
  asOf?: string;
}

function parcelNodeIdOf(countyFips: string, parcelKey: string): string {
  return `${countyFips}:${parcelKey}`;
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

/** Claim-only content hash (idempotent across re-runs over unchanged CAD). */
export function cadParcelRollClaimContentHash(parts: {
  parcelNodeId: string;
  taxYear: number;
  sourceTier: string;
  joinPassedOwnerMatchGate: boolean;
  sourceFile?: string;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
  marketValue?: number | null;
  propertyUseCode?: string | null;
  situsAddress?: string | null;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.taxYear,
    parts.sourceTier,
    parts.joinPassedOwnerMatchGate,
    parts.sourceFile ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
    parts.marketValue ?? null,
    parts.propertyUseCode ?? null,
    parts.situsAddress ?? null,
  ]);
}

export function buildPresentCadParcelRollAtom(
  observation: PresentCadParcelRollObservation,
  provenance: PropertyFactWriteProvenance,
): CadParcelRollAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = parcelNodeIdOf(
    observation.countyFips,
    observation.parcelKey,
  );
  const atomDid = cadParcelRollAtomDid({
    parcelNodeId,
    taxYear: observation.taxYear,
  });

  const contractAtom = createCadParcelRoll({
    entityType: "cad-parcel-roll",
    atomDid,
    parcelNodeId,
    taxYear: observation.taxYear,
    countyFips: observation.countyFips,
    propId: observation.parcelKey,
    keyKind: observation.keyKind,
    joinPassedOwnerMatchGate: observation.joinPassedOwnerMatchGate,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "cad-authoritative",
    ...(observation.situsAddress
      ? { situsAddress: observation.situsAddress }
      : {}),
    ...(observation.situsCity ? { situsCity: observation.situsCity } : {}),
    ...(observation.situsZip ? { situsZip: observation.situsZip } : {}),
    ...(observation.legalDescription
      ? { legalDescription: observation.legalDescription }
      : {}),
    ...(observation.exemptionCodes
      ? { exemptionCodes: observation.exemptionCodes }
      : {}),
    ...(observation.landValue !== undefined
      ? { landValue: observation.landValue }
      : {}),
    ...(observation.improvementValue !== undefined
      ? { improvementValue: observation.improvementValue }
      : {}),
    ...(observation.marketValue !== undefined
      ? { marketValue: observation.marketValue }
      : {}),
    ...(observation.assessedValue !== undefined
      ? { assessedValue: observation.assessedValue }
      : {}),
    ...(observation.yearBuilt !== undefined
      ? { yearBuilt: observation.yearBuilt }
      : {}),
    ...(observation.livingAreaSqft !== undefined
      ? { livingAreaSqft: observation.livingAreaSqft }
      : {}),
    ...(observation.landAcres !== undefined
      ? { landAcres: observation.landAcres }
      : {}),
    ...(observation.propertyUseCode
      ? { propertyUseCode: observation.propertyUseCode }
      : {}),
    sourceFile: observation.sourceFile,
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

  return finalizeParcelFactAtom(
    {
      ...contractAtom,
      ...persistenceOf(
        entityIdOf(parcelNodeId, observation.taxYear),
        provenance,
        observedAt,
      ),
    },
    [String(observation.taxYear)],
  );
}

export function buildCadParcelRollAbsenceAtom(
  observation: CadParcelRollAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): CadParcelRollAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = parcelNodeIdOf(
    observation.countyFips,
    observation.parcelKey,
  );
  const atomDid = cadParcelRollAtomDid({
    parcelNodeId,
    taxYear: observation.taxYear,
  });

  const contractAtom = createCadParcelRoll({
    entityType: "cad-parcel-roll",
    atomDid,
    parcelNodeId,
    taxYear: observation.taxYear,
    countyFips: observation.countyFips,
    propId: observation.parcelKey,
    keyKind: observation.keyKind,
    joinPassedOwnerMatchGate: false,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "cad-authoritative",
    absence: {
      kind: observation.absenceKind,
      reason: observation.reason,
    },
    ...(observation.sourceFile ? { sourceFile: observation.sourceFile } : {}),
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

  return finalizeParcelFactAtom(
    {
      ...contractAtom,
      ...persistenceOf(
        entityIdOf(parcelNodeId, observation.taxYear),
        provenance,
        observedAt,
      ),
    },
    [String(observation.taxYear)],
  );
}

export function buildCountyCadRollCoverageAbsenceAtom(
  observation: CountyCadRollCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): CadParcelRollAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);
  const atomDid = cadParcelRollAtomDid({
    parcelNodeId,
    taxYear: observation.taxYear,
  });

  const contractAtom = createCadParcelRoll({
    entityType: "cad-parcel-roll",
    atomDid,
    parcelNodeId,
    taxYear: observation.taxYear,
    countyFips: observation.countyFips,
    propId: "_county_coverage",
    keyKind: "prop_id",
    joinPassedOwnerMatchGate: false,
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
    ...persistenceOf(
      entityIdOf(parcelNodeId, observation.taxYear),
      provenance,
      observedAt,
    ),
  };
}
