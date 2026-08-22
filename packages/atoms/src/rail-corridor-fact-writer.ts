/**
 * `rail-corridor-fact` writer SEAM.
 *
 * Railroad TRACKS via NTAD NARN — NOT Texas Railroad Commission oil/gas.
 * Parcels outside the buffer are PRESENT with `nearRailCorridor: false`.
 * `entityId` = `parcelNodeId` (no tax year; geographic fact like flood-hazard).
 */

import {
  countyCoverageParcelNodeId,
  createRailCorridorFact,
  RAIL_CORRIDOR_DEFAULT_BUFFER_METERS,
  type RailCorridorAbsence,
  type RailCorridorAtGradeCrossing,
  type RailCorridorClass,
  type RailCorridorStatus,
} from "@empressaio/atom-contract/property";

import {
  factClaimContentHash,
  railCorridorFactAtomDid,
} from "./fact-writer-ids.js";
import { finalizeParcelFactAtom } from "./parcel-write-identity.js";
import type {
  EnginePropertyPersistence,
  RailCorridorFactAtomInstance,
} from "./property-instances.js";
import type { PropertyFactWriteProvenance } from "./cad-parcel-roll-writer.js";

export type { PropertyFactWriteProvenance };

export interface PresentRailCorridorFactObservation {
  parcelNodeId: string;
  bufferMeters?: number;
  nearRailCorridor: boolean;
  corridorStatus?: RailCorridorStatus;
  corridorClass?: RailCorridorClass;
  nearestCorridorDistanceMeters?: number;
  atGradeCrossings?: ReadonlyArray<RailCorridorAtGradeCrossing>;
  asOf?: string;
}

export interface RailCorridorFactAbsenceObservation {
  parcelNodeId: string;
  bufferMeters?: number;
  absenceKind: RailCorridorAbsence["kind"];
  reason: string;
  asOf?: string;
}

export interface CountyRailCorridorCoverageAbsenceObservation {
  countyFips: string;
  provenanceScope: ReadonlyArray<string>;
  asOf?: string;
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

export function railCorridorFactClaimContentHash(parts: {
  parcelNodeId: string;
  sourceTier: string;
  bufferMeters: number;
  nearRailCorridor?: boolean | null;
  corridorStatus?: string | null;
  corridorClass?: string | null;
  nearestCorridorDistanceMeters?: number | null;
  atGradeCrossings?: ReadonlyArray<RailCorridorAtGradeCrossing> | null;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.sourceTier,
    parts.bufferMeters,
    parts.nearRailCorridor ?? null,
    parts.corridorStatus ?? null,
    parts.corridorClass ?? null,
    parts.nearestCorridorDistanceMeters ?? null,
    parts.atGradeCrossings ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
  ]);
}

export function buildPresentRailCorridorFactAtom(
  observation: PresentRailCorridorFactObservation,
  provenance: PropertyFactWriteProvenance,
): RailCorridorFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const bufferMeters =
    observation.bufferMeters ?? RAIL_CORRIDOR_DEFAULT_BUFFER_METERS;
  const atomDid = railCorridorFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    bufferMeters,
  });

  const contractAtom = createRailCorridorFact({
    entityType: "rail-corridor-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "ntad-narn",
    bufferMeters,
    nearRailCorridor: observation.nearRailCorridor,
    ...(observation.nearRailCorridor && observation.corridorStatus
      ? { corridorStatus: observation.corridorStatus }
      : {}),
    ...(observation.nearRailCorridor && observation.corridorClass
      ? { corridorClass: observation.corridorClass }
      : {}),
    ...(observation.nearestCorridorDistanceMeters !== undefined
      ? { nearestCorridorDistanceMeters: observation.nearestCorridorDistanceMeters }
      : {}),
    ...(observation.atGradeCrossings && observation.atGradeCrossings.length > 0
      ? { atGradeCrossings: [...observation.atGradeCrossings] }
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

  return finalizeParcelFactAtom({
    ...contractAtom,
    ...persistenceOf(observation.parcelNodeId, provenance, observedAt),
  });
}

export function buildRailCorridorFactAbsenceAtom(
  observation: RailCorridorFactAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): RailCorridorFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const bufferMeters =
    observation.bufferMeters ?? RAIL_CORRIDOR_DEFAULT_BUFFER_METERS;
  const atomDid = railCorridorFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    bufferMeters,
  });

  const contractAtom = createRailCorridorFact({
    entityType: "rail-corridor-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "ntad-narn",
    bufferMeters,
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

  return finalizeParcelFactAtom({
    ...contractAtom,
    ...persistenceOf(observation.parcelNodeId, provenance, observedAt),
  });
}

export function buildCountyRailCorridorCoverageAbsenceAtom(
  observation: CountyRailCorridorCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): RailCorridorFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);
  const atomDid = railCorridorFactAtomDid({
    parcelNodeId,
    bufferMeters: RAIL_CORRIDOR_DEFAULT_BUFFER_METERS,
  });

  const contractAtom = createRailCorridorFact({
    entityType: "rail-corridor-fact",
    atomDid,
    parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "absent",
    bufferMeters: RAIL_CORRIDOR_DEFAULT_BUFFER_METERS,
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
