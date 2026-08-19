/**
 * FLOOD ADJUDICATION — the standing check on `flood-hazard-fact` (SS-W17, P-45).
 *
 * PROVENANCE. This is SS-W11's `measureFloodPair` promoted, not replaced. That
 * instrument is the only thing in this estate that has ever adjudicated a
 * determination against an external authority, and its subject — `tier2` — is
 * being retired. Retiring the instrument with its subject would throw away the
 * method, so the method is converted and the subject is dropped.
 *
 * WHAT CHANGED IN THE PROMOTION, and why each change matters.
 *
 *   PAIR -> SINGLE STORE. `measureFloodPair` needed two stores and adjudicated
 *   only where they disagreed. With tier2 gone there is no second store, and
 *   more importantly a disagreement subset was never the right population: a
 *   parcel both stores got wrong the same way was never checked by anything.
 *   This adjudicates the atom against NFHL over the whole roster.
 *
 *   BORROWED POINT -> RECORDED POINT. `measureFloodPair` took store A's sample
 *   point out of store B's record, because the atom did not record the point it
 *   evaluated, and it said so and measured its own stand-in at 99.41 percent.
 *   The writer now stamps the point, so the check reads the point that was
 *   actually used. Where the stamp is absent, that absence is itself the
 *   finding, and the re-derived point is labelled as a stand-in rather than
 *   quietly substituted.
 *
 *   ONE IMPLEMENTATION -> TWO. Containment is computed in JS by the writer and
 *   re-computed in PostGIS by this check. Per DEV_PROCESS 2.4, when one rule
 *   has two implementations the DIVERGENCE TEST is the control.
 */

export type FloodAdjudicationLeg =
  /** Every emitted determination carries a containment stamp. */
  | "stamp-present"
  /** The stamp never says `not-contained`. */
  | "stamp-emittable"
  /** JS containment and PostGIS ST_Contains agree. */
  | "containment-divergence"
  /** The atom's zone equals the NFHL zone at the atom's OWN stamped point. */
  | "zone-adjudication";

/**
 * Which legs a given run grades, and why.
 *
 * Two of these legs measure the STORE (was this corpus written by a gated
 * writer) and two measure the CODE (do the two containment implementations and
 * the external authority agree). They have different natural homes: the code
 * legs can be graded offline in CI against a committed fixture, and the store
 * legs only mean anything against the live store.
 *
 * The selection is a required argument with a required reason rather than an
 * optional flag, so a run cannot quietly narrow its own scope and still print
 * PASS. The reason is echoed into the report.
 */
export interface FloodAdjudicationScope {
  legs: ReadonlyArray<FloodAdjudicationLeg>;
  reason: string;
}

export const CODE_LEGS: FloodAdjudicationScope = {
  legs: ["containment-divergence", "zone-adjudication"],
  reason:
    "offline fixture grade: these two legs are properties of the PREDICATE, so they are gradeable without a database and must stay green on every merge. The two stamp legs are properties of the live STORE and cannot be graded from a fixture.",
};

export const ALL_LEGS: FloodAdjudicationScope = {
  legs: [
    "stamp-present",
    "stamp-emittable",
    "containment-divergence",
    "zone-adjudication",
  ],
  reason:
    "live run: all four legs. The stamp legs will fail against any corpus baked before the SS-W17 containment gate, and that failure is the point — an unstamped determination is UNCHECKED, which is a different state from checked-and-passing.",
};

export type SamplePointSource = "atom-stamp" | "re-derived" | "none";

/**
 * One parcel as the check sees it. Every field is stated rather than derived at
 * read time, so a fixture and a live run present the grader with the same shape
 * and the grader cannot behave differently for one of them.
 */
export interface FloodAdjudicationCase {
  parcelNodeId: string;
  /** Point stamped on the atom. Null when the atom predates the stamp. */
  atomSamplePoint: [number, number] | null;
  /** Containment stamped on the atom. Null when the atom predates the stamp. */
  atomContainment: string | null;
  /**
   * The point actually adjudicated. Equals `atomSamplePoint` when the atom
   * carries one; otherwise a stand-in re-derived by the SHIPPING derivation.
   * Every consumer of this field must also read `samplePointSource`, because a
   * verdict about a stand-in is weaker evidence than a verdict about the point
   * the writer used, and collapsing the two is the flaw SS-W11 declared in its
   * own instrument.
   */
  samplePointUsed: [number, number] | null;
  samplePointSource: SamplePointSource;
  /** Zone the atom claims, or null for an absence record. */
  atomFloodZone: string | null;
  /** True when the atom is an honest absence rather than a zone claim. */
  atomIsAbsence: boolean;
  /** The parcel's own geometry, for the JS containment implementation. */
  parcelGeometry: unknown;
  /**
   * PostGIS ST_Contains(parcel.geom, samplePointUsed). Null when the parcel has
   * no PostGIS geometry — UNMEASURABLE, which is not the same as false.
   */
  postgisContains: boolean | null;
  /**
   * NFHL zone at `samplePointUsed`, from `tx_fema_nfhl_flood_zone`. Null means
   * the point is in no loaded zone, which is not the same as Zone X.
   */
  nfhlZoneAtSamplePoint: string | null;
  /** Which NFHL edition answered. Travels with the verdict, never assumed. */
  nfhlEdition: string | null;
}

export interface FloodAdjudicationFinding {
  leg: FloodAdjudicationLeg;
  parcelNodeId: string;
  detail: string;
}

/**
 * The declared band, stated as data so the close can quote it and a reader can
 * see it was not moved to fit the result.
 *
 * All four are ZERO on purpose. A tolerance above zero on any of these is a
 * statement that some determinations may be made outside their parcel, and the
 * whole reason this lane exists is that no such statement is acceptable.
 */
export interface FloodAdjudicationBands {
  maxUnstamped: number;
  maxNotContainedStamped: number;
  maxContainmentDivergences: number;
  maxZoneDisagreements: number;
}

export const DECLARED_BANDS: FloodAdjudicationBands = {
  maxUnstamped: 0,
  maxNotContainedStamped: 0,
  maxContainmentDivergences: 0,
  maxZoneDisagreements: 0,
};

export interface LegTally {
  checked: number;
  failed: number;
  unmeasurable: number;
}

export interface FloodAdjudicationReport {
  scope: FloodAdjudicationScope;
  /** Population the check actually saw, with its rule. */
  denominators: {
    casesGraded: number;
    withAtomSamplePoint: number;
    withTestableRing: number;
    withPostgisGeom: number;
    withNfhlAnswer: number;
    bySamplePointSource: Record<SamplePointSource, number>;
    countingRule: string;
  };
  legs: {
    stampPresent: LegTally;
    stampEmittable: LegTally;
    containmentDivergence: LegTally;
    zoneAdjudication: LegTally;
  };
  /**
   * Zone verdicts taken against a RE-DERIVED stand-in point. Reported and never
   * banded: a corpus written before the stamp existed would make this
   * permanently red, and a gate nobody can get to green gets ignored
   * (DEV_PROCESS 2.0). It becomes banded the moment the corpus carries stamps,
   * because then it stops being a stand-in.
   */
  zoneAdjudicationOnStandInPoint: LegTally;
  containmentStates: {
    contained: number;
    notContained: number;
    unmeasurable: number;
  };
  bands: FloodAdjudicationBands;
  findings: FloodAdjudicationFinding[];
  pass: boolean;
  /** Why it failed, one line per breached band. Empty when it passed. */
  breaches: string[];
}
