/**
 * `utility-easement` writer SEAM (ADR-029 / T3 WS4).
 *
 * County-coverage absence when no published source (one atom, verifiedAbsence).
 * Per-parcel absence when a source exists but spatial join yields nothing.
 * Present atoms carry easementGeometry OR per-parcel absence — never fake geometry.
 * Uniform `public-free` accessPolicy on every outcome.
 */

import {
  countyCoverageParcelNodeId,
  createUtilityEasement,
  type UtilityEasementAbsence,
  type UtilityEasementClass,
  type UtilityEasementSourceTier,
} from "@empressaio/atom-contract/property";
import type { EasementGeometry } from "@empressaio/atom-contract/property";

import {
  factClaimContentHash,
  utilityEasementAtomDid,
} from "./fact-writer-ids.js";
import { finalizeParcelFactAtom } from "./parcel-write-identity.js";
import type {
  EnginePropertyPersistence,
  UtilityEasementAtomInstance,
} from "./property-instances.js";
import type { PropertyFactWriteProvenance } from "./cad-parcel-roll-writer.js";

export type { PropertyFactWriteProvenance };

export interface PresentUtilityEasementObservation {
  parcelNodeId: string;
  easementId: string;
  easementClass: UtilityEasementClass;
  sourceTier: Exclude<UtilityEasementSourceTier, "absent">;
  easementGeometry: EasementGeometry;
  corridorWidthFt?: number;
  holderLabel?: string;
  recordingRef?: {
    county: string;
    book?: string;
    page?: string;
    instrumentNumber?: string;
  };
}

export interface UtilityEasementPerParcelAbsenceObservation {
  parcelNodeId: string;
  sourceTier: Exclude<UtilityEasementSourceTier, "absent">;
  absenceKind: UtilityEasementAbsence["kind"];
  reason: string;
}

export interface CountyUtilityEasementCoverageAbsenceObservation {
  countyFips: string;
  provenanceScope: ReadonlyArray<string>;
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

export function utilityEasementClaimContentHash(parts: {
  parcelNodeId: string;
  easementId: string;
  sourceTier: string;
  easementClass?: string;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.easementId,
    parts.sourceTier,
    parts.easementClass ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
  ]);
}

export function buildPresentUtilityEasementAtom(
  observation: PresentUtilityEasementObservation,
  provenance: PropertyFactWriteProvenance,
): UtilityEasementAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const atomDid = utilityEasementAtomDid({
    parcelNodeId: observation.parcelNodeId,
    easementId: observation.easementId,
  });
  const entityId = `${observation.parcelNodeId}:easement:${observation.easementId}`;

  const contractAtom = createUtilityEasement({
    entityType: "utility-easement",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    easementId: observation.easementId,
    reasoningChain: { reasoningKind: "observed" },
    easementClass: observation.easementClass,
    sourceTier: observation.sourceTier,
    easementGeometry: observation.easementGeometry,
    ...(observation.corridorWidthFt !== undefined
      ? { corridorWidthFt: observation.corridorWidthFt }
      : {}),
    ...(observation.holderLabel ? { holderLabel: observation.holderLabel } : {}),
    ...(observation.recordingRef ? { recordingRef: observation.recordingRef } : {}),
    accessPolicy: "public-free",
    sourceCitation: provenance.sourceCitation,
    extractedAt: observedAt,
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
      ...persistenceOf(entityId, provenance, observedAt),
    },
    ["easement", observation.easementId],
  );
}

export function buildUtilityEasementPerParcelAbsenceAtom(
  observation: UtilityEasementPerParcelAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): UtilityEasementAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const easementId = "absent";
  const atomDid = utilityEasementAtomDid({
    parcelNodeId: observation.parcelNodeId,
    easementId,
  });
  const entityId = `${observation.parcelNodeId}:easement:${easementId}`;

  const contractAtom = createUtilityEasement({
    entityType: "utility-easement",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    easementId,
    reasoningChain: { reasoningKind: "observed" },
    easementClass: "unknown",
    sourceTier: observation.sourceTier,
    absence: {
      kind: observation.absenceKind,
      reason: observation.reason,
    },
    accessPolicy: "public-free",
    sourceCitation: provenance.sourceCitation,
    extractedAt: observedAt,
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
      ...persistenceOf(entityId, provenance, observedAt),
    },
    ["easement", easementId],
  );
}

export function buildCountyUtilityEasementCoverageAbsenceAtom(
  observation: CountyUtilityEasementCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): UtilityEasementAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);
  const easementId = "county-coverage";
  const atomDid = utilityEasementAtomDid({ parcelNodeId, easementId });
  const entityId = `${parcelNodeId}:easement:${easementId}`;

  const contractAtom = createUtilityEasement({
    entityType: "utility-easement",
    atomDid,
    parcelNodeId,
    easementId,
    reasoningChain: { reasoningKind: "observed" },
    easementClass: "unknown",
    sourceTier: "absent",
    verifiedAbsence: {
      evaluated: true,
      provenanceScope: [...observation.provenanceScope],
    },
    accessPolicy: "public-free",
    sourceCitation: provenance.sourceCitation,
    extractedAt: observedAt,
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
    ...persistenceOf(entityId, provenance, observedAt),
  };
}
