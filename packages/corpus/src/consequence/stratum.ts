import type {
  ConsequenceClassificationInputs,
  ConsequenceStratum,
} from "./types.js";

/**
 * Derive consequence strata from classification inputs at read time.
 * No severity scalar is produced — only the explicit input axes.
 */
export function deriveConsequenceStrata(
  inputs: ConsequenceClassificationInputs | undefined,
): ReadonlyArray<ConsequenceStratum> {
  if (!inputs) return [{ kind: "unclassified", value: "none" }];

  const strata: ConsequenceStratum[] = [];

  for (const cat of inputs.asce7RiskCategories ?? []) {
    strata.push({ kind: "asce7-risk-category", value: cat });
  }
  for (const group of inputs.ibcOccupancyGroups ?? []) {
    strata.push({ kind: "ibc-occupancy-group", value: group });
  }
  for (const factor of inputs.ibcImportanceFactors ?? []) {
    strata.push({ kind: "ibc-importance-factor", value: factor });
  }

  return strata.length > 0 ? strata : [{ kind: "unclassified", value: "none" }];
}
