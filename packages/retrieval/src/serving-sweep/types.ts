// The STATEWIDE SERVING SWEEP record — frozen 2026-08-18 by the planner.
//
// The County Manifest answers "did a writer run for this county". This answers
// a different question: "what does Smart Site actually SERVE a human, for every
// parcel in this county". The two live side by side on the County Manifest
// subtab precisely because they will disagree, and the disagreement is the
// finding.
//
// The sweep resolves a ParcelFactSheet for every parcel in a county and
// tallies the resulting Fact states. It never samples. Sampling is what
// certified a broken Bastrop once.

export type FieldKey =
  | "geometry"
  | "situsAddress"
  | "apn"
  | "landUse"
  | "zoning"
  | "setbacks"
  | "envelope"
  | "flood"
  | "frontage";

/** Tally of Fact states across every parcel in the county for one field. */
export interface FieldTally {
  present: number;
  absentCovered: number;
  absentUncovered: number;
  /** Lookup FAILED. Non-zero here is an outage, not a coverage gap. */
  unresolved: number;
}

/**
 * A contradiction is two surfaces disagreeing about the SAME parcel. These are
 * the defects a coverage percentage cannot see, and they are what the QA pass
 * of 2026-08-18 surfaced by hand.
 */
export type ContradictionKind =
  /** envelope.kind === "not-derived" while an area was rendered somewhere. */
  | "envelope-not-derived-but-area-shown"
  /** More than one distinct flood zone reported by different code paths. */
  | "flood-zone-disagreement"
  /** Report says a field is unavailable that identity or geometry carries. */
  | "field-unavailable-but-present-upstream"
  /** situsAddress absent on the sheet but present on the county CAD roll. */
  | "address-absent-but-on-cad-roll"
  /** Setbacks present on the card, absent on the brief, or the reverse. */
  | "setbacks-present-card-absent-brief";

export interface ContradictionTally {
  kind: ContradictionKind;
  count: number;
  /** Up to 20 parcel node ids, for the operator to open directly. */
  exampleParcelNodeIds: string[];
}

export interface CountyServingSweep {
  countyFips: string;
  countyName: string;
  sweptAt: string;
  /** The ParcelFactSheet resolverVersion this sweep ran against. */
  resolverVersion: string;

  parcelsTotal: number;
  /** Parcels the sweep could not resolve at all. Distinct from any tally. */
  parcelsUnresolvable: number;

  fields: Record<FieldKey, FieldTally>;

  /**
   * Same tallies restricted to the single-family residential class, because
   * that is where the address gap was observed and it is the class a consumer
   * surface is judged on.
   */
  singleFamily: {
    parcelsTotal: number;
    fields: Record<FieldKey, FieldTally>;
  };

  contradictions: ContradictionTally[];

  /** Parcels whose flood determination carries more than one zone. */
  multiZoneFloodParcels: number;

  /**
   * Where an absence is geographically clustered rather than scattered. Names
   * the shape of a hole so it can be traced to a source, e.g. the Bastrop
   * County region returning no setbacks.
   */
  absenceClusters: Array<{
    field: FieldKey;
    label: string;
    parcelCount: number;
    bbox: [number, number, number, number];
  }>;

  /**
   * The source each field was served from in this county, so the follow-on
   * work (re-open each county's sources and re-ingest) starts from a list
   * rather than an investigation.
   */
  sourcesByField: Partial<Record<FieldKey, { source: string; vintage: string | null }>>;
}

export interface StatewideServingSweep {
  sweptAt: string;
  resolverVersion: string;
  countiesTotal: number;
  countiesSwept: number;
  parcelsTotal: number;
  counties: CountyServingSweep[];
}
