import { buildAtomDid, type ZoningFactAtomInstance } from "@hauska-engine/atoms";

import {
  buildPropertyReadContract,
  propertyEntityId,
  propertyNotApplicableConsequence,
  sha256HexCanonical,
  widthedFromMatchBasis,
} from "./confidence.js";
import type {
  JurisdictionDescriptor,
  ParcelZoningObservation,
} from "./types.js";

/**
 * Emit a zoning-fact atom. Honest absence is a contract atom with
 * `absence.kind = "no-zoning-stamp"` — never an invented I-2 (or other)
 * fallback district stamp.
 */
export function emitZoningFact(
  descriptor: JurisdictionDescriptor,
  parcelObs: ParcelZoningObservation,
  version = 1,
): ZoningFactAtomInstance {
  const district = parcelObs.districtCode?.trim() ?? "";
  const extractedAt = parcelObs.extractedAt;
  const entityId = propertyEntityId(parcelObs.parcelNodeId, "zoning", version);
  const atomDid = buildAtomDid("zoning-fact", entityId).raw;

  if (!district || parcelObs.matchBasis === "fallback") {
    const reason = !district
      ? "No zoning district observed for parcel — honest absence, no fallback district invented."
      : "Zoning match basis is fallback — graded honest absence instead of stamping a default district.";
    const asserted = widthedFromMatchBasis(
      parcelObs.matchBasis === "fallback" ? "fallback" : "exact",
    );
    const instance: ZoningFactAtomInstance = {
      entityType: "zoning-fact",
      atomDid,
      entityId,
      jurisdictionTenant: descriptor.jurisdictionTenant,
      parcelNodeId: parcelObs.parcelNodeId,
      fetchedAt: extractedAt,
      extractedAt,
      sourceAdapter: descriptor.sourceAdapter,
      sourceUrl: descriptor.sourceUrl,
      sourceCitation: parcelObs.sourceCitation,
      accessPolicy: descriptor.defaultAccessPolicy,
      atomTier: "data",
      status: "active",
      versionStamp: `${parcelObs.parcelNodeId}:zoning-fact:${version}:${extractedAt}`,
      absence: {
        kind: "no-zoning-stamp",
        reason,
      },
      matchBasis: parcelObs.matchBasis,
      reasoningChain: { reasoningKind: "observed" },
      readContract: buildPropertyReadContract({
        asserted,
        consequence: propertyNotApplicableConsequence(
          "zoning-fact-honest-absence-has-no-life-safety-stratum",
          extractedAt,
        ),
        assembledAt: extractedAt,
      }),
      contentHash: "",
    };
    instance.contentHash = sha256HexCanonical(JSON.stringify(instance));
    return instance;
  }

  const asserted = widthedFromMatchBasis(parcelObs.matchBasis);
  const instance: ZoningFactAtomInstance = {
    entityType: "zoning-fact",
    atomDid,
    entityId,
    jurisdictionTenant: descriptor.jurisdictionTenant,
    parcelNodeId: parcelObs.parcelNodeId,
    fetchedAt: extractedAt,
    extractedAt,
    sourceAdapter: descriptor.sourceAdapter,
    sourceUrl: descriptor.sourceUrl,
    sourceCitation: parcelObs.sourceCitation,
    accessPolicy: descriptor.defaultAccessPolicy,
    atomTier: "data",
    status: "active",
    versionStamp: `${parcelObs.parcelNodeId}:zoning-fact:${version}:${extractedAt}`,
    district,
    districtLabel: parcelObs.districtLabel,
    matchBasis: parcelObs.matchBasis,
    prefixMatched: parcelObs.prefixMatched,
    reasoningChain: { reasoningKind: "observed" },
    readContract: buildPropertyReadContract({
      asserted,
      consequence: propertyNotApplicableConsequence(
        "zoning-fact-observation-has-no-life-safety-stratum",
        extractedAt,
      ),
      assembledAt: extractedAt,
    }),
    contentHash: "",
  };
  instance.contentHash = sha256HexCanonical(JSON.stringify(instance));
  return instance;
}
