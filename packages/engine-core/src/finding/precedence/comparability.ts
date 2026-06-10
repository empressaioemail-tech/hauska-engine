/**
 * Stringency comparison helpers for deterministic precedence resolution.
 */

import type { ApplicableRequirement, RequirementKind } from "./types";

export interface StringencyComparison {
  /** Negative = a is less stringent; positive = a is more stringent; 0 = equal. */
  delta: number;
  comparable: boolean;
  note: string;
}

function numericStringency(
  kind: RequirementKind,
  value: number,
): (other: number) => StringencyComparison {
  return (other: number) => {
    if (kind === "minimum") {
      const delta = value - other;
      return {
        delta,
        comparable: true,
        note:
          delta === 0
            ? "Equal minimum values"
            : delta > 0
              ? "Higher minimum is more stringent"
              : "Lower minimum is less stringent",
      };
    }
    if (kind === "maximum") {
      const delta = other - value;
      return {
        delta,
        comparable: true,
        note:
          delta === 0
            ? "Equal maximum values"
            : delta > 0
              ? "Lower maximum is more stringent"
              : "Higher maximum is less stringent",
      };
    }
    if (kind === "exact") {
      const delta = Math.abs(value - other) === 0 ? 0 : value > other ? 1 : -1;
      return {
        delta,
        comparable: true,
        note: delta === 0 ? "Exact values match" : "Exact values differ — conflict",
      };
    }
    return { delta: 0, comparable: false, note: "Unsupported numeric kind" };
  };
}

/** Compare two requirements on stringency when they share a topic + kind. */
export function compareStringency(
  a: ApplicableRequirement,
  b: ApplicableRequirement,
): StringencyComparison {
  if (a.requirementKind !== b.requirementKind) {
    return {
      delta: 0,
      comparable: false,
      note: `Incomparable kinds: ${a.requirementKind} vs ${b.requirementKind}`,
    };
  }

  if (a.requirementKind === "qualitative") {
    if (a.textValue === b.textValue) {
      return { delta: 0, comparable: true, note: "Qualitative requirements match" };
    }
    return {
      delta: 0,
      comparable: false,
      note: `Qualitative conflict: "${a.textValue ?? ""}" vs "${b.textValue ?? ""}"`,
    };
  }

  if (a.numericValue === undefined || b.numericValue === undefined) {
    return { delta: 0, comparable: false, note: "Missing numeric value for comparison" };
  }

  return numericStringency(a.requirementKind, a.numericValue)(b.numericValue);
}

/** Pick the most stringent requirement from a pool; ties keep first-seen order. */
export function pickMostStringent(
  pool: readonly ApplicableRequirement[],
): { governing: ApplicableRequirement; note: string } | null {
  if (pool.length === 0) return null;
  if (pool.length === 1) {
    return { governing: pool[0]!, note: "Single candidate in pool" };
  }

  let governing = pool[0]!;
  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[i]!;
    const cmp = compareStringency(candidate, governing);
    if (!cmp.comparable) continue;
    if (cmp.delta > 0) governing = candidate;
  }
  return {
    governing,
    note: `Most stringent among ${pool.length} comparable requirements`,
  };
}

/** True when every pair in the pool is comparable and agrees on stringency. */
export function allAlign(pool: readonly ApplicableRequirement[]): boolean {
  if (pool.length <= 1) return true;
  const first = pool[0]!;
  for (let i = 1; i < pool.length; i++) {
    const cmp = compareStringency(first, pool[i]!);
    if (!cmp.comparable || cmp.delta !== 0) return false;
  }
  return true;
}
