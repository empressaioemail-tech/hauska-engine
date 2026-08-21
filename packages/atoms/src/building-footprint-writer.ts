/**
 * `building-footprint` writer SEAM (ADR-029 / T3 WS4).
 *
 * ML-derived footprints carry ODC-By attribution in `sourceCitation`.
 * `entityId` is `${parcelNodeId}:footprint:${footprintId}`.
 */

import {
  countyCoverageParcelNodeId,
  createBuildingFootprint,
  type BuildingFootprintAbsence,
  type BuildingFootprintSourceTier,
} from "@empressaio/atom-contract/property";

import {
  buildingFootprintAtomDid,
  factClaimContentHash,
} from "./fact-writer-ids.js";
import {
  buildingFootprintAbsenceEntityId,
  buildingFootprintPresentEntityId,
  mintParcelFactIdentity,
} from "./parcel-write-identity.js";
import type {
  BuildingFootprintAtomInstance,
  EnginePropertyPersistence,
  ParcelExternalKey,
} from "./property-instances.js";
import type { PropertyFactWriteProvenance } from "./cad-parcel-roll-writer.js";

export type { PropertyFactWriteProvenance };

export type FootprintRing = Array<[number, number]>;

export interface PresentBuildingFootprintObservation {
  parcelNodeId: string;
  footprintId: string;
  footprintGeometry: { type: "Polygon"; coordinates: FootprintRing[] };
  sourceTier: Extract<BuildingFootprintSourceTier, "ml-derived" | "cad-authoritative">;
  structureRole?: "primary" | "accessory" | "unknown";
  confidence?: number;
  verificationStatus?: "machine" | "human" | "unsurveyed";
  asOf?: string;
}

export interface BuildingFootprintPerParcelAbsenceObservation {
  parcelNodeId: string;
  footprintId?: string;
  absenceKind: BuildingFootprintAbsence["kind"];
  reason: string;
  sourceTier?: Extract<
    BuildingFootprintSourceTier,
    "ml-derived" | "cad-authoritative"
  >;
  asOf?: string;
}

export interface CountyBuildingFootprintCoverageAbsenceObservation {
  countyFips: string;
  provenanceScope: ReadonlyArray<string>;
  asOf?: string;
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

export function buildingFootprintClaimContentHash(parts: {
  parcelNodeId: string;
  footprintId: string;
  sourceTier: string;
  mlFeatureId?: string | null;
  structureRole?: string | null;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
}): string {
  return factClaimContentHash([
    parts.parcelNodeId,
    parts.footprintId,
    parts.sourceTier,
    parts.mlFeatureId ?? null,
    parts.structureRole ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
  ]);
}

export function buildPresentBuildingFootprintAtom(
  observation: PresentBuildingFootprintObservation,
  provenance: PropertyFactWriteProvenance,
): BuildingFootprintAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const footprintId = observation.footprintId;
  const id = buildingFootprintPresentEntityId(observation.parcelNodeId, footprintId);
  const atomDid = buildingFootprintAtomDid({
    parcelNodeId: id.parcelNodeId,
    footprintId,
  });

  const contractAtom = createBuildingFootprint({
    entityType: "building-footprint",
    atomDid,
    parcelNodeId: id.parcelNodeId,
    footprintId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: observation.sourceTier,
    footprintGeometry: observation.footprintGeometry,
    ...(observation.structureRole
      ? { structureRole: observation.structureRole }
      : footprintId === "primary"
        ? { structureRole: "primary" as const }
        : {}),
    accessPolicy: "public-free",
    sourceCitation: provenance.sourceCitation,
    extractedAt: observedAt,
    ...(observation.asOf ? { asOf: observation.asOf } : {}),
    ...(provenance.sourceVintage
      ? { sourceVintage: provenance.sourceVintage }
      : {}),
    verificationStatus:
      observation.verificationStatus ??
      (observation.sourceTier === "ml-derived" ? "unsurveyed" : "machine"),
    sourceAdapter: provenance.sourceAdapter,
    evaluatedAt: observedAt,
    atomTier: "data",
    ...(observation.confidence !== undefined
      ? { confidence: observation.confidence }
      : {}),
  });

  return {
    ...contractAtom,
    ...persistenceOf(id.entityId, provenance, observedAt, id.externalKeys),
  };
}

export function buildBuildingFootprintPerParcelAbsenceAtom(
  observation: BuildingFootprintPerParcelAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): BuildingFootprintAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const footprintId = observation.footprintId ?? "none";
  const id = buildingFootprintAbsenceEntityId(observation.parcelNodeId);
  const atomDid = buildingFootprintAtomDid({
    parcelNodeId: id.parcelNodeId,
    footprintId,
  });
  const sourceTier = observation.sourceTier ?? "ml-derived";

  const contractAtom = createBuildingFootprint({
    entityType: "building-footprint",
    atomDid,
    parcelNodeId: id.parcelNodeId,
    footprintId,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier,
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
    verificationStatus: "machine",
    sourceAdapter: provenance.sourceAdapter,
    evaluatedAt: observedAt,
    atomTier: "data",
  });

  return {
    ...contractAtom,
    ...persistenceOf(id.entityId, provenance, observedAt, id.externalKeys),
  };
}

export function buildCountyBuildingFootprintCoverageAbsenceAtom(
  observation: CountyBuildingFootprintCoverageAbsenceObservation,
  provenance: PropertyFactWriteProvenance,
): BuildingFootprintAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const coverageId = countyCoverageParcelNodeId(observation.countyFips);
  const id = mintParcelFactIdentity(coverageId, ["footprint", "county-coverage"]);
  const footprintId = "county-coverage";
  const atomDid = buildingFootprintAtomDid({
    parcelNodeId: id.parcelNodeId,
    footprintId,
  });

  const contractAtom = createBuildingFootprint({
    entityType: "building-footprint",
    atomDid,
    parcelNodeId: id.parcelNodeId,
    footprintId,
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
    verificationStatus: "machine",
    sourceAdapter: provenance.sourceAdapter,
    evaluatedAt: observedAt,
    atomTier: "data",
  });

  return {
    ...contractAtom,
    ...persistenceOf(id.entityId, provenance, observedAt, id.externalKeys),
  };
}
