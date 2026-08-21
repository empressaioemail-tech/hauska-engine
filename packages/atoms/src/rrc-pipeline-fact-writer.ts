/**
 * `rrc-pipeline-fact` writer SEAM.
 *
 * RRC T-4 pipeline LINE proximity — NOT railroad tracks (rail-corridor-fact),
 * NOT PHMSA NPMS. Parcels outside the buffer are PRESENT with
 * `nearPipeline: false`. `entityId` = bare `parcelNodeId` (rail-corridor pattern).
 */

import {
  countyCoverageParcelNodeId,
  createRrcPipelineFact,
  RRC_PIPELINE_DEFAULT_BUFFER_METERS,
  type RrcPipelineAbsence,
} from "@empressaio/atom-contract/property";

import {
  factClaimContentHash,
  rrcPipelineFactAtomDid,
} from "./fact-writer-ids.js";
import { finalizeParcelFactAtom } from "./parcel-write-identity.js";
import type {
  EnginePropertyPersistence,
  RrcPipelineFactAtomInstance,
} from "./property-instances.js";
import type { PropertyFactWriteProvenance } from "./cad-parcel-roll-writer.js";

export type { PropertyFactWriteProvenance };

export interface PresentRrcPipelineFactObservation {
  parcelNodeId: string;
  bufferMeters?: number;
  nearPipeline: boolean;
  nearestPipelineDistanceMeters?: number;
  t4permit?: string;
  p5Num?: string;
  operatorName?: string;
  systemName?: string;
  commodity?: string;
  commodityDescription?: string;
  systemType?: string;
  status?: string;
  diameter?: number;
  interstate?: boolean | string;
  asOf?: string;
}

export interface RrcPipelineFactAbsenceObservation {
  parcelNodeId: string;
  bufferMeters?: number;
  absenceKind: RrcPipelineAbsence["kind"];
  reason: string;
  asOf?: string;
}

export interface CountyRrcPipelineCoverageAbsenceObservation {
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

export function rrcPipelineFactClaimContentHash(parts: {
  parcelNodeId: string;
  sourceTier: string;
  bufferMeters: number;
  nearPipeline?: boolean | null;
  nearestPipelineDistanceMeters?: number | null;
  t4permit?: string | null;
  p5Num?: string | null;
  operatorName?: string | null;
  systemName?: string | null;
  commodity?: string | null;
  commodityDescription?: string | null;
  systemType?: string | null;
  status?: string | null;
  diameter?: number | null;
  interstate?: boolean | string | null;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.sourceTier,
    parts.bufferMeters,
    parts.nearPipeline ?? null,
    parts.nearestPipelineDistanceMeters ?? null,
    parts.t4permit ?? null,
    parts.p5Num ?? null,
    parts.operatorName ?? null,
    parts.systemName ?? null,
    parts.commodity ?? null,
    parts.commodityDescription ?? null,
    parts.systemType ?? null,
    parts.status ?? null,
    parts.diameter ?? null,
    parts.interstate ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
  ]);
}

export function buildPresentRrcPipelineFactAtom(
  observation: PresentRrcPipelineFactObservation,
  provenance: PropertyFactWriteProvenance,
): RrcPipelineFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const bufferMeters =
    observation.bufferMeters ?? RRC_PIPELINE_DEFAULT_BUFFER_METERS;
  const atomDid = rrcPipelineFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    bufferMeters,
  });

  const contractAtom = createRrcPipelineFact({
    entityType: "rrc-pipeline-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "rrc-public-gis",
    bufferMeters,
    nearPipeline: observation.nearPipeline,
    ...(observation.nearPipeline &&
    observation.nearestPipelineDistanceMeters !== undefined
      ? {
          nearestPipelineDistanceMeters:
            observation.nearestPipelineDistanceMeters,
        }
      : {}),
    ...(observation.nearPipeline && observation.t4permit
      ? { t4permit: observation.t4permit }
      : {}),
    ...(observation.nearPipeline && observation.p5Num
      ? { p5Num: observation.p5Num }
      : {}),
    ...(observation.nearPipeline && observation.operatorName
      ? { operatorName: observation.operatorName }
      : {}),
    ...(observation.nearPipeline && observation.systemName
      ? { systemName: observation.systemName }
      : {}),
    ...(observation.nearPipeline && observation.commodity
      ? { commodity: observation.commodity }
      : {}),
    ...(observation.nearPipeline && observation.commodityDescription
      ? { commodityDescription: observation.commodityDescription }
      : {}),
    ...(observation.nearPipeline && observation.systemType
      ? { systemType: observation.systemType }
      : {}),
    ...(observation.nearPipeline && observation.status
      ? { status: observation.status }
      : {}),
    ...(observation.nearPipeline && observation.diameter !== undefined
      ? { diameter: observation.diameter }
      : {}),
    ...(observation.nearPipeline && observation.interstate !== undefined
      ? { interstate: observation.interstate }
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

export function buildRrcPipelineFactAbsenceAtom(
  observation: RrcPipelineFactAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): RrcPipelineFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const bufferMeters =
    observation.bufferMeters ?? RRC_PIPELINE_DEFAULT_BUFFER_METERS;
  const atomDid = rrcPipelineFactAtomDid({
    parcelNodeId: observation.parcelNodeId,
    bufferMeters,
  });

  const contractAtom = createRrcPipelineFact({
    entityType: "rrc-pipeline-fact",
    atomDid,
    parcelNodeId: observation.parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "rrc-public-gis",
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

export function buildCountyRrcPipelineCoverageAbsenceAtom(
  observation: CountyRrcPipelineCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): RrcPipelineFactAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);
  const atomDid = rrcPipelineFactAtomDid({
    parcelNodeId,
    bufferMeters: RRC_PIPELINE_DEFAULT_BUFFER_METERS,
  });

  const contractAtom = createRrcPipelineFact({
    entityType: "rrc-pipeline-fact",
    atomDid,
    parcelNodeId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "absent",
    bufferMeters: RRC_PIPELINE_DEFAULT_BUFFER_METERS,
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
