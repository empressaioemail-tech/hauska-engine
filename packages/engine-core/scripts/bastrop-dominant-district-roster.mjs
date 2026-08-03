#!/usr/bin/env node
/**
 * Dominant-district roster (R26) — parcels whose governing district matches prefix.
 * Post-warm: setback-rule.districtCode. Pre-warm fallback: zoning-fact district prefix.
 */
import postgres from "postgres";
import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { fetchBastropPerParcelSetbackRecord } from "@hauska-engine/adapters";
import { loadLayer23CityPropIds } from "./bastrop-layer23-roster.mjs";

const COUNTY_FIPS = "48021";

const BLOCK13_QUARANTINE = new Set([
  "48021:34145", "48021:34121", "48021:34153", "48021:34137",
  "48021:34169", "48021:34177", "48021:34161",
]);

function districtPrefix(code) {
  if (!code?.trim()) return "";
  return code.trim().split(/\s+/)[0] ?? "";
}

/**
 * Roster from served atoms: setback-rule districtCode = dominant district after warm (R26).
 */
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
 * Expand roster with honest-decline envelopes (recipe 1.0.0, no promote marker).
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
 * Full dominant-district roster: setback-rule cohort + honest-declines, minus Block-13 quarantine.
 */
export async function loadDominantDistrictRoster(district, options = {}) {
  const { excludeBlock13 = true } = options;
  const url = resolveSubstrateDatabaseUrl();
  const sql = postgres(url, { ssl: "require", max: 2, prepare: false });
  try {
    const fromSetback = await loadDominantDistrictRosterFromAtoms(district, sql);
    const fromDecline = await loadHonestDeclineRosterForDistrict(district, sql);
    const merged = [...new Set([...fromSetback, ...fromDecline])];
    const filtered = excludeBlock13
      ? merged.filter((id) => !BLOCK13_QUARANTINE.has(id))
      : merged;
    return { parcelNodeIds: filtered.sort(), source: "setback-rule-districtCode+honest-decline" };
  } finally {
    await sql.end();
  }
}

export { BLOCK13_QUARANTINE, districtPrefix };
