/**
 * P3 rail absence (A4-P3-BUILD). File-side type and classifier. Does not write
 * a store and does not apply.
 *
 * Three states are a discriminated union so not-applicable cannot be paired
 * with in-city. Operator ruling 2026-08-31: in-city with no landed table is
 * unmeasured. Counties do not zone unincorporated land; setbacks, edges and
 * envelope inherit that scope.
 *
 * containmentTotal, if passed, is ignored. Classification is not a count.
 * L7 satisfied-absent does not travel on parcel rails.
 */

export const IN_CITY_NOT_APPLICABLE = "IN_CITY_NOT_APPLICABLE";
export const UNPROBED_ABSENCE = "UNPROBED_ABSENCE";
export const VALUE_NOT_ABSENCE = "VALUE_NOT_ABSENCE";
export const UNKNOWN_INCORPORATION = "UNKNOWN_INCORPORATION";
export const COUNTY_EASEMENT_NOT_T3 = "COUNTY_EASEMENT_NOT_T3";
export const L7_VOCAB_ON_PARCEL = "L7_VOCAB_ON_PARCEL";
export const EMPTY_RAIL = "EMPTY_RAIL";

export const ABSENCE_STATES = ["not-applicable", "unmeasured", "absent-verified"] as const;
export const ZONING_INHERITED_RAILS = ["setbacks", "edges", "envelope"] as const;
export const T3_COUNTY_EASEMENT_ABSENCE_FIPS = ["48021", "48055", "48209", "48491"] as const;
export const T3_EASEMENT_EVALUATED_AT = "2026-08-05T19:30:00.000Z";
export const SERVED_RAILS = ["setbacks", "edges", "envelope", "utility-easement"] as const;

export type AbsenceState = (typeof ABSENCE_STATES)[number];
export type ZoningInheritedRail = (typeof ZONING_INHERITED_RAILS)[number];
export type ServedRail = (typeof SERVED_RAILS)[number];
export type T3EasementFips = (typeof T3_COUNTY_EASEMENT_ABSENCE_FIPS)[number];

export type UnincorporatedNotApplicable = {
  state: "not-applicable";
  incorporation: "unincorporated";
  rail: ZoningInheritedRail;
  parcelNodeId: string;
  scopeSearched: string;
  reason: string;
};

export type InCityUnmeasured = {
  state: "unmeasured";
  incorporation: "in-city";
  rail: ZoningInheritedRail;
  parcelNodeId: string;
  landedTable: false;
  scopeSearched: string;
  reason: string;
};

export type InCityAbsentVerified = {
  state: "absent-verified";
  incorporation: "in-city";
  rail: ZoningInheritedRail;
  parcelNodeId: string;
  probed: true;
  scopeSearched: string;
  reason: string;
};

export type CountyEasementAbsentVerified = {
  state: "absent-verified";
  rail: "utility-easement";
  scopeKind: "county";
  countyFips: T3EasementFips;
  scopeSearched: string;
  reason: string;
  evaluatedAt: typeof T3_EASEMENT_EVALUATED_AT;
};

export type RailAbsence =
  | UnincorporatedNotApplicable
  | InCityUnmeasured
  | InCityAbsentVerified
  | CountyEasementAbsentVerified;

export type CollectCloseFinding = "none-found" | "source-present" | "unprobed";

export type CollectClose = {
  finding: CollectCloseFinding;
  evaluatedAt: string;
  sourceCatalog: string;
};

class RailAbsenceError extends Error {
  code: string;
  detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new RailAbsenceError(code, message, detail);
}

function assertNotL7(token: unknown): void {
  if (String(token) === "satisfied-absent") {
    refuse(L7_VOCAB_ON_PARCEL, "satisfied-absent is L7 county SCORE vocabulary; it does not travel on parcel rails");
  }
}

function isZoningRail(rail: string): rail is ZoningInheritedRail {
  return (ZONING_INHERITED_RAILS as readonly string[]).includes(rail);
}

function isT3Fips(fips: string): fips is T3EasementFips {
  return (T3_COUNTY_EASEMENT_ABSENCE_FIPS as readonly string[]).includes(fips);
}

/**
 * Classify a zoning-inherited parcel rail. incorporation and landedTable are
 * independently derived inputs. containmentTotal is accepted and discarded so
 * a caller cannot smuggle 357269 (or any other headline) into the result.
 */
export function classifyParcelRail(input: {
  rail: string;
  incorporation: string;
  landedTable: boolean;
  collectClose: CollectClose | null;
  parcelNodeId: string;
  emitOverride?: AbsenceState;
  containmentTotal?: number;
}): UnincorporatedNotApplicable | InCityUnmeasured | InCityAbsentVerified {
  const { rail, incorporation, landedTable, collectClose, parcelNodeId, emitOverride } = input;
  void input.containmentTotal;

  if (!isZoningRail(rail)) {
    refuse(VALUE_NOT_ABSENCE, `classifyParcelRail does not classify rail ${rail}`);
  }
  if (incorporation !== "unincorporated" && incorporation !== "in-city") {
    refuse(UNKNOWN_INCORPORATION, "incorporation must be unincorporated or in-city");
  }
  if (!collectClose) {
    refuse(UNPROBED_ABSENCE, "classifyParcelRail needs a collect_close");
  }
  assertNotL7(emitOverride);
  if (emitOverride === "not-applicable" && incorporation === "in-city") {
    refuse(
      IN_CITY_NOT_APPLICABLE,
      `in-city parcel ${parcelNodeId} cannot serve not-applicable on ${rail}; a setback can exist there`,
      { rail, parcelNodeId, incorporation },
    );
  }

  if (incorporation === "unincorporated") {
    return {
      state: "not-applicable",
      incorporation: "unincorporated",
      rail,
      parcelNodeId,
      scopeSearched: `zoning authority for unincorporated ${parcelNodeId}`,
      reason:
        "counties do not zone unincorporated land; setbacks, edges, and envelope inherit zoning scope",
    };
  }

  if (!landedTable) {
    return {
      state: "unmeasured",
      incorporation: "in-city",
      rail,
      parcelNodeId,
      landedTable: false,
      scopeSearched: `landing_setback_registry for in-city ${parcelNodeId}`,
      reason: "in-city parcel has no landed setback table; a setback can exist there and has not been sourced",
    };
  }

  if (collectClose.finding === "none-found") {
    return {
      state: "absent-verified",
      incorporation: "in-city",
      rail,
      parcelNodeId,
      probed: true,
      scopeSearched: collectClose.sourceCatalog,
      reason: `city probe found no ${rail} after looking`,
    };
  }

  if (collectClose.finding === "source-present") {
    refuse(VALUE_NOT_ABSENCE, `${rail} has a source; this is not an absence write`);
  }

  refuse(
    UNPROBED_ABSENCE,
    `in-city ${rail} has a landed table but collect_close finding ${collectClose.finding} is not none-found`,
  );
}

export function classifyCountyEasement(input: {
  countyFips: string;
  collectClose: CollectClose | null;
}): CountyEasementAbsentVerified {
  const { countyFips, collectClose } = input;
  if (!isT3Fips(countyFips)) {
    refuse(COUNTY_EASEMENT_NOT_T3, `county ${countyFips} is not a T3 easement-absence FIPS`);
  }
  if (!collectClose) {
    refuse(UNPROBED_ABSENCE, "county easement absence needs a T3 collect_close");
  }
  if (collectClose.finding !== "none-found") {
    refuse(
      UNPROBED_ABSENCE,
      `county easement collect_close finding must be none-found, got ${collectClose.finding}`,
    );
  }
  return {
    state: "absent-verified",
    rail: "utility-easement",
    scopeKind: "county",
    countyFips,
    scopeSearched: collectClose.sourceCatalog,
    reason: `T3 four-point probe of county ${countyFips} public REST catalog found no easement layer`,
    evaluatedAt: T3_EASEMENT_EVALUATED_AT,
  };
}

export type NamedRail = {
  empty: false;
  rail: ServedRail;
  verdict: AbsenceState;
  scope: string;
  basis: string;
  countyAbsence?: true;
};

/**
 * Name every served rail. An omitted rail is ADR-029. This is the file-side
 * serve path; it does not read a store and it does not close the live PE brief.
 */
export function nameParcelRails(rows: readonly RailAbsence[], parcelNodeId: string): Record<ServedRail, NamedRail> {
  const named = {} as Record<ServedRail, NamedRail>;
  for (const row of rows) {
    assertNotL7(row.state);
    if (row.state === "not-applicable" && row.incorporation !== "unincorporated") {
      refuse(IN_CITY_NOT_APPLICABLE, "serve refuses a stuffed in-city not-applicable row");
    }
    const countyAbsence = row.rail === "utility-easement" && row.scopeKind === "county";
    const basis = countyAbsence
      ? `${row.reason}; served on parcel ${parcelNodeId}`
      : row.reason;
    named[row.rail] = {
      empty: false,
      rail: row.rail,
      verdict: row.state,
      scope: row.scopeSearched,
      basis,
      ...(countyAbsence ? { countyAbsence: true as const } : {}),
    };
  }
  return named;
}

export function assertNamedAbsence(named: Partial<Record<ServedRail, NamedRail | { empty: true }>>, rail: ServedRail): NamedRail {
  const row = named[rail];
  if (!row || row.empty === true) {
    refuse(EMPTY_RAIL, `rail ${rail} is empty; stored-or-classified absence that never reaches the wire is ADR-029`);
  }
  return row;
}

/** Compile-time: not-applicable rows are unincorporated. */
export function unincorporatedOnly(row: Extract<RailAbsence, { state: "not-applicable" }>): "unincorporated" {
  return row.incorporation;
}
