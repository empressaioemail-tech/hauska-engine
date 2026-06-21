/**
 * F8 — amendment hazard rate scaffold.
 *
 * Computes a per-class hazard rate from code-amendment atoms. With zero
 * amendments in the production corpus, returns the cold-start prior floor
 * until amendment fuel lands (Wave 1 finding).
 */

import type { CodeAmendmentAtomInstance } from "@hauska-engine/atoms";

/** Cold-start prior hazard rate (events per section-year) before amendment fuel. */
export const AMENDMENT_HAZARD_COLD_START_PRIOR = 0.02;

export type HazardRateSource = "cold-start-prior" | "amendment-history";

export interface AmendmentHazardRate {
  /** Hazard rate λ (amendments affecting class per year). */
  rate: number;
  source: HazardRateSource;
  amendmentCount: number;
  /** Window length in years used when source is amendment-history. */
  observationYears: number | null;
  atomClass: string;
  asOf: string;
}

function yearsBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
  return Math.max(1, (end - start) / (365.25 * 24 * 60 * 60 * 1000));
}

/**
 * Compute hazard rate for a section class. Without amendment atoms, always
 * returns the cold-start prior so V8/S2 can wire the signal shape early.
 */
export function computeAmendmentHazardRate(args: {
  atomClass: string;
  amendments: ReadonlyArray<CodeAmendmentAtomInstance>;
  asOf?: string;
  /** Minimum rate floor — defaults to cold-start prior. */
  floor?: number;
}): AmendmentHazardRate {
  const asOf = args.asOf ?? new Date().toISOString();
  const floor = args.floor ?? AMENDMENT_HAZARD_COLD_START_PRIOR;

  if (args.amendments.length === 0) {
    return {
      rate: floor,
      source: "cold-start-prior",
      amendmentCount: 0,
      observationYears: null,
      atomClass: args.atomClass,
      asOf,
    };
  }

  const dates = args.amendments
    .map((a) => a.effectiveDate)
    .filter((d) => typeof d === "string" && d.length > 0)
    .sort();
  const earliest = dates[0] ?? asOf;
  const observationYears = yearsBetween(earliest, asOf);
  const rawRate = args.amendments.length / observationYears;
  const rate = Math.max(floor, rawRate);

  return {
    rate,
    source: "amendment-history",
    amendmentCount: args.amendments.length,
    observationYears,
    atomClass: args.atomClass,
    asOf,
  };
}

/** Validity decay multiplier from hazard rate and age in years. */
export function validityDecayFromHazard(
  hazardRate: number,
  ageYears: number,
): number {
  if (ageYears <= 0) return 1;
  return Math.exp(-hazardRate * ageYears);
}
