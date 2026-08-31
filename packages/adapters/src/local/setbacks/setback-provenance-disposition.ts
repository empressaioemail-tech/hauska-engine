/**
 * F-11 — three setback populations stay three populations.
 *
 * A road class is not a setback. A storage-port proof DID is not a
 * dimensional record. Collapsing either into `value` or `absent-verified`
 * is the defect this module exists to refuse.
 *
 * Atoms are not deleted here. Callers mark and let the serve path decide.
 */

export const ROAD_CLASS_SETBACK_PROVENANCE = "road-class-setback-table" as const;
export const PLACEHOLDER_SETBACK_PROVENANCE = "storage-port-proof/phase-1a" as const;

export const RETIRED_ROAD_CLASS_SETBACK_BASIS =
  "refused: retired derivation road-class-setback-table — a road class is not a setback";

export const PLACEHOLDER_SETBACK_UNKNOWN_BASIS =
  "unknown: source cites storage-port-proof/phase-1a — nobody looked";

export const NO_SETBACK_RULE_ENVELOPE_BASIS =
  "refused: buildable-envelope has no setback-rule input";

export type SetbackServeDisposition = "value" | "refused" | "unknown";

export interface SetbackServeVerdict {
  disposition: SetbackServeDisposition;
  basis: string;
}

export interface EnvelopeServeVerdict extends SetbackServeVerdict {
  namedRuleSource: string | null;
}

const PLACEHOLDER_MARKERS = [
  PLACEHOLDER_SETBACK_PROVENANCE,
  `did:hauska:code-section:${PLACEHOLDER_SETBACK_PROVENANCE}`,
] as const;

function citesPlaceholder(raw: string | null | undefined): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  const n = raw.toLowerCase();
  return PLACEHOLDER_MARKERS.some((m) => n.includes(m.toLowerCase()));
}

function citesRoadClass(raw: string | null | undefined): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  return raw.trim() === ROAD_CLASS_SETBACK_PROVENANCE;
}

/** Edge `setback` as stored on property-boundary-edge. */
export type BoundarySetbackBody =
  | { feet: number; provenance?: string; atomCitation?: string }
  | { kind: string; reason?: string };

export function classifyBoundaryEdgeSetback(
  setback: BoundarySetbackBody | null | undefined,
): SetbackServeVerdict | { disposition: "absent"; basis: string } {
  if (!setback || typeof setback !== "object") {
    return { disposition: "absent", basis: "no setback object on edge" };
  }
  if ("kind" in setback && typeof setback.kind === "string") {
    return {
      disposition: "absent",
      basis: setback.reason ?? setback.kind,
    };
  }
  const resolved = setback as {
    feet: number;
    provenance?: string;
    atomCitation?: string;
  };
  if (citesRoadClass(resolved.provenance) || citesRoadClass(resolved.atomCitation)) {
    return { disposition: "refused", basis: RETIRED_ROAD_CLASS_SETBACK_BASIS };
  }
  if (citesPlaceholder(resolved.provenance) || citesPlaceholder(resolved.atomCitation)) {
    return { disposition: "unknown", basis: PLACEHOLDER_SETBACK_UNKNOWN_BASIS };
  }
  return {
    disposition: "value",
    basis: resolved.provenance
      ? `value: edge provenance ${resolved.provenance}`
      : "value: resolved setback with no retired or placeholder provenance",
  };
}

export interface SetbackRuleProvenanceInput {
  sourceAdapter?: string | null;
  sourceCitation?: string | null;
  entityId?: string | null;
  sourceCodeAtomRef?: { atomDid?: string | null } | null;
  fieldProvenance?: {
    front?: { atomDid?: string | null; notSpecified?: boolean };
    side?: { atomDid?: string | null; notSpecified?: boolean };
    rear?: { atomDid?: string | null; notSpecified?: boolean };
  } | null;
}

export function classifySetbackRuleAtom(
  rule: SetbackRuleProvenanceInput | null | undefined,
): SetbackServeVerdict {
  if (!rule) {
    return {
      disposition: "refused",
      basis: "refused: no setback-rule atom",
    };
  }
  const dids = [
    rule.sourceCodeAtomRef?.atomDid,
    rule.fieldProvenance?.front?.atomDid,
    rule.fieldProvenance?.side?.atomDid,
    rule.fieldProvenance?.rear?.atomDid,
    rule.sourceCitation,
    rule.sourceAdapter,
    rule.entityId,
  ];
  if (dids.some((d) => citesRoadClass(d ?? null))) {
    return { disposition: "refused", basis: RETIRED_ROAD_CLASS_SETBACK_BASIS };
  }
  if (dids.some((d) => citesPlaceholder(d ?? null))) {
    return { disposition: "unknown", basis: PLACEHOLDER_SETBACK_UNKNOWN_BASIS };
  }
  return {
    disposition: "value",
    basis: rule.sourceAdapter
      ? `value: setback-rule sourceAdapter ${rule.sourceAdapter}`
      : "value: setback-rule with no retired or placeholder citation",
  };
}

function namedSetbackRuleDid(envelope: {
  reasoningChain?: { inputAtomRefs?: ReadonlyArray<{ atomDid?: string; entityType?: string; role?: string }> };
} | null | undefined): string | null {
  const refs = envelope?.reasoningChain?.inputAtomRefs;
  if (!Array.isArray(refs)) return null;
  const hit = refs.find(
    (r) =>
      r &&
      (r.entityType === "setback-rule" || r.role === "rule") &&
      typeof r.atomDid === "string" &&
      r.atomDid.trim().length > 0,
  );
  return hit?.atomDid ?? null;
}

/**
 * Envelope with no usable setback-rule input is a computed value with no
 * input. Name the cited rule DID when present; still refuse the value when
 * that rule is missing, refused, or unknown. Do not recompute.
 */
export function classifyEnvelopeServe(input: {
  setbackRule: SetbackRuleProvenanceInput | null | undefined;
  envelope: {
    reasoningChain?: { inputAtomRefs?: ReadonlyArray<{ atomDid?: string; entityType?: string; role?: string }> };
  } | null | undefined;
}): EnvelopeServeVerdict {
  const namedRuleSource = namedSetbackRuleDid(input.envelope);
  if (!input.envelope) {
    return {
      disposition: "refused",
      basis: "refused: no buildable-envelope atom",
      namedRuleSource,
    };
  }
  if (!input.setbackRule) {
    return {
      disposition: "refused",
      basis: namedRuleSource
        ? `${NO_SETBACK_RULE_ENVELOPE_BASIS}; envelope names ${namedRuleSource} which is not on file`
        : NO_SETBACK_RULE_ENVELOPE_BASIS,
      namedRuleSource,
    };
  }
  const rule = classifySetbackRuleAtom(input.setbackRule);
  if (rule.disposition !== "value") {
    return { ...rule, namedRuleSource };
  }
  return {
    disposition: "value",
    basis: namedRuleSource
      ? `value: envelope names setback-rule ${namedRuleSource}`
      : "value: setback-rule on file is a dimensional record",
    namedRuleSource,
  };
}
