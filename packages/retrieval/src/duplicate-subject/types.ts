/**
 * DUPLICATE-SUBJECT RECONCILIATION — lane SS-W11, PLAN-ROW P-45.
 *
 * A duplicate subject is one FACT about one ENTITY held in more than one
 * store. Two stores of one subject is a by-product of an evolving product
 * (operator ruling 2026-08-19), so the answer is a programme: detect every
 * case, classify each divergence by CAUSE, adjudicate only the residue
 * against ground truth, and retire the loser.
 *
 * The types here exist so the classification cannot cheat. In particular
 * `vintage-undecidable` is a first-class outcome, because the tier2 flood
 * record carries a BAKE TIMESTAMP where an edition string belongs and a fork
 * that assumes both sides name a vintage will silently manufacture a
 * staleness finding.
 */

/* ------------------------------------------------------------------ */
/* Stores                                                              */
/* ------------------------------------------------------------------ */

/**
 * A store is a physical home for values. `db` distinguishes the two
 * databases, which matters: the atoms store and the cortex store are separate
 * Postgres databases on one Neon endpoint, so no join reconciles them and
 * every comparison is an application-level merge.
 */
export interface StoreRef {
  /** Stable key, e.g. "atoms:flood-hazard-fact", "pls:node-facets:tier2". */
  storeKey: string;
  db: "atoms" | "cortex";
  /** Physical table. */
  table: string;
  /**
   * How rows of this store are selected, e.g. `entity_type='flood-hazard-fact'`
   * or `adapter_key='node-facets:tier2'`. Null for a whole-table store.
   */
  discriminator: string | null;
  /**
   * How a value is reached inside the row. A JSON path for a jsonb store, a
   * bare column name for a relational one.
   */
  valuePath: string;
  /**
   * Where this store's SOURCE EDITION is recorded, or null when the store does
   * not record one. Null is load-bearing: it is what forces
   * `vintage-undecidable` instead of a fabricated `edition-differs`.
   */
  editionPath: string | null;
  /**
   * How this store decided the value: the sampling contract. Free text, but it
   * must name the GEOMETRY the store sampled, because "both claim FEMA NFHL"
   * was true of two stores that sampled points up to 366 m apart.
   */
  samplingContract: string;
}

/**
 * The three structural classes of duplication. They take different
 * remediations and merging them produces a wrong retirement recommendation.
 */
export type DuplicationClass =
  /** Two stores derived SEPARATELY from the same authority. Can differ by method AND by edition. */
  | "independent-double-derivation"
  /** One store is a snapshot COPY/TRANSFORM of the other. Can only differ by refresh lag. */
  | "copy-transform"
  /** A tiny cache of a source that is already extinguished. Needs a delete ruling, not a reconciliation. */
  | "vestigial-cache";

/** One canonical fact, and every store that claims to hold it. */
export interface SubjectDeclaration {
  /** Canonical subject key, e.g. "flood-zone", "zoning-district". */
  subject: string;
  /** The entity these stores key on. */
  entityKind: "parcel" | "county" | "jurisdiction";
  duplicationClass: DuplicationClass;
  stores: StoreRef[];
  /**
   * The external authority that settles a residual conflict, or null when
   * there is none and the conflict must go to a human.
   */
  groundTruth: string | null;
  notes: string;
}

/* ------------------------------------------------------------------ */
/* Divergence classification                                           */
/* ------------------------------------------------------------------ */

/**
 * Why two stores hold different values for one entity.
 *
 * `one-sided-*` is deliberately NOT a disagreement — an absent second opinion
 * is not a conflict — but it is counted, because "we only measured where both
 * spoke" is exactly the denominator that made a 0.04% look unlike an 8.69%.
 */
export type DivergenceClass =
  | "agree"
  | "one-sided-a"
  | "one-sided-b"
  | "absent-both"
  /** Each store is CORRECT for the point it sampled; the points differ. */
  | "explained-by-sampling-point"
  /** The entity genuinely holds both values (part AE, part AO). Not a disagreement. */
  | "split-subject"
  /** Same sample point, and ground truth matches exactly one side. The other is stale. */
  | "edition-differs"
  /** At least one side records no source edition, so staleness cannot be tested from the record. */
  | "vintage-undecidable"
  /** Survives every filter. This and only this goes to the authority for adjudication. */
  | "genuine-conflict";

export const DIVERGENCE_CLASSES: readonly DivergenceClass[] = [
  "agree",
  "one-sided-a",
  "one-sided-b",
  "absent-both",
  "explained-by-sampling-point",
  "split-subject",
  "edition-differs",
  "vintage-undecidable",
  "genuine-conflict",
] as const;

/** True when this class counts as a DISAGREEMENT for rate reporting. */
export function isDisagreement(c: DivergenceClass): boolean {
  return (
    c === "explained-by-sampling-point" ||
    c === "split-subject" ||
    c === "edition-differs" ||
    c === "vintage-undecidable" ||
    c === "genuine-conflict"
  );
}

/** True when both stores named a value, i.e. a comparison was possible at all. */
export function isComparable(c: DivergenceClass): boolean {
  return c === "agree" || isDisagreement(c);
}

/** One entity's reading from one store. */
export interface StoreReading {
  present: boolean;
  /** Normalised value, or null when the store holds a row but names no value. */
  value: string | null;
  /** Raw source-edition string, or null when the store records none. */
  edition: string | null;
  /** The point this store sampled, when it sampled one. */
  samplePoint: { lat: number; lng: number } | null;
  /** Free-form status the store recorded, e.g. "unavailable". */
  status: string | null;
}

/** Ground truth re-run for one entity. Absent until the adjudication pass. */
export interface GroundTruthReading {
  /** Zone at store A's sample point, under the current edition. */
  atSamplePointA: string | null;
  /** Zone at store B's sample point, under the current edition. */
  atSamplePointB: string | null;
  /** Every zone the entity's own geometry intersects. */
  entityZoneSet: string[];
  /** Distance between the two sample points in metres. */
  samplePointDistanceM: number | null;
  edition: string;
}

export interface EntityVerdict {
  entityId: string;
  a: StoreReading;
  b: StoreReading;
  groundTruth: GroundTruthReading | null;
  divergence: DivergenceClass;
  /** Why this class and not another, in one line a reader can check. */
  basis: string;
}

/* ------------------------------------------------------------------ */
/* Tally — every rate carries its denominator, inline.                 */
/* ------------------------------------------------------------------ */

export interface PairTally {
  subject: string;
  storeA: string;
  storeB: string;
  countyFips: string;
  /** Every entity either store holds a ROW for. */
  rosterUnion: number;
  rowsA: number;
  rowsB: number;
  /** Entities where BOTH stores name a value. THE denominator for every rate below. */
  comparable: number;
  byClass: Record<DivergenceClass, number>;
  /**
   * disagreements / comparable, with the counting rule spelled out so the
   * ratio can never travel without it.
   */
  disagreementRate: {
    numerator: number;
    denominator: number;
    pct: number;
    countingRule: string;
  };
  /**
   * The SAME numerator over the full roster, printed beside the real rate so a
   * reader can see the denominator gap rather than inherit one side of it.
   * This is the shape that turned one county's 8.71% into another's 0.04%.
   */
  disagreementRateOverRoster: {
    numerator: number;
    denominator: number;
    pct: number;
    countingRule: string;
  };
  editionsA: Record<string, number>;
  editionsB: Record<string, number>;
  statusesB: Record<string, number>;
}
