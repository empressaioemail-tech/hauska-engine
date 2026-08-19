/**
 * Measurement specs for the six county rails that have never been scored
 * anywhere in Texas. Lane SS-W14 under OPS-16 amendment A-020 (P-47).
 *
 * Read `README.md` in this directory first. It is the human-readable spec;
 * `specs.ts` is the same content in a shape a scorer can import.
 */

export type {
  CellMeasurement,
  CellScore,
  CellVerdict,
  CeilingSpec,
  CoverageUnit,
  DenominatorSpec,
  RailScoringSpec,
  StateDiscriminator,
  UnscoredRailKey,
} from "./types.js";

export { UNSCORED_RAIL_KEYS } from "./types.js";

export {
  EASEMENT_SPEC,
  FOOTPRINT_SPEC,
  RAIL_CORRIDOR_SPEC,
  RAIL_SCORING_SPECS,
  RAIL_SCORING_SPEC_BY_KEY,
  ROADS_SPEC,
  RRC_PIPELINES_SPEC,
  RRC_WELLS_SPEC,
} from "./specs.js";

export type { DeterminationCeilingSet } from "./score-cell.js";

export {
  GUARD_ABSENCE_WITHOUT_BASIS,
  GUARD_NEGATIVE_INPUT,
  GUARD_ORPHAN_DETERMINATION,
  GUARD_OVER_100,
  GUARD_UNSCORABLE_RAIL,
  countingRuleFor,
  determinationCeilingSet,
  isPublishable,
  scoreCell,
} from "./score-cell.js";
