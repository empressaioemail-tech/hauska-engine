/**
 * Registry-keyed warm cohort loader (Phase D / onboard(fips) core).
 */
import { loadJurisdictionRegistryRow, type JurisdictionRegistryRow } from "./jurisdiction-registry.js";

export interface RegistryDistrictCohort {
  countyFips: string;
  propIds: string[];
  parcelNodeIds: string[];
  where: string;
  count: number;
  source: string;
  registryVersion: string;
}

function buildWhereClause(row: JurisdictionRegistryRow, districtPrefix: string | null): string {
  const rail = row.railPerParcel!;
  let districtClause = "";
  if (districtPrefix) {
    const base = districtPrefix.trim().split(/\s+/)[0] ?? "";
    const districtValue = rail.districtValueByPrefix[base];
    if (districtValue == null) {
      throw new Error(`registry cohort: unknown district prefix ${districtPrefix} for FIPS ${row.fips}`);
    }
    const quoted =
      typeof districtValue === "number"
        ? String(districtValue)
        : `'${String(districtValue).replace(/'/g, "''")}'`;
    districtClause = ` AND ${rail.districtField} = ${quoted}`;
  }
  const cityVal = String(rail.cityFilter.value).replace(/'/g, "''");
  return `${rail.cityFilter.field} = '${cityVal}'${districtClause}`;
}

/**
 * Paginate ALL parcels for a jurisdiction district from the frozen registry Rail-A layer.
 */
export async function loadRegistryDistrictCohort(
  countyFips: string,
  districtPrefix: string | null = null,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RegistryDistrictCohort> {
  const row = loadJurisdictionRegistryRow(countyFips);
  if (!row?.railPerParcel) {
    throw new Error(
      `registry cohort: no railPerParcel row for FIPS ${countyFips} (honest-absence — not onboarded for factory warm)`,
    );
  }
  const rail = row.railPerParcel;
  const where = buildWhereClause(row, districtPrefix);
  const { fetchImpl } = options;

  const propIds: string[] = [];
  let offset = 0;
  const pageSize = 2000;
  const layerUrl = rail.featureServerLayerUrl.replace(/\/$/, "");

  for (;;) {
    const url = new URL(`${layerUrl}/query`);
    url.searchParams.set("f", "json");
    url.searchParams.set("where", where);
    url.searchParams.set("outFields", rail.propIdField);
    url.searchParams.set("returnGeometry", "false");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", String(pageSize));

    const res = await (fetchImpl ?? fetch)(url.toString(), {
      headers: { "User-Agent": "hauska-engine/registry-cohort", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry cohort fetch HTTP ${res.status} for FIPS ${countyFips}`);
    const json = (await res.json()) as { features?: Array<{ attributes?: Record<string, unknown> }> };
    const features = json.features ?? [];
    for (const f of features) {
      const attrs = f.attributes ?? {};
      const pid =
        attrs[rail.propIdField] ?? attrs.PROP_ID ?? attrs.prop_id;
      if (pid != null && String(pid).trim()) propIds.push(String(pid).trim());
    }
    if (features.length < pageSize) break;
    offset += pageSize;
  }

  return {
    countyFips,
    propIds,
    parcelNodeIds: propIds.map((p) => `${countyFips}:${p}`),
    where,
    count: propIds.length,
    source: `registry-railPerParcel:${row.countyName}`,
    registryVersion: row.provenance.registryVersion,
  };
}
