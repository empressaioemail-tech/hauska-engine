/**
 * Layer-23 city roster loader — authoritative city boundary (CITY='BASTROP').
 * Phase D: prefer loadRegistryDistrictCohort (registry-keyed); this module
 * delegates to the registry seam for Bastrop so onboard(fips) has one path.
 */
import { BASTROP_REGISTRY_ROW } from "../src/registry/jurisdiction-registry.ts";
import { loadRegistryDistrictCohort } from "../src/registry/parcel-cohort-loader.ts";

const COUNTY_FIPS = "48021";

/** ZoneTypeClass on layer 23 → district prefix (Bastrop fixture; registry row is source of truth). */
export const LAYER23_ZONE_TYPE_CLASS = Object.fromEntries(
  Object.entries(BASTROP_REGISTRY_ROW.railPerParcel?.districtValueByPrefix ?? {}).map(
    ([district, ztc]) => [String(ztc), district],
  ),
);

/**
 * Paginated AGOL query — returns prop_id strings for CITY='BASTROP' (+ optional district).
 * Delegates to registry cohort loader (un-zombied Phase D).
 */
export async function loadLayer23CityPropIds(options = {}) {
  const { districtPrefix = null, fetchImpl } = options;
  const loaded = await loadRegistryDistrictCohort(COUNTY_FIPS, districtPrefix, { fetchImpl });
  return {
    propIds: loaded.propIds,
    parcelNodeIds: loaded.parcelNodeIds,
    where: loaded.where,
    count: loaded.count,
  };
}

export async function loadLayer23CityRosterCount(districtPrefix = null) {
  const loaded = await loadLayer23CityPropIds({ districtPrefix });
  return loaded.count;
}
