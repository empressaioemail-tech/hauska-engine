#!/usr/bin/env node
/**
 * Dominant-district warm/cert roster (R26).
 * Phase D: cohort SOURCE = registry-keyed layer-23 enumeration (ALL city parcels
 * for the district), NOT atom-backed setback-rule (chicken-and-egg).
 * R26 dominance still resolves at warm time via per-parcel layer-23 fetch.
 */
import postgres from "postgres";
import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { fetchBastropPerParcelSetbackRecord } from "@hauska-engine/adapters";
import { loadRegistryDistrictCohort } from "../src/registry/parcel-cohort-loader.ts";
import { loadLayer23CityPropIds, loadLayer23CityRosterCount } from "./bastrop-layer23-roster.mjs";

const COUNTY_FIPS = "48021";

const BLOCK13_QUARANTINE = new Set([
  "48021:34145", "48021:34121", "48021:34153", "48021:34137",
  "48021:34169", "48021:34177", "48021:34161",
]);

function districtPrefix(code) {
  if (!code?.trim()) return "";
  return code.trim().split(/\s+/)[0] ?? "";
}

/** @deprecated Phase D — atom-backed roster caused chicken-and-egg coverage gap. */
export async function loadDominantDistrictRosterFromAtoms(district, sql) {
  const rows = await sql`
    SELECT DISTINCT ON (body->>'parcelNodeId')
      body->>'parcelNodeId' AS parcel_node_id,
      body->>'districtCode' AS district_code
    FROM atoms
    WHERE entity_type = 'setback-rule'
      AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
      AND split_part(coalesce(body->>'districtCode', ''), ' ', 1) = ${district}
    ORDER BY body->>'parcelNodeId', updated_at DESC NULLS LAST
  `;
  return rows.map((r) => r.parcel_node_id).filter(Boolean);
}

/**
 * Honest-decline envelopes already on substrate (recipe 1.0.0) — merged so cert
 * grades parcels that declined before layer-23 stamp caught up.
 */
export async function loadHonestDeclineRosterForDistrict(district, sql) {
  const rows = await sql`
    SELECT DISTINCT e.body->>'parcelNodeId' AS parcel_node_id
    FROM atoms e
    LEFT JOIN LATERAL (
      SELECT body->>'districtCode' AS dc
      FROM atoms sr
      WHERE sr.entity_type = 'setback-rule'
        AND sr.body->>'parcelNodeId' = e.body->>'parcelNodeId'
      ORDER BY sr.updated_at DESC NULLS LAST
      LIMIT 1
    ) sr ON true
    WHERE e.entity_type = 'buildable-envelope'
      AND e.body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
      AND e.body->>'recipeVersion' = '1.0.0'
      AND e.body->>'warmVerifyDecline' IS NOT NULL
      AND coalesce(e.body->>'depthWarmPromotion', '') <> 'depth-warm-promoted-v1'
      AND split_part(coalesce(sr.dc, ''), ' ', 1) = ${district}
  `;
  return rows.map((r) => r.parcel_node_id).filter(Boolean);
}

/**
 * Verify a parcel's layer-23 dominant district via live fetch (for artifact checks).
 */
export async function fetchDominantDistrictForParcel(propId, zoningStamp, centroidLngLat) {
  const fetched = await fetchBastropPerParcelSetbackRecord(propId, {
    districtCode: zoningStamp ?? undefined,
    centroidLngLat,
  });
  if (fetched.kind !== "parsed") return { ok: false, code: fetched.code };
  const d = (fetched.resolvedDistrictCode ?? "").trim();
  return { ok: true, dominant: districtPrefix(d) };
}

/**
 * Full district roster: registry layer-23 enumeration + honest-decline merge,
 * minus Block-13 quarantine.
 *
 * @param {string} district
 * @param {{ excludeBlock13?: boolean; fetchImpl?: typeof fetch; countyFips?: string }} [options]
 */
export async function loadDominantDistrictRoster(district, options = {}) {
  const { excludeBlock13 = true, fetchImpl, countyFips = COUNTY_FIPS } = options;

  const fromLayer23 = await loadRegistryDistrictCohort(countyFips, district, { fetchImpl });

  const url = resolveSubstrateDatabaseUrl();
  const sql = postgres(url, { ssl: "require", max: 2, prepare: false });
  let fromDecline = [];
  try {
    fromDecline = await loadHonestDeclineRosterForDistrict(district, sql);
  } finally {
    await sql.end();
  }

  const merged = [...new Set([...fromLayer23.parcelNodeIds, ...fromDecline])];
  const filtered = excludeBlock13
    ? merged.filter((id) => !BLOCK13_QUARANTINE.has(id))
    : merged;

  return {
    parcelNodeIds: filtered.sort(),
    source: `${fromLayer23.source}+honest-decline`,
    cohortOrigin: "layer-23-registry",
    layer23Count: fromLayer23.count,
    where: fromLayer23.where,
  };
}

export { BLOCK13_QUARANTINE, districtPrefix, loadLayer23CityPropIds, loadLayer23CityRosterCount };
