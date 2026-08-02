/**
 * Layer-23 city roster loader — authoritative city boundary (CITY='BASTROP').
 * NOT the BASTROP_CITY_BBOX over-broad cohort.
 */
import { BASTROP_PARCELS_ONE_CLICK_LAYER_23 } from "@hauska-engine/adapters";

const COUNTY_FIPS = "48021";

/** ZoneTypeClass on layer 23 → district prefix. */
export const LAYER23_ZONE_TYPE_CLASS = {
  1: "P/OS",
  2: "RR",
  3: "SF-1",
  4: "SF-2",
  5: "SF-3",
  6: "MU",
  7: "GC",
  8: "PI",
  9: "IND",
  10: "PDD",
};

const DISTRICT_TO_ZTC = Object.fromEntries(
  Object.entries(LAYER23_ZONE_TYPE_CLASS).map(([n, d]) => [d, Number(n)]),
);

function districtToZoneTypeClass(districtPrefix) {
  if (!districtPrefix) return null;
  const base = districtPrefix.trim().split(/\s+/)[0];
  return DISTRICT_TO_ZTC[base] ?? null;
}

/**
 * Paginated AGOL query — returns prop_id strings for CITY='BASTROP' (+ optional district).
 */
export async function loadLayer23CityPropIds(options = {}) {
  const { districtPrefix = null, fetchImpl } = options;
  const ztc = districtToZoneTypeClass(districtPrefix);
  let where = "CITY = 'BASTROP'";
  if (ztc != null) where += ` AND ZoneTypeClass = ${ztc}`;

  const propIds = [];
  let offset = 0;
  const pageSize = 2000;
  for (;;) {
    const url = new URL(`${BASTROP_PARCELS_ONE_CLICK_LAYER_23.replace(/\/$/, "")}/query`);
    url.searchParams.set("f", "json");
    url.searchParams.set("where", where);
    url.searchParams.set("outFields", "prop_id");
    url.searchParams.set("returnGeometry", "false");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", String(pageSize));

    const res = await (fetchImpl ?? fetch)(url.toString(), {
      headers: { "User-Agent": "hauska-engine/phase-c-roster", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`layer-23 roster fetch HTTP ${res.status}`);
    const json = await res.json();
    const features = json.features ?? [];
    for (const f of features) {
      const pid = f.attributes?.prop_id ?? f.attributes?.PROP_ID;
      if (pid != null && String(pid).trim()) propIds.push(String(pid).trim());
    }
    if (features.length < pageSize) break;
    offset += pageSize;
  }

  return {
    propIds,
    parcelNodeIds: propIds.map((p) => `${COUNTY_FIPS}:${p}`),
    where,
    count: propIds.length,
  };
}

export async function loadLayer23CityRosterCount(districtPrefix = null) {
  const ztc = districtToZoneTypeClass(districtPrefix);
  let where = "CITY = 'BASTROP'";
  if (ztc != null) where += ` AND ZoneTypeClass = ${ztc}`;
  const url = new URL(`${BASTROP_PARCELS_ONE_CLICK_LAYER_23.replace(/\/$/, "")}/query`);
  url.searchParams.set("f", "json");
  url.searchParams.set("where", where);
  url.searchParams.set("returnCountOnly", "true");
  const res = await fetch(url.toString());
  const json = await res.json();
  return Number(json.count ?? 0);
}
