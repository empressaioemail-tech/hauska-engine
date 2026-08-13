/** Presence of districts in county: parcel geometry missed every polygon. */
export const OUTSIDE_TRUE_GEOM_ABSENCE_RULE =
  "outside-tceq-source-true-geom-no-intersect" as const;

/** Zero districts attributed to this FIPS in the TCEQ layer (positive determination). */
export const EMPTY_COUNTY_DISTRICT_ABSENCE_RULE =
  "empty-county-tceq-zero-districts-for-fips" as const;

/** Scoped absence copy — must pass BANNED phrase guard in writer seam. */
export function buildOutsideSourceAbsenceReason(countyFips: string): string {
  return (
    `Parcel geometry does not intersect any polygon in ` +
    `tx_special_district (TCEQ Public/WaterDistricts MapServer/0) for county ` +
    `${countyFips}. ` +
    `Finding is scoped to that source only; Comptroller registry omissions, ESD, PID, ` +
    `and other district types outside this layer may still apply.`
  );
}

/**
 * Positive TCEQ determination: the TCEQ layer attributes zero districts to
 * this county FIPS. absenceKind stays `outside-tceq-source-boundaries`.
 * Do NOT use the word "statewide" — banned by atom writer seam.
 */
export function buildEmptyCountyDistrictAbsenceReason(countyFips: string): string {
  return (
    `Positive TCEQ determination: zero districts are attributed to county FIPS ` +
    `${countyFips} in the TCEQ tx_special_district layer ` +
    `(Public/WaterDistricts MapServer/0). ` +
    `Finding is scoped to that source only; Comptroller registry omissions, ESD, PID, ` +
    `and other district types outside this layer may still apply.`
  );
}
