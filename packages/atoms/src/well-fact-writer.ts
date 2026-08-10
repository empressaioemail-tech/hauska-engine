/**
 * `well-fact` writer SEAM — RRC public GIS surface wells (operations lens).
 *
 * One atom per (parcel, well) association; 0..N present per parcel. Parcels
 * with no on-or-near wells carry a typed absence. Always public-free.
 */

import {
  countyCoverageParcelNodeId,
  createWellFact,
  type WellFactAbsence,
  type WellParcelRelation,
  type WellStatus,
  type WellSurfaceLocation,
  type WellType,
} from "@empressaio/atom-contract/property";

import { factClaimContentHash, wellFactAtomDid } from "./fact-writer-ids.js";
import type {
  EnginePropertyPersistence,
  WellFactAtomInstance,
} from "./property-instances.js";
import type { PropertyFactWriteProvenance } from "./cad-parcel-roll-writer.js";

export type { PropertyFactWriteProvenance };

export interface PresentWellFactObservation {
  parcelNodeId: string;
  wellKey: string;
  apiNumber14: string;
  wellStatus: WellStatus;
  wellType: WellType;
  orphaned: boolean;
  operatorName?: string;
  surfaceLocation: WellSurfaceLocation;
  parcelRelation: WellParcelRelation;
  proximityRadiusMeters: number;
  proximityDistanceMeters: number;
  asOf?: string;
}

export interface WellFactAbsenceObservation {
  parcelNodeId: string;
  wellKey: string;
  absenceKind: WellFactAbsence["kind"];
  reason: string;
  proximityRadiusMeters: number;
  asOf?: string;
}

export interface CountyWellCoverageAbsenceObservation {
  countyFips: string;
  provenanceScope: ReadonlyArray<string>;
  asOf?: string;
}

function entityIdOf(parcelNodeId: string, wellKey: string): string {
  return `${parcelNodeId}:${wellKey}`;
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

export function wellFactClaimContentHash(parts: {
  parcelNodeId: string;
  wellKey: string;
  sourceTier: string;
  apiNumber14?: string | null;
  wellStatus?: string | null;
  wellType?: string | null;
  parcelRelation?: string | null;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.wellKey,
    parts.sourceTier,
    parts.apiNumber14 ?? null,
    parts.wellStatus ?? null,
    parts.wellType ?? null,
    parts.parcelRelation ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
  ]);
}

export function buildPresentWellFactAtom(
  observation: PresentWellFactObservation,
  provenance: PropertyFactWriteProvenance,
): WellFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const atomDid = wellFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    wellKey: observation.wellKey,
  });

  const contractAtom = createWellFact({
    entityType: "well-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    wellKey: observation.wellKey,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "texas-rrc-gis",
    apiNumber14: observation.apiNumber14,
    wellStatus: observation.wellStatus,
    wellType: observation.wellType,
    orphaned: observation.orphaned,
    ...(observation.operatorName ? { operatorName: observation.operatorName } : {}),
    surfaceLocation: observation.surfaceLocation,
    parcelRelation: observation.parcelRelation,
    proximityRadiusMeters: observation.proximityRadiusMeters,
    ...(observation.parcelRelation === "near-parcel"
      ? { proximityDistanceMeters: observation.proximityDistanceMeters }
      : {}),
    accessPolicy: "public-free",
    sourceCitation: provenance.sourceCitation,
    extractedAt: observedAt,
    ...(observation.asOf ? { asOf: observation.asOf } : {}),
    ...(provenance.sourceVintage ? { sourceVintage: provenance.sourceVintage } : {}),
    verificationStatus: provenance.verificationStatus ?? "machine",
    sourceAdapter: provenance.sourceAdapter,
    evaluatedAt: observedAt,
    atomTier: "data",
  });

  return {
    ...contractAtom,
    ...persistenceOf(
      entityIdOf(observation.parcelNodeId, observation.wellKey),
      provenance,
      observedAt,
    ),
  };
}

export function buildWellFactAbsenceAtom(
  observation: WellFactAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): WellFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const atomDid = wellFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    wellKey: observation.wellKey,
  });

  const contractAtom = createWellFact({
    entityType: "well-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    wellKey: observation.wellKey,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "texas-rrc-gis",
    absence: {
      kind: observation.absenceKind,
      reason: observation.reason,
    },
    proximityRadiusMeters: observation.proximityRadiusMeters,
    accessPolicy: "public-free",
    sourceCitation: provenance.sourceCitation,
    extractedAt: observedAt,
    ...(observation.asOf ? { asOf: observation.asOf } : {}),
    ...(provenance.sourceVintage ? { sourceVintage: provenance.sourceVintage } : {}),
    verificationStatus: provenance.verificationStatus ?? "machine",
    sourceAdapter: provenance.sourceAdapter,
    evaluatedAt: observedAt,
    atomTier: "data",
  });

  return {
    ...contractAtom,
    ...persistenceOf(
      entityIdOf(observation.parcelNodeId, observation.wellKey),
      provenance,
      observedAt,
    ),
  };
}

export function buildCountyWellFactCoverageAbsenceAtom(
  observation: CountyWellCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): WellFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);
  const wellKey = "_county_coverage";
  const atomDid = wellFactAtomDid({ parcelNodeId, wellKey });

  const contractAtom = createWellFact({
    entityType: "well-fact",
    atomDid,
    parcelNodeId,
    wellKey,
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
    ...(provenance.sourceVintage ? { sourceVintage: provenance.sourceVintage } : {}),
    verificationStatus: provenance.verificationStatus ?? "machine",
    sourceAdapter: provenance.sourceAdapter,
    evaluatedAt: observedAt,
    atomTier: "data",
  });

  return {
    ...contractAtom,
    ...persistenceOf(entityIdOf(parcelNodeId, wellKey), provenance, observedAt),
  };
}
