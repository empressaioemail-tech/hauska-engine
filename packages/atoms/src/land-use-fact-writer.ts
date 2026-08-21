/**
 * `land-use-fact` writer SEAM.
 *
 * Cotality is extinguished — present findings carry CAD
 * `property_use_code` only. `entityId` is `${parcelNodeId}:${taxYear}`.
 */

import {
  countyCoverageParcelNodeId,
  createLandUseFact,
  type LandUseAbsence,
} from "@empressaio/atom-contract/property";

import {
  factClaimContentHash,
  landUseFactAtomDid,
} from "./fact-writer-ids.js";
import { mintParcelFactIdentity } from "./parcel-write-identity.js";
import type {
  EnginePropertyPersistence,
  LandUseFactAtomInstance,
  ParcelExternalKey,
} from "./property-instances.js";
import type { PropertyFactWriteProvenance } from "./cad-parcel-roll-writer.js";

export type { PropertyFactWriteProvenance };

export interface PresentLandUseFactObservation {
  parcelNodeId: string;
  taxYear: number;
  landUseCode: string;
  landUseLabel?: string;
  asOf?: string;
}

export interface LandUseFactAbsenceObservation {
  parcelNodeId: string;
  taxYear: number;
  absenceKind: LandUseAbsence["kind"];
  reason: string;
  asOf?: string;
}

export interface CountyLandUseCoverageAbsenceObservation {
  countyFips: string;
  taxYear: number;
  provenanceScope: ReadonlyArray<string>;
  asOf?: string;
}

function entityIdOf(parcelNodeId: string, taxYear: number): string {
  return `${parcelNodeId}:${taxYear}`;
}

function persistenceOf(
  entityId: string,
  provenance: PropertyFactWriteProvenance,
  observedAt: string,
  externalKeys?: ReadonlyArray<ParcelExternalKey>,
): EnginePropertyPersistence {
  return {
    entityId,
    jurisdictionTenant: provenance.jurisdictionTenant,
    fetchedAt: observedAt,
    sourceAdapter: provenance.sourceAdapter,
    sourceUrl: provenance.sourceUrl,
    contentHash: provenance.contentHash,
    status: "active",
    ...(externalKeys && externalKeys.length > 0 ? { externalKeys } : {}),
  };
}

export function landUseFactClaimContentHash(parts: {
  parcelNodeId: string;
  taxYear: number;
  sourceTier: string;
  landUseCode?: string | null;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.taxYear,
    parts.sourceTier,
    parts.landUseCode ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
  ]);
}

export function buildPresentLandUseFactAtom(
  observation: PresentLandUseFactObservation,
  provenance: PropertyFactWriteProvenance,
): LandUseFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const id = mintParcelFactIdentity(observation.parcelNodeId, [
    String(observation.taxYear),
  ]);
  const atomDid = landUseFactAtomDid({
    parcelNodeId: id.parcelNodeId,
    taxYear: observation.taxYear,
  });

  const contractAtom = createLandUseFact({
    entityType: "land-use-fact",
    atomDid,
    parcelNodeId: id.parcelNodeId,
    taxYear: observation.taxYear,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "cad-authoritative",
    landUseCode: observation.landUseCode,
    ...(observation.landUseLabel
      ? { landUseLabel: observation.landUseLabel }
      : {}),
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
    ...persistenceOf(id.entityId, provenance, observedAt, id.externalKeys),
  };
}

export function buildLandUseFactAbsenceAtom(
  observation: LandUseFactAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): LandUseFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const id = mintParcelFactIdentity(observation.parcelNodeId, [
    String(observation.taxYear),
  ]);
  const atomDid = landUseFactAtomDid({
    parcelNodeId: id.parcelNodeId,
    taxYear: observation.taxYear,
  });

  const contractAtom = createLandUseFact({
    entityType: "land-use-fact",
    atomDid,
    parcelNodeId: id.parcelNodeId,
    taxYear: observation.taxYear,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "cad-authoritative",
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
    ...persistenceOf(id.entityId, provenance, observedAt, id.externalKeys),
  };
}

export function buildCountyLandUseCoverageAbsenceAtom(
  observation: CountyLandUseCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): LandUseFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);
  const atomDid = landUseFactAtomDid({
    parcelNodeId,
    taxYear: observation.taxYear,
  });

  const contractAtom = createLandUseFact({
    entityType: "land-use-fact",
    atomDid,
    parcelNodeId,
    taxYear: observation.taxYear,
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
