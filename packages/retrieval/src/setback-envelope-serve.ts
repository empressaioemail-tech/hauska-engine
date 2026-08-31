/**
 * F-11 serve-time mark. Does not delete atoms. Paired: getPropertyAtomChain
 * and assembleChain both call this after R13/R27 so they cannot diverge.
 */

import {
  classifyEnvelopeServe,
  classifySetbackRuleAtom,
  type EnvelopeServeVerdict,
  type SetbackRuleProvenanceInput,
  type SetbackServeVerdict,
} from "@hauska-engine/adapters";

export type { EnvelopeServeVerdict, SetbackServeVerdict };

function asRuleInput(rule: unknown): SetbackRuleProvenanceInput | null {
  if (!rule || typeof rule !== "object") return null;
  return rule as SetbackRuleProvenanceInput;
}

function asEnvelope(envelope: unknown): {
  reasoningChain?: {
    inputAtomRefs?: ReadonlyArray<{
      atomDid?: string;
      entityType?: string;
      role?: string;
    }>;
  };
} | null {
  if (!envelope || typeof envelope !== "object") return null;
  return envelope as {
    reasoningChain?: {
      inputAtomRefs?: ReadonlyArray<{
        atomDid?: string;
        entityType?: string;
        role?: string;
      }>;
    };
  };
}

export function applySetbackProvenanceServe(input: {
  setbackRule: unknown;
  buildableEnvelope: unknown;
}): {
  setbackServe: SetbackServeVerdict;
  envelopeServe: EnvelopeServeVerdict;
} {
  const rule = asRuleInput(input.setbackRule);
  const envelope = asEnvelope(input.buildableEnvelope);
  const setbackServe = classifySetbackRuleAtom(rule);
  const envelopeServe = classifyEnvelopeServe({
    setbackRule: rule,
    envelope,
  });
  return { setbackServe, envelopeServe };
}
