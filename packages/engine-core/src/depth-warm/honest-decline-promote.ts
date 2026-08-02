/**
 * R27 / force-overwrite — supersede stale depth-warm promotes with an honest
 * verify-fail decline (recipe-version stamped, NO depthWarmPromotion marker).
 */
import type { StoragePort } from "@hauska-engine/storage";
import {
  BUILDABLE_ENVELOPE_DERIVATION_METHOD,
  buildAtomDid,
  type BuildableEnvelopeAtomInstance,
} from "@hauska-engine/atoms";
import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";
import {
  buildPropertyReadContract,
  contentHashExcludingProvenance,
  propertyEntityId,
} from "../property-reasoning/confidence.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";
import { writePropertyAtomIfEnabled } from "../property-reasoning/write-property-atom.js";
import { RECIPE_VERSION } from "./types.js";

export interface HonestVerifyDeclineInput {
  parcelNodeId: string;
  zoningFactAtomDid: string;
  descriptor: JurisdictionDescriptor;
  verifyReasons: string[];
  declineCode: string;
  extractedAt?: string;
}

/**
 * Write a no-buildable-area envelope that supersedes stale promoted atoms.
 * Omits depthWarmPromotion so cert roster excludes it; carries recipeVersion.
 */
export async function promoteHonestVerifyDecline(
  storage: StoragePort,
  input: HonestVerifyDeclineInput,
): Promise<{ buildableEnvelopeAtomDid: string } | null> {
  const extractedAt = input.extractedAt ?? new Date().toISOString();
  const version = 1;
  const entityId = propertyEntityId(input.parcelNodeId, "envelope", version);
  const atomDid = buildAtomDid("buildable-envelope", entityId).raw;
  const declineReason =
    input.verifyReasons.slice(0, 3).join("; ") ||
    "Mechanical warm verify failed — honest decline.";

  const instance: BuildableEnvelopeAtomInstance & {
    recipeVersion?: string;
    warmVerifyDecline?: string;
    warmVerifyDeclineCode?: string;
  } = {
    entityType: "buildable-envelope",
    atomDid,
    entityId,
    jurisdictionTenant: input.descriptor.jurisdictionTenant,
    parcelNodeId: input.parcelNodeId,
    fetchedAt: extractedAt,
    extractedAt,
    sourceAdapter: input.descriptor.sourceAdapter,
    sourceUrl: input.descriptor.sourceUrl ?? "",
    sourceCitation: "depth-warm-verify-decline",
    accessPolicy: input.descriptor.defaultAccessPolicy,
    atomTier: "data",
    status: "active",
    versionStamp: `${input.parcelNodeId}:buildable-envelope-decline:${version}:${extractedAt}`,
    outcome: {
      kind: "no-buildable-area",
      reason: declineReason,
    },
    reasoningChain: {
      reasoningKind: "derived",
      derivationMethod: BUILDABLE_ENVELOPE_DERIVATION_METHOD,
      inputAtomRefs: [
        {
          atomDid: input.zoningFactAtomDid,
          role: "fact",
          entityType: "zoning-fact",
        },
      ],
    },
    readContract: buildPropertyReadContract({
      asserted: createWidthedConfidence({
        estimate: 0.5,
        n: 0,
        intervalWidth: 0.2,
        provenance: "asserted",
      }),
      calibrated: null,
      consequence: {
        kind: "property-risk",
        stratum: "elevated",
        basis: "no-buildable-area",
        assertedAt: extractedAt,
      },
      assembledAt: extractedAt,
    }),
    contentHash: "",
    recipeVersion: RECIPE_VERSION,
    warmVerifyDecline: declineReason,
    warmVerifyDeclineCode: input.declineCode,
  };
  instance.contentHash = contentHashExcludingProvenance(instance);

  const result = await writePropertyAtomIfEnabled(storage, instance);
  if (!result) return null;
  return { buildableEnvelopeAtomDid: result.atomDid };
}

/** Classify verify-fail reasons into a bucket key for STEP 0 diagnosis. */
export function bucketVerifyFailReasons(reasons: string[]): string {
  const text = reasons.join(" ").toLowerCase();
  if (text.includes("superseded") || text.includes("absent from county cadastral")) {
    return "superseded-prop-id";
  }
  if (text.includes("inset ring is null") || text.includes("marked empty")) {
    return "null-inset";
  }
  if (text.includes("classification") && text.includes("osm")) {
    return "road-classification-mismatch";
  }
  if (text.includes("orientation") || text.includes("front")) {
    return "front-orientation";
  }
  if (text.includes("facesanswer") || text.includes("situs")) {
    return "faces-answer";
  }
  if (text.includes("r32")) {
    return "r32-per-edge-inset";
  }
  if (text.includes("geometry") || text.includes("ring")) {
    return "geometry";
  }
  if (text.includes("setback")) {
    return "setback-edge-distance";
  }
  return "other-verify-fail";
}
