import type {
  BuildableEnvelopeAtomInstance,
  StoredAtomInstance,
} from "@hauska-engine/atoms";

export const DEPTH_WARM_PROMOTION_MARKER = "depth-warm-promoted-v1";

/**
 * Engine-extension fields written onto `BuildableEnvelopeAtomInstance` by
 * `packages/engine-core/src/depth-warm/promote.ts` and
 * `honest-decline-promote.ts`. Not part of the published atom contract —
 * mirrors the same ad hoc intersection idiom used at those write sites.
 */
type DepthWarmBuildableEnvelope = BuildableEnvelopeAtomInstance & {
  depthWarmPromotion?: string;
  warmVerifyDecline?: string;
  warmVerifyDeclineCode?: string;
};

function isBuildableEnvelope(
  envelope: StoredAtomInstance,
): envelope is DepthWarmBuildableEnvelope {
  return envelope.entityType === "buildable-envelope";
}

/**
 * R27 companion — warm-verify declines and depth-warm promotes are NOT dependents
 * of a stale pre-layer-23 setback rule; they must survive stale-setback suppression.
 */
export function envelopeServeIndependentOfStaleSetback(
  envelope: StoredAtomInstance | null | undefined,
): boolean {
  if (!envelope || typeof envelope !== "object") return false;
  if (!isBuildableEnvelope(envelope)) return false;
  if (envelope.depthWarmPromotion === DEPTH_WARM_PROMOTION_MARKER) return true;
  if (
    typeof envelope.warmVerifyDecline === "string" &&
    envelope.warmVerifyDecline.trim().length > 0
  ) {
    return true;
  }
  if (
    typeof envelope.warmVerifyDeclineCode === "string" &&
    envelope.warmVerifyDeclineCode.trim().length > 0
  ) {
    return true;
  }
  const citation = envelope.sourceCitation;
  return (
    typeof citation === "string" &&
    citation.toLowerCase().includes("depth-warm-verify-decline")
  );
}
