/**
 * Warm → verify → promote orchestrator (27c R3 WDLL 6).
 */

import type { StoragePort } from "@hauska-engine/storage";

import type { JurisdictionDescriptor } from "../property-reasoning/types.js";
import { emitDepthWarmPromotion, promoteDepthWarmToStorage } from "./promote.js";
import type {
  PromotedDepthWarmBundle,
  VerifyResult,
  WarmCandidate,
} from "./types.js";
import { verifyWarmCandidateMechanically } from "./verify-mechanical.js";
import type { WarmComputeInput } from "./warm-compute.js";
import { computeWarmCandidate } from "./warm-compute.js";

export interface WarmThenVerifyInput extends WarmComputeInput {
  descriptor: JurisdictionDescriptor;
  zoningFactAtomDid: string;
  storage?: StoragePort;
  promote?: boolean;
  /** R31 — situs for front-orientation verify gate (optional). */
  situsAddress?: string | null;
}

export interface WarmThenVerifyResult {
  candidate: WarmCandidate;
  verify: VerifyResult;
  promoted: PromotedDepthWarmBundle | null;
  atoms: ReturnType<typeof emitDepthWarmPromotion> | null;
}

/**
 * Full loop: warm compute → mechanical verify → optional promote on pass.
 * Bad warm results fail closed at verify; nothing is promoted.
 */
export async function warmThenVerify(
  input: WarmThenVerifyInput,
): Promise<WarmThenVerifyResult> {
  const candidate = computeWarmCandidate(input);
  const verify = verifyWarmCandidateMechanically(candidate, input.descriptor, {
    situsAddress: input.situsAddress,
    roads: input.roads,
  });

  if (!verify.pass) {
    return { candidate, verify, promoted: null, atoms: null };
  }

  const promoteInput = {
    candidate,
    descriptor: input.descriptor,
    zoningFactAtomDid: input.zoningFactAtomDid,
    situsAddress: input.situsAddress,
  };

  if (input.promote && input.storage) {
    const promoted = await promoteDepthWarmToStorage(input.storage, promoteInput);
    return {
      candidate,
      verify,
      promoted,
      atoms: emitDepthWarmPromotion(promoteInput),
    };
  }

  return {
    candidate,
    verify,
    promoted: null,
    atoms: emitDepthWarmPromotion(promoteInput),
  };
}

/** Verify-only path for an existing warm candidate (e.g. bad inject demo). */
export function verifyOnly(
  candidate: WarmCandidate,
  descriptor: JurisdictionDescriptor,
): VerifyResult {
  return verifyWarmCandidateMechanically(candidate, descriptor);
}
