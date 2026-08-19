/**
 * MEASUREMENT SPEC RECORD for the six county rails that have never been scored
 * anywhere in Texas: roads, footprint, easement, rrc-wells, rrc-pipelines,
 * rail-corridor. Lane SS-W14 under OPS-16 amendment A-020 (P-47).
 *
 * WHY THIS FILE EXISTS. hauska-engine ships twelve county writers.
 * legacy-design-tools ships three scorer CLIs. Nobody ever wrote down what
 * scoring a rail MEANS, so six rails carry zero rows in `county_facet_coverage`
 * and are permanently not-yet on the console no matter what the store holds.
 * Verified 2026-08-19 against cortex: the table holds nine facet values (cad,
 * envelope, flood, geometry, land-use, landuse, mud, owner, zoning) and none of
 * the six is among them. That is 1,524 of 3,556 cells, 42.9% of the manifest
 * grid, with 35,159,990 atom rows behind it.
 *
 * THIS FILE DOES NOT SCORE ANYTHING. It is the contract a scorer plugs into.
 * Lane SS-W12 is building the scorer capability; this record is what it should
 * be told to compute, expressed so a stranger can evaluate it without us.
 *
 * THREE STATES, NOT TWO. Every rail distinguishes:
 *
 *   COVERED             a positive determination that the thing IS there
 *   ESTABLISHED-ABSENCE a positive determination that the thing is NOT there
 *   NOT-YET             no determination was made
 *
 * Collapsing the last two is the defect the honest-absence work exists to
 * prevent, and an empty result is never an absence. Every absence carries a
 * basis or it is not an absence.
 *
 * TWO CEILINGS, NOT ONE. `mud 209/186` went over 100% because absences were
 * scored inside the acquisition fraction. They are different sets:
 *
 *   ACQUISITION CEILING   counties where the source HAS features. Bounds
 *                         satisfied-present only.
 *   DETERMINATION CEILING counties where a determination can be made AT ALL,
 *                         including a negative one. Bounds satisfied-present
 *                         PLUS satisfied-absent, and is the coverage denominator.
 *
 * A ceiling is a SET of county FIPS, never a count. SS-W9 recorded 2 cells
 * called out-of-reach purely because the live capability probe returns a COUNT
 * and no instrument could say WHICH counties it meant.
 */

/** The six rails this record covers. The other eight already carry ledger rows. */
export type UnscoredRailKey =
  | "roads"
  | "footprint"
  | "easement"
  | "rrc-wells"
  | "rrc-pipelines"
  | "rail-corridor";

export const UNSCORED_RAIL_KEYS: ReadonlyArray<UnscoredRailKey> = [
  "roads",
  "footprint",
  "easement",
  "rrc-wells",
  "rrc-pipelines",
  "rail-corridor",
];

/**
 * What ONE unit of coverage IS for a rail. This is the single question that
 * was never answered, and getting it wrong is not recoverable downstream:
 * a per-parcel denominator on a county-unit rail invents millions of holes.
 */
export type CoverageUnit =
  /** One parcel on the county roster. Ratio is parcels determined over parcels. */
  | "parcel"
  /** One county. The rail resolves at county granularity and has no parcel ratio. */
  | "county"
  /** One source feature (an OSM way, a corridor segment). NOT a parcel. */
  | "source-feature"
  /**
   * The rail's unit is parcel for some counties and county for others, decided
   * by a routing table. A single denominator is a category error; both regimes
   * are reported with their own counts.
   */
  | "hybrid-parcel-or-county";

/**
 * How a rail's three states are READ OUT of the store. This is where a scorer
 * gets silently wrong: for three of the six rails the state is not visible in
 * `entity_id` at all and an index-only prefix scan cannot see it.
 */
export type StateDiscriminator =
  /** `entity_id` suffix alone tells covered from absent. Index-only scan works. */
  | "entity-id-suffix"
  /** Only a jsonb body field tells them apart. The scan must touch the heap. */
  | "body-field"
  /** The rail has no absence atom; "not there" is a present atom with a false flag. */
  | "present-with-negative-flag"
  /** No atoms of this family exist at all today, so no discriminator is observable. */
  | "unobservable-family-empty";

/**
 * The DENOMINATOR and, inseparably, the rule that produced it. A coverage
 * figure travels with its denominator or it does not ship.
 */
export interface DenominatorSpec {
  /** One line naming the set, in words a stranger can act on. */
  rule: string;
  /** The query or procedure that produces it, precisely enough to re-run. */
  derivation: string;
  /**
   * The class this denominator deliberately EXCLUDES, measured and published
   * beside the ratio, never subtracted from it. An instrument's exclusion set
   * is part of its contract and belongs where its output is read.
   */
  exclusionClass: string | null;
  /**
   * A second, independently measured denominator for the same rail. Where the
   * two disagree, the disagreement is the finding and is reported, not rounded.
   * `null` where only one measured denominator exists.
   */
  secondMeasure: string | null;
  /** What was measured at source to justify this choice, with the numbers. */
  evidence: string;
}

/**
 * A rail's reachable ceilings, expressed as SETS, with the query that yields
 * each set. Never a bare count.
 */
export interface CeilingSpec {
  /** Counties where the source carries features. Bounds satisfied-present. */
  acquisitionCeilingRule: string;
  /**
   * Counties where a determination can be made at all, negative included.
   * Bounds satisfied-present PLUS satisfied-absent, and is what a coverage
   * denominator may use.
   */
  determinationCeilingRule: string;
  /** The value the live ledger publishes today, carried verbatim for comparison. */
  ledgerPublishesToday: string;
  /** This lane's re-derived verdict, with the evidence that produced it. */
  reDerivedVerdict: string;
}

/** One rail's complete measurement spec. */
export interface RailScoringSpec {
  railKey: UnscoredRailKey;
  /** The atom entity_type(s) this rail is actually made of, read at source. */
  atomEntityTypes: ReadonlyArray<string>;
  /** The `entity_id` shape, which decides whether an index-only scan can work. */
  entityIdShape: string;
  /** Declared threshold from the live `county_rail` row, read 2026-08-19. */
  thresholdPct: number;
  /** `spine` or `derived`, from the live `county_rail` row. */
  railKind: "spine" | "derived";

  unit: CoverageUnit;
  discriminator: StateDiscriminator;

  /** What a positive determination that the thing IS there looks like. */
  coveredDefinition: string;
  /** What a positive determination that the thing is NOT there looks like. */
  establishedAbsenceDefinition: string;
  /** What no-determination looks like. Never inferred from an empty result. */
  notYetDefinition: string;
  /**
   * Determinations the writer emits that LOOK like an established absence and
   * are not one, because they record an instrument or input failure rather than
   * a finding about the world. A scorer that counts these is manufacturing
   * absences. Empty array only where no such shape exists.
   */
  falseAbsenceShapes: ReadonlyArray<string>;

  denominator: DenominatorSpec;
  ceiling: CeilingSpec;

  /**
   * True when the rail CANNOT be scored as a percentage from what the writer
   * emits today. This is a finding, not a blocker to work around.
   */
  scorableToday: boolean;
  /** Why not, and what would have to exist. Empty string when scorable. */
  blockingGap: string;

  /** What the writer emits, read at source in hauska-engine on this branch. */
  writerSource: string;
  /** What this lane measured live, with the numbers and the date. */
  measuredEvidence: ReadonlyArray<string>;
}

/**
 * The three states a scorer resolves a cell to, plus the two it must never
 * silently produce.
 */
export type CellVerdict =
  | "satisfied-present"
  | "satisfied-absent"
  | "not-yet"
  | "out-of-reach"
  | "not-measured";

/** A scorer's input for one rail in one county, all four numbers measured. */
export interface CellMeasurement {
  countyFips: string;
  railKey: UnscoredRailKey;
  /** Positive determinations that the thing IS there. */
  covered: number;
  /** Positive determinations that the thing is NOT there. */
  establishedAbsent: number;
  /** The denominator, per this rail's DenominatorSpec. */
  denominator: number;
  /**
   * Determinations that matched no roster member. Measured, never assumed
   * zero: an orphan determination is how a ratio goes over 100%.
   */
  orphanDeterminations: number;
  /** True when this county is inside the rail's DETERMINATION ceiling set. */
  insideDeterminationCeiling: boolean;
  /** False where the scorer did not run for this cell. Never inferred. */
  measured: boolean;
}

/** A scorer's output for one cell, with everything a reader needs to check it. */
export interface CellScore {
  countyFips: string;
  railKey: UnscoredRailKey;
  verdict: CellVerdict;
  /**
   * (covered + establishedAbsent) / denominator, as a percentage. `null`
   * whenever the cell was not measured or is out of reach, never zero.
   */
  coveragePct: number | null;
  /** Inline counting rule, at the point of use. Never in an appendix. */
  countingRule: string;
  /** Required and non-empty whenever verdict is satisfied-absent. */
  absenceBasis: string | null;
  /** Defects the guards caught. Non-empty means the number is not publishable. */
  guardViolations: ReadonlyArray<string>;
}
