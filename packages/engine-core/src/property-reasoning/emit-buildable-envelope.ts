import type { BuildableEnvelopeAtomInstance } from "@hauska-engine/atoms";

import {
  buildReasoningReadAxes,
  composeDerivedAssertedConfidence,
  propertyEntityId,
  propertyNotApplicableConsequence,
  sha256HexCanonical,
} from "./confidence.js";
import type { EmitBuildableEnvelopeInputs, HonestAbsence } from "./types.js";

const DERIVATION_METHOD = "buildable-envelope-inset-v1";

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

  const consequenceBasis =
    inputs.outcome.kind === "no-buildable-area"
      ? "no-buildable-area"
      : inputs.outcome.kind === "provisional-front-edge"
        ? "setback-constrained"
        : "routine";

  const instance: BuildableEnvelopeAtomInstance = {
    entityType: "buildable-envelope",
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
    derivationMethod: DERIVATION_METHOD,
    inputAtomRefs: [
      {
        atomDid: inputs.zoningFactAtomDid,
        role: "fact",
        entityType: "zoning-fact",
      },
      {
        atomDid: inputs.setbackRuleAtomDid,
        role: "rule",
        entityType: "setback-rule",
      },
      {
        atomDid: inputs.geometryRefId,
        role: "reference-field",
        citationLabel: "parcel-geometry-ring",
      },
      {
        atomDid: inputs.frontEdgeRefId,
        role: "reference-field",
        citationLabel: "front-edge-anchor",
      },
    ],
    outcome: inputs.outcome,
    reasoningChain: {
      reasoningKind: "derived",
      derivationMethod: DERIVATION_METHOD,
      inputAtomRefs: [
        {
          atomDid: inputs.zoningFactAtomDid,
          role: "fact",
          entityType: "zoning-fact",
        },
        {
          atomDid: inputs.setbackRuleAtomDid,
          role: "rule",
          entityType: "setback-rule",
        },
        {
          atomDid: inputs.geometryRefId,
          role: "reference-field",
          citationLabel: "parcel-geometry-ring",
        },
        {
          atomDid: inputs.frontEdgeRefId,
          role: "reference-field",
          citationLabel: "front-edge-anchor",
        },
      ],
    },
    readAxes: buildReasoningReadAxes({
      asserted: composed,
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
    }),
    contentHash: "",
  };
  instance.contentHash = sha256HexCanonical(JSON.stringify(instance));
  return instance;
}
