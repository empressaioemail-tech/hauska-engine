import { createHash } from "node:crypto";

import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";

import type { MatchBasis } from "@hauska-engine/atoms";
import type {
  PropertyConsequence,
  ReasoningThreeAxisConfidence,
  WidthedConfidence,
} from "@empressaio/atom-contract/read-contract";

import type { SetbackFieldProvenance } from "./types.js";

export function sha256HexCanonical(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function matchBasisDefaultEstimate(basis: MatchBasis): number {
  switch (basis) {
    case "exact":
      return 0.9;
    case "prefix":
      return 0.7;
    case "fallback":
      return 0.35;
  }
}

export function matchBasisIntervalWidth(basis: MatchBasis): number {
  switch (basis) {
    case "exact":
      return 0.12;
    case "prefix":
      return 0.22;
    case "fallback":
      return 0.45;
  }
}

export function widthedFromFieldProvenance(
  field: SetbackFieldProvenance | undefined,
  basis: MatchBasis,
): WidthedConfidence {
  const estimate = field?.confidence ?? matchBasisDefaultEstimate(basis);
  return createWidthedConfidence({
    estimate,
    n: field ? 1 : 0,
    intervalWidth: matchBasisIntervalWidth(basis),
    provenance:
      field?.verification_state === "human-verified" ? "backtest" : "asserted",
  });
}

export function widthedFromMatchBasis(basis: MatchBasis): WidthedConfidence {
  return createWidthedConfidence({
    estimate: matchBasisDefaultEstimate(basis),
    n: 0,
    intervalWidth: matchBasisIntervalWidth(basis),
    provenance: "asserted",
  });
}

/** Compose derived asserted confidence — minimum across inputs, never multiply. */
export function composeDerivedAssertedConfidence(
  inputs: ReadonlyArray<WidthedConfidence>,
): WidthedConfidence {
  if (inputs.length === 0) {
    return createWidthedConfidence({
      estimate: 0.35,
      n: 0,
      intervalWidth: 0.5,
      provenance: "asserted",
    });
  }
  const minEstimate = Math.min(...inputs.map((c) => c.estimate));
  const minN = Math.min(...inputs.map((c) => c.n));
  const maxWidth = Math.max(...inputs.map((c) => c.intervalWidth));
  const provenance = inputs.some((c) => c.provenance === "live")
    ? "live"
    : inputs.some((c) => c.provenance === "backtest")
      ? "backtest"
      : "asserted";
  return createWidthedConfidence({
    estimate: minEstimate,
    n: minN,
    intervalWidth: maxWidth,
    provenance,
  });
}

export function propertyNotApplicableConsequence(
  reason: string,
  assertedAt: string,
): PropertyConsequence {
  return { kind: "not-applicable", reason, assertedAt };
}

export function buildReasoningReadAxes(args: {
  asserted: WidthedConfidence;
  calibrated?: WidthedConfidence;
  consequence: PropertyConsequence;
}): ReasoningThreeAxisConfidence {
  return {
    assertedConfidence: args.asserted,
    calibratedConfidence:
      args.calibrated ??
      createWidthedConfidence({
        estimate: args.asserted.estimate,
        n: 0,
        intervalWidth: args.asserted.intervalWidth,
        provenance: "seed",
      }),
    consequence: args.consequence,
  };
}

export function propertyEntityId(
  parcelNodeId: string,
  kind: "zoning" | "setback" | "envelope",
  version: number,
): string {
  return `${parcelNodeId}/${kind}-v${version}`;
}

export function nextVersionFromEntityId(entityId: string): number {
  const match = /-v(\d+)$/.exec(entityId);
  if (!match) return 2;
  return Number(match[1]) + 1;
}
