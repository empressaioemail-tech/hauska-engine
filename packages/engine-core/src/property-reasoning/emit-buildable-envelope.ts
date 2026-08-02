import {
  BUILDABLE_ENVELOPE_DERIVATION_METHOD,
  buildAtomDid,
  type BuildableEnvelopeAtomInstance,
} from "@hauska-engine/atoms";

import {
  buildPropertyReadContract,
  composeDerivedAssertedConfidence,
  contentHashExcludingTimestamps,
  propertyEntityId,
  propertyNotApplicableConsequence,
} from "./confidence.js";
import type { EmitBuildableEnvelopeInputs, HonestAbsence } from "./types.js";

export function emitBuildableEnvelope(
  inputs: EmitBuildableEnvelopeInputs,
): BuildableEnvelopeAtomInstance | HonestAbsence {
  if (inputs.inputAssertedConfidences.length < 2) {
    return {
      kind: "honest-absence",
      parcelNodeId: inputs.parcelNodeId,
      reason: "Derived envelope requires zoning fact and setback rule input confidences.",
      code: "envelope-missing-inputs",
    };
  }

  const composed = composeDerivedAssertedConfidence(inputs.inputAssertedConfidences);
  const version = inputs.version ?? 1;
  const extractedAt = inputs.extractedAt;
  const entityId = propertyEntityId(inputs.parcelNodeId, "envelope", version);
  const atomDid = buildAtomDid("buildable-envelope", entityId).raw;

  const inputAtomRefs = [
    {
      atomDid: inputs.zoningFactAtomDid,
      role: "fact" as const,
      entityType: "zoning-fact",
    },
    {
      atomDid: inputs.setbackRuleAtomDid,
      role: "rule" as const,
      entityType: "setback-rule",
    },
    {
      atomDid: inputs.geometryRefId,
      role: "reference-field" as const,
      citationLabel: "parcel-geometry-ring",
    },
    {
      atomDid: inputs.frontEdgeRefId,
      role: "reference-field" as const,
      citationLabel: "front-edge-anchor",
    },
  ];

  const consequenceBasis =
    inputs.outcome.kind === "no-buildable-area"
      ? "no-buildable-area"
      : inputs.outcome.kind === "provisional-front-edge"
        ? "setback-constrained"
        : "routine";

  const instance: BuildableEnvelopeAtomInstance = {
    entityType: "buildable-envelope",
    atomDid,
    entityId,
    jurisdictionTenant: inputs.descriptor.jurisdictionTenant,
    parcelNodeId: inputs.parcelNodeId,
    fetchedAt: extractedAt,
    extractedAt,
    sourceAdapter: inputs.descriptor.sourceAdapter,
    sourceUrl: inputs.descriptor.sourceUrl,
    sourceCitation: inputs.sourceCitation,
    accessPolicy: inputs.descriptor.defaultAccessPolicy,
    atomTier: "data",
    status: "active",
    versionStamp: `${inputs.parcelNodeId}:buildable-envelope:${version}:${extractedAt}`,
    outcome: inputs.outcome,
    reasoningChain: {
      reasoningKind: "derived",
      derivationMethod: BUILDABLE_ENVELOPE_DERIVATION_METHOD,
      inputAtomRefs,
    },
    // assertedConfidence only at write; calibratedConfidence is a placeholder
    // resolved at READ via overlay (I-E) — never a frozen labeling×district multiply.
    readContract: buildPropertyReadContract({
      asserted: composed,
      calibrated: null,
      consequence:
        inputs.outcome.kind === "no-buildable-area" ||
        inputs.outcome.kind === "provisional-front-edge"
          ? {
              kind: "property-risk",
              stratum: "elevated",
              basis: consequenceBasis,
              assertedAt: extractedAt,
            }
          : propertyNotApplicableConsequence(
              "envelope-geometry-derivation-has-no-life-safety-stratum",
              extractedAt,
            ),
      assembledAt: extractedAt,
    }),
    contentHash: "",
  };
  // A6: exclude provenance timestamps (fetchedAt/extractedAt/assembledAt/
  // assertedAt/versionStamp) from the hash — content hash must be
  // rewarm-deterministic, not wall-clock-dependent.
  instance.contentHash = contentHashExcludingTimestamps(instance);
  return instance;
}
