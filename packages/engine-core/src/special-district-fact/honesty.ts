/** Scoped absence copy — must pass BANNED phrase guard in writer seam. */
export function buildOutsideSourceAbsenceReason(countyFips: string): string {
  return (
    `Parcel centroid in county ${countyFips} does not intersect any polygon in ` +
    `tx_special_district (TCEQ Public/WaterDistricts MapServer/0). ` +
    `Finding is scoped to that source only; Comptroller registry omissions, ESD, PID, ` +
    `and other district types outside this layer may still apply.`
  );
}
