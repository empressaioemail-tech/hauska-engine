/**
 * Locked membership method for special-district-fact (CP1 / SF-6).
 *
 * Predicate: ST_Intersects(district_geom, parcel_geom), district-major
 * (zone-major). Both tables store geometry as JSONB only — PostGIS parses
 * via ST_GeomFromGeoJSON inside MATERIALIZED CTEs. No geom column / GiST.
 */

export const TRUE_GEOM_MEMBERSHIP_METHOD =
  "postgis-zone-major-st-intersects-true-geom" as const;

export type TrueGeomMembershipMethod = typeof TRUE_GEOM_MEMBERSHIP_METHOD;

export function assertTrueGeomMembershipMethod(method: string): void {
  if (method !== TRUE_GEOM_MEMBERSHIP_METHOD) {
    throw new Error(
      `special-district-fact drain FAIL CLOSED: membershipMethodId ` +
        `"${method}" !== "${TRUE_GEOM_MEMBERSHIP_METHOD}"`,
    );
  }
}
