import type {
  ZoningFactAtomInstance,
} from "@hauska-engine/atoms";

import {
  buildReasoningReadAxes,
  propertyEntityId,
  propertyNotApplicableConsequence,
  sha256HexCanonical,
  widthedFromMatchBasis,
} from "./confidence.js";
import type {
  HonestAbsence,
  JurisdictionDescriptor,
  ParcelZoningObservation,
} from "./types.js";

export function emitZoningFact(
  descriptor: JurisdictionDescriptor,
  parcelObs: ParcelZoningObservation,
  version = 1,
): ZoningFactAtomInstance | HonestAbsence {
  const district = parcelObs.districtCode?.trim() ?? "";
  if (!district) {
    return {
      kind: "honest-absence",
      parcelNodeId: parcelObs.parcelNodeId,
      reason: "No zoning district observed for parcel — honest absence, no fallback district invented.",
      code: "zoning-null",
    };
  }

  if (parcelObs.matchBasis === "fallback") {
    return {
      kind: "honest-absence",
      parcelNodeId: parcelObs.parcelNodeId,
      reason:
        "Zoning match basis is fallback — graded honest absence instead of stamping a default district.",
      code: "zoning-fallback-untrusted",
    };
  }

  const asserted = widthedFromMatchBasis(parcelObs.matchBasis);
  const entityId = propertyEntityId(parcelObs.parcelNodeId, "zoning", version);
  const extractedAt = parcelObs.extractedAt;
  const instance: ZoningFactAtomInstance = {
    entityType: "zoning-fact",
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
    districtCode: district,
    districtLabel: parcelObs.districtLabel,
    matchBasis: parcelObs.matchBasis,
    prefixMatched: parcelObs.prefixMatched,
    reasoningChain: { reasoningKind: "observed" },
    readAxes: buildReasoningReadAxes({
      asserted,
      consequence: propertyNotApplicableConsequence(
        "zoning-fact-observation-has-no-life-safety-stratum",
        extractedAt,
      ),
    }),
    contentHash: "",
  };
  instance.contentHash = sha256HexCanonical(JSON.stringify(instance));
  return instance;
}
