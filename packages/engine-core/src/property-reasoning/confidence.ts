import { createHash } from "node:crypto";

import {
  createReasoningReadContract,
  createWidthedConfidence,
} from "@empressaio/atom-contract/read-contract";

import type { MatchBasis } from "@hauska-engine/atoms";
import type {
  PropertyConsequence,
  ReasoningReadContract,
  ReasoningThreeAxisConfidence,
  WidthedConfidence,
} from "@empressaio/atom-contract/read-contract";

import type { SetbackFieldProvenance } from "./types.js";

export function sha256HexCanonical(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Provenance keys that are PROVENANCE, not CONTENT — timestamps and
 * timestamp-bearing version stamps. Excluded from the content hash so two
 * rewarms of the same content (same geometry / setback values / district /
 * edge-roles / recipe-version) produce the SAME hash even though they ran at
 * different times (OPS-3 I2 — rewarm-determinism). Without this, the atom
 * content-hash changes on every rewarm and persisted==recompute (R10) can
 * never hold. `versionStamp` embeds `extractedAt` (`...:<version>:<ts>`), so it
 * is provenance too and is stripped.
 */
const PROVENANCE_KEYS = new Set<string>([
  "extractedAt",
  "fetchedAt",
  "assembledAt",
  "assertedAt",
  "verifiedAt",
  "depthWarmVerifiedAt",
  "effectiveDate",
  "versionStamp",
]);

/** Recursively drop provenance/timestamp keys so the result hashes by CONTENT. */
function stripProvenance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProvenance);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PROVENANCE_KEYS.has(k)) continue;
      out[k] = stripProvenance(v);
    }
    return out;
  }
  return value;
}

/**
 * Content hash of an atom instance EXCLUDING provenance/timestamp fields. Two
 * atoms with identical content but different warm/extract timestamps hash
 * equal; two atoms with different content hash differently. This is the
 * rewarm-deterministic hash (OPS-3 I2). Use in place of
 * `sha256HexCanonical(JSON.stringify(instance))` for promoted atoms.
 */
export function contentHashExcludingProvenance(instance: unknown): string {
  return sha256HexCanonical(JSON.stringify(stripProvenance(instance)));
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
  /**
   * Placeholder calibrated snapshot at write. Pass `null` to omit a frozen
   * calibrated value (READ resolves via overlay). Never invent a labeling×district
   * multiply here.
   */
  calibrated?: WidthedConfidence | null;
  consequence: PropertyConsequence;
}): ReasoningThreeAxisConfidence {
  const calibrated =
    args.calibrated === null
      ? createWidthedConfidence({
          estimate: args.asserted.estimate,
          n: 0,
          intervalWidth: args.asserted.intervalWidth,
          provenance: "asserted",
        })
      : (args.calibrated ??
        createWidthedConfidence({
          estimate: args.asserted.estimate,
          n: 0,
          intervalWidth: args.asserted.intervalWidth,
          provenance: "seed",
        }));
  return {
    assertedConfidence: args.asserted,
    calibratedConfidence: calibrated,
    consequence: args.consequence,
  };
}

export function buildPropertyReadContract(args: {
  asserted: WidthedConfidence;
  calibrated?: WidthedConfidence | null;
  consequence: PropertyConsequence;
  assembledAt: string;
}): ReasoningReadContract {
  return createReasoningReadContract({
    axes: buildReasoningReadAxes({
      asserted: args.asserted,
      calibrated: args.calibrated,
      consequence: args.consequence,
    }),
    assembledAt: args.assembledAt,
  });
}

/**
 * Canonical active entityId is the parcel node (MCP
 * `did:hauska:<entityType>:<parcelNodeId>`). Versioned history uses `/vN`.
 */
export function propertyEntityId(
  parcelNodeId: string,
  _kind: "zoning" | "setback" | "envelope",
  version: number,
): string {
  if (version <= 1) return parcelNodeId;
  return `${parcelNodeId}/v${version}`;
}

export function nextVersionFromEntityId(entityId: string): number {
  const match = /-v(\d+)$/.exec(entityId);
  if (!match) return 2;
  return Number(match[1]) + 1;
}
