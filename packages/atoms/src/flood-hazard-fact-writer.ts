/**
 * `flood-hazard-fact` writer SEAM.
 *
 * Point outside every loaded NFHL polygon is typed absence (`no-flood-coverage`),
 * never Zone X / inSFHA=false by omission (SF-9). Absence also covers empty
 * zone index / no-geocode. `entityId` = `parcelNodeId` (no tax year).
 */

import {
  countyCoverageParcelNodeId,
  createFloodHazardFact,
  type FloodHazardAbsence,
} from "@empressaio/atom-contract/property";

import {
  factClaimContentHash,
  floodHazardFactAtomDid,
} from "./fact-writer-ids.js";
import type {
  EnginePropertyPersistence,
  FloodHazardFactAtomInstance,
} from "./property-instances.js";
import type { PropertyFactWriteProvenance } from "./cad-parcel-roll-writer.js";

export type { PropertyFactWriteProvenance };

export interface PresentFloodHazardFactObservation {
  parcelNodeId: string;
  inSpecialFloodHazardArea: boolean;
  floodZone?: string | null;
  zoneSubtype?: string | null;
  baseFloodElevation?: number | null;
  asOf?: string;
}

export interface FloodHazardFactAbsenceObservation {
  parcelNodeId: string;
  absenceKind: FloodHazardAbsence["kind"];
  reason: string;
  asOf?: string;
}

export interface CountyFloodHazardCoverageAbsenceObservation {
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

export function floodHazardFactClaimContentHash(parts: {
  parcelNodeId: string;
  sourceTier: string;
  inSpecialFloodHazardArea?: boolean | null;
  floodZone?: string | null;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.sourceTier,
    parts.inSpecialFloodHazardArea ?? null,
    parts.floodZone ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
  ]);
}

export function buildPresentFloodHazardFactAtom(
  observation: PresentFloodHazardFactObservation,
  provenance: PropertyFactWriteProvenance,
): FloodHazardFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const atomDid = floodHazardFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
  });

  const contractAtom = createFloodHazardFact({
    entityType: "flood-hazard-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "fema-nfhl",
    inSpecialFloodHazardArea: observation.inSpecialFloodHazardArea,
    ...(observation.floodZone !== undefined
      ? { floodZone: observation.floodZone }
      : {}),
    ...(observation.zoneSubtype !== undefined
      ? { zoneSubtype: observation.zoneSubtype }
      : {}),
    ...(observation.baseFloodElevation !== undefined
      ? { baseFloodElevation: observation.baseFloodElevation }
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
    ...persistenceOf(observation.parcelNodeId, provenance, observedAt),
  };
}

export function buildFloodHazardFactAbsenceAtom(
  observation: FloodHazardFactAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): FloodHazardFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const atomDid = floodHazardFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
  });

  const contractAtom = createFloodHazardFact({
    entityType: "flood-hazard-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "fema-nfhl",
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
    ...persistenceOf(observation.parcelNodeId, provenance, observedAt),
  };
}

export function buildCountyFloodHazardCoverageAbsenceAtom(
  observation: CountyFloodHazardCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): FloodHazardFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);
  const atomDid = floodHazardFactAtomDid({ parcelNodeId });

  const contractAtom = createFloodHazardFact({
    entityType: "flood-hazard-fact",
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
