/**
 * Unincorporated-land envelope/boundary-edge emission — no zoning ordinance
 * exists to derive a setback from, so no zoning-setback-derived envelope
 * opinion is computed. This is a scope statement, never a buildability
 * claim: this atom chain doesn't account for floodplain, easements, OSSF
 * setbacks, or any other real constraint on rural land, so "the whole
 * parcel is buildable" would be a computed claim nothing backed.
 *
 * Deliberately does not touch geometry, roads, or the zoned setback-table
 * machinery at all — every parcel under an unzoned (zoningRegime: "unzoned")
 * registry row is unincorporated by construction, so this is a per-parcel
 * identity-only stamp, not a per-parcel geometry computation. See
 * _decisions record for the 2026-09-06 operator ruling on this shape.
 */
import {
  buildAtomDid,
  BUILDABLE_ENVELOPE_DERIVATION_METHOD,
  type BoundaryEdgeAtomInstance,
  type BuildableEnvelopeAtomInstance,
} from "@hauska-engine/atoms";

import {
  buildPropertyReadContract,
  composeDerivedAssertedConfidence,
  contentHashExcludingProvenance,
  propertyEntityId,
  propertyNotApplicableConsequence,
} from "./confidence.js";

export const UNINCORPORATED_NO_ZONING_REASON =
  "unincorporated parcel — county does not zone land outside city limits";

export interface UnincorporatedEnvelopeInputs {
  parcelNodeId: string;
  jurisdictionTenant: string;
  /** Registry rowId this parcel's zoningRegime:"unzoned" ruling came from, for citation. */
  sourceCitation: string;
  extractedAt: string;
  version?: number;
}

/**
 * Not-applicable buildable-envelope for an unincorporated parcel. Never
 * requires a zoning-fact or setback-rule atom did — there logically are
 * none to reference.
 */
export function emitUnincorporatedBuildableEnvelope(
  inputs: UnincorporatedEnvelopeInputs,
): BuildableEnvelopeAtomInstance {
  const version = inputs.version ?? 1;
  const extractedAt = inputs.extractedAt;
  const entityId = propertyEntityId(inputs.parcelNodeId, "envelope", version);
  const atomDid = buildAtomDid("buildable-envelope", entityId).raw;
  const composed = composeDerivedAssertedConfidence([]);

  const instance: BuildableEnvelopeAtomInstance = {
    entityType: "buildable-envelope",
    atomDid,
    entityId,
    jurisdictionTenant: inputs.jurisdictionTenant,
    parcelNodeId: inputs.parcelNodeId,
    fetchedAt: extractedAt,
    extractedAt,
    sourceAdapter: "unincorporated-no-zoning",
    sourceUrl: "not-applicable",
    sourceCitation: inputs.sourceCitation,
    accessPolicy: "public-free",
    atomTier: "data",
    status: "active",
    versionStamp: `${inputs.parcelNodeId}:buildable-envelope:${version}:${extractedAt}`,
    outcome: { kind: "not-applicable", reason: UNINCORPORATED_NO_ZONING_REASON },
    reasoningChain: {
      reasoningKind: "derived",
      derivationMethod: BUILDABLE_ENVELOPE_DERIVATION_METHOD,
      // Honestly empty: no zoning-fact/setback-rule atoms were consulted --
      // there logically are none for an unincorporated parcel.
      inputAtomRefs: [],
    },
    readContract: buildPropertyReadContract({
      asserted: composed,
      calibrated: null,
      consequence: propertyNotApplicableConsequence(
        "unincorporated-parcel-no-zoning-ordinance",
        extractedAt,
      ),
      assembledAt: extractedAt,
    }),
    contentHash: "",
  };
  instance.contentHash = contentHashExcludingProvenance(instance);
  return instance;
}

export interface UnincorporatedBoundaryEdgeSetbackInput {
  edgeIndex: number;
  role: BoundaryEdgeAtomInstance["role"];
  interior: BoundaryEdgeAtomInstance["interior"];
  facingRoad?: BoundaryEdgeAtomInstance["facingRoad"];
}

/**
 * Not-applicable setback disposition for one boundary edge on an
 * unincorporated parcel. Callers still supply real per-edge geometry/role
 * (edge adjacency is a geographic fact independent of zoning) — only the
 * SETBACK portion of the edge is zoning-dependent, so only that is stamped
 * not-applicable here.
 */
export function notApplicableBoundaryEdgeSetback(): {
  kind: "not-applicable";
  reason: string;
} {
  return { kind: "not-applicable", reason: UNINCORPORATED_NO_ZONING_REASON };
}
