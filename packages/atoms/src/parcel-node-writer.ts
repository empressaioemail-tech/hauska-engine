/**
 * Rail 1 `parcel-node` writer SEAM.
 *
 * This module defines the boundary a following ingest lane implements — it
 * deliberately contains NO acquisition and NO database access. Its job is to
 * turn an already-resolved parcel observation into a contract-valid
 * `parcel-node` atom, so that when the TxGIO ingest lane lands it has one
 * typed place to call and cannot invent a second atom shape on the way in.
 *
 * Three rules this seam enforces on every caller:
 *
 * 1. **Geometry by reference.** The builders accept a store POINTER
 *    (`{ store: "txgio_parcel", countyFips, propId }`), never ring
 *    coordinates. `txgio_parcel` remains the one geometry truth frame
 *    (Geometry Law rule 1); ten engine files already read it directly and
 *    this atom must not become a second source of geometry truth.
 *
 * 2. **Write-then-verify.** Every builder returns a value that has been
 *    through `PARCEL_NODE_SCHEMA.parse` (via `createParcelNode`). A caller
 *    cannot persist a shape the contract would reject, which is the
 *    Geometry Law rule 3 discipline applied at the write boundary.
 *
 * 3. **Absence is a finding, not a skipped row.** A county with no published
 *    ring source, or a parcel key that resolves nothing in a loaded county,
 *    goes through {@link buildCountyCoverageAbsenceAtom} or
 *    {@link buildParcelNodeAbsenceAtom}. Silence is never the honest answer.
 */

import {
  countyCoverageParcelNodeId,
  createParcelNode,
  parcelNodeAtomDid,
  type ParcelGeometrySourceTier,
  type ParcelKeyKind,
  type ParcelNodeAbsenceKind,
  type ParcelExternalKey,
} from "@empressaio/atom-contract/property";

import type {
  EnginePropertyPersistence,
  ParcelNodeAtomInstance,
} from "./property-instances.js";

/** Provenance every parcel-node write carries, whatever the outcome. */
export interface ParcelNodeWriteProvenance {
  /** Adapter that produced the observation (e.g. `txgio-stratmap-bulk-v1`). */
  sourceAdapter: string;
  /** Human-citable source string; ends up verbatim in `sourceCitation`. */
  sourceCitation: string;
  /** Source URL recorded on the persistence envelope. */
  sourceUrl: string;
  /** Edition of the source layer (e.g. StratMap release date). */
  sourceVintage?: string;
  /** ISO timestamp; defaults to now when omitted. */
  observedAt?: string;
  /** Tenant partition for the persistence envelope. */
  jurisdictionTenant: string;
  /** Content hash of the source row the observation came from. */
  contentHash: string;
  verificationStatus?: "machine" | "human" | "unsurveyed";
}

/** A parcel whose ring IS in the store. */
export interface ResolvedParcelObservation {
  countyFips: string;
  /** Key token that forms the second half of `parcelNodeId`. */
  parcelKey: string;
  keyKind: ParcelKeyKind;
  geometrySourceTier: Exclude<ParcelGeometrySourceTier, "absent">;
  externalKeys?: ReadonlyArray<ParcelExternalKey>;
  /**
   * Count of PARCEL-RING-SOURCE-DIVERGENCE observations between the county CAD
   * ring and the TxGIO ring. Reporting only — it never re-picks the truth
   * frame.
   */
  divergenceObservationCount?: number;
}

/** A parcel in a LOADED county whose key resolves nothing, or resolves badly. */
export interface AbsentParcelObservation {
  countyFips: string;
  parcelKey: string;
  keyKind: ParcelKeyKind;
  /** Tier of the source that WAS consulted — not `absent`; the county is loaded. */
  geometrySourceTier: Exclude<ParcelGeometrySourceTier, "absent">;
  absenceKind: ParcelNodeAbsenceKind;
  /** Concrete reason. Never a generic "not found". */
  reason: string;
}

/** A county probed for a ring source, with nothing published. */
export interface CountyCoverageAbsenceObservation {
  countyFips: string;
  /**
   * Every source actually probed. Non-empty is enforced by the contract —
   * a verified absence with no scope is an unverified guess.
   */
  provenanceScope: ReadonlyArray<string>;
}

function parcelNodeIdOf(countyFips: string, parcelKey: string): string {
  return `${countyFips}:${parcelKey}`;
}

function persistenceOf(
  entityId: string,
  provenance: ParcelNodeWriteProvenance,
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

/**
 * Build the anchor for a parcel whose ring is in `txgio_parcel`.
 *
 * The returned atom carries a POINTER at the ring, never the ring. Throws if
 * the result would not satisfy `PARCEL_NODE_SCHEMA`.
 */
export function buildResolvedParcelNodeAtom(
  observation: ResolvedParcelObservation,
  provenance: ParcelNodeWriteProvenance,
): ParcelNodeAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = parcelNodeIdOf(
    observation.countyFips,
    observation.parcelKey,
  );

  const contractAtom = createParcelNode({
    entityType: "parcel-node",
    atomDid: parcelNodeAtomDid(parcelNodeId),
    parcelNodeId,
    countyFips: observation.countyFips,
    keyKind: observation.keyKind,
    ...(observation.externalKeys ? { externalKeys: observation.externalKeys } : {}),
    reasoningChain: { reasoningKind: "observed" },
    geometrySourceTier: observation.geometrySourceTier,
    geometryStoreRef: {
      store: "txgio_parcel",
      countyFips: observation.countyFips,
      propId: observation.parcelKey,
    },
    geometryLoaded: true,
    ...(observation.divergenceObservationCount !== undefined
      ? { divergenceObservationCount: observation.divergenceObservationCount }
      : {}),
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
    ...persistenceOf(parcelNodeId, provenance, observedAt),
  };
}

/**
 * Build the per-parcel typed absence for a LOADED county.
 *
 * Distinct from county-level not-yet-loaded: this says the source WAS
 * consulted for this parcel and produced nothing usable.
 */
export function buildParcelNodeAbsenceAtom(
  observation: AbsentParcelObservation,
  provenance: ParcelNodeWriteProvenance,
): ParcelNodeAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = parcelNodeIdOf(
    observation.countyFips,
    observation.parcelKey,
  );

  const contractAtom = createParcelNode({
    entityType: "parcel-node",
    atomDid: parcelNodeAtomDid(parcelNodeId),
    parcelNodeId,
    countyFips: observation.countyFips,
    keyKind: observation.keyKind,
    reasoningChain: { reasoningKind: "observed" },
    geometrySourceTier: observation.geometrySourceTier,
    geometryLoaded: false,
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

  return {
    ...contractAtom,
    ...persistenceOf(parcelNodeId, provenance, observedAt),
  };
}

/**
 * Build the county-coverage anchor for a county with no published ring source.
 *
 * This is the row that lets Rail 1 read satisfied-absent for a county rather
 * than sitting at not-yet forever. The contract rejects it without a non-empty
 * `provenanceScope`, so the probe must be documented to count.
 */
export function buildCountyCoverageAbsenceAtom(
  observation: CountyCoverageAbsenceObservation,
  provenance: ParcelNodeWriteProvenance,
): ParcelNodeAtomInstance {
  const observedAt = provenance.observedAt ?? new Date().toISOString();
  const parcelNodeId = countyCoverageParcelNodeId(observation.countyFips);

  const contractAtom = createParcelNode({
    entityType: "parcel-node",
    atomDid: parcelNodeAtomDid(parcelNodeId),
    parcelNodeId,
    countyFips: observation.countyFips,
    keyKind: "prop_id",
    reasoningChain: { reasoningKind: "observed" },
    geometrySourceTier: "absent",
    geometryLoaded: false,
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
    ...persistenceOf(parcelNodeId, provenance, observedAt),
  };
}
