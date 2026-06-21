/**
 * F2 — Consequence classification inputs on code-section atoms.
 *
 * These are parsed classification inputs (ASCE 7 risk category, IBC
 * occupancy / importance), not a derived severity scalar. Downstream
 * surfaces derive consequence stratum at read time.
 */

/** ASCE 7-22 Table 1.5-1 risk categories. */
export type Asce7RiskCategory = "I" | "II" | "III" | "IV";

export interface ConsequenceSourceSpan {
  field: "asce7RiskCategories" | "ibcOccupancyGroups" | "ibcImportanceFactors";
  excerpt: string;
}

export interface ConsequenceClassificationInputs {
  /** Risk categories referenced or defined in section prose. */
  asce7RiskCategories?: ReadonlyArray<Asce7RiskCategory>;
  /** IBC occupancy groups (e.g. R-2, B, A-1). */
  ibcOccupancyGroups?: ReadonlyArray<string>;
  /** IBC importance factors (1.0, 1.25, 1.5) as strings for exact carry. */
  ibcImportanceFactors?: ReadonlyArray<string>;
  /** Audit trail back to source prose. */
  sourceSpans?: ReadonlyArray<ConsequenceSourceSpan>;
  /** ISO timestamp when inputs were parsed. */
  parsedAt?: string;
}

export type ConsequenceStratumKind =
  | "asce7-risk-category"
  | "ibc-occupancy-group"
  | "ibc-importance-factor"
  | "unclassified";

export interface ConsequenceStratum {
  kind: ConsequenceStratumKind;
  value: string;
}
