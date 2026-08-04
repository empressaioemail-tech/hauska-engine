/**
 * Registry-keyed warm cohort loader (Phase D / onboard(fips) core).
 */
import {
  loadJurisdictionRegistryRow,
  loadJurisdictionRegistryRowById,
  type JurisdictionRegistryRow,
} from "./jurisdiction-registry.js";

export interface RegistryDistrictCohort {
  countyFips: string;
  propIds: string[];
  parcelNodeIds: string[];
  where: string;
  count: number;
  source: string;
  registryVersion: string;
}

/**
 * buildWhereClause handles both parcel-filter variants: a city-scoped cohort
 * (`cityFilter`, the Bastrop shape) and a whole-county cohort (`noFilter` —
 * e.g. unincorporated county), with no non-null assertion on `railPerParcel`.
 * Kept exported so pre-flight can reuse it to validate a row's filter shape
 * without duplicating the branch.
 */
export function buildWhereClause(
  row: JurisdictionRegistryRow,
  districtPrefix: string | null,
): string {
  if (!row.railPerParcel) {
    throw new Error(
      `registry cohort: no railPerParcel row for FIPS ${row.fips} (honest-absence — not onboarded for factory warm)`,
    );
  }
  const rail = row.railPerParcel;
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

  if (rail.parcelFilter.kind === "noFilter") {
    // Whole-county cohort: no city/boundary predicate. districtClause alone
    // (leading " AND ...") is invalid SQL on its own, so strip the leading
    // " AND " when it is the only clause, and fall back to an always-true
    // predicate when there is no district filter either.
    if (!districtClause) return "1=1";
    return districtClause.replace(/^ AND /, "");
  }

  const cityVal = String(rail.parcelFilter.value).replace(/'/g, "''");
  return `${rail.parcelFilter.field} = '${cityVal}'${districtClause}`;
}

/**
 * Shared pagination core for a resolved row: both `loadRegistryDistrictCohort`
 * (fips-keyed, resolves via the active-row heuristic) and
 * `loadRegistryDistrictCohortByRow` (rowId-keyed, resolves an exact row) build
 * their WHERE clause and cohort the same way once a specific
 * `JurisdictionRegistryRow` is in hand — only the resolution step differs.
 */
async function paginateCohortForRow(
  row: JurisdictionRegistryRow,
  countyFips: string,
  districtPrefix: string | null,
  options: { fetchImpl?: typeof fetch },
): Promise<RegistryDistrictCohort> {
  if (!row.railPerParcel) {
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

/**
 * Paginate ALL parcels for a jurisdiction district from the frozen registry Rail-A layer.
 *
 * Resolves the row by FIPS via `loadJurisdictionRegistryRow`, which returns
 * the first "active" row for that fips — ambiguous when more than one row
 * shares a fips (e.g. Bastrop city + Bastrop County unincorporated + Elgin,
 * all 48021). Safe today because Bastrop city is the only "active" row on
 * 48021. Callers that already hold a specific `JurisdictionRegistryRow` (or
 * rowId) — e.g. onboard-preflight and warden-sweep, which resolve a row by
 * rowId and then call this function with `row.fips` — should use
 * `loadRegistryDistrictCohortByRow` instead once more than one row per fips
 * is "active", to avoid silently grading the wrong row's cohort.
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
  return paginateCohortForRow(row, countyFips, districtPrefix, options);
}

/**
 * Paginate ALL parcels for a jurisdiction district, resolving the row by its
 * exact `rowId` rather than by fips — the disambiguated counterpart to
 * `loadRegistryDistrictCohort` for fips that carry more than one registry row
 * (e.g. 48021: "Bastrop", "Bastrop County (unincorporated)", "Elgin"). Reuses
 * `buildWhereClause` unchanged. Honest-absence: throws a named error when the
 * rowId is unknown or the row has no `railPerParcel` (never fabricates a
 * cohort), matching `loadRegistryDistrictCohort`'s error contract.
 */
export async function loadRegistryDistrictCohortByRow(
  rowId: string,
  districtPrefix: string | null = null,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RegistryDistrictCohort> {
  const row = loadJurisdictionRegistryRowById(rowId);
  if (!row) {
    throw new Error(
      `registry cohort: unknown rowId ${rowId} (no such row in the frozen jurisdiction registry)`,
    );
  }
  if (!row.railPerParcel) {
    throw new Error(
      `registry cohort: no railPerParcel row for rowId ${rowId} (FIPS ${row.fips}; honest-absence — not onboarded for factory warm)`,
    );
  }
  return paginateCohortForRow(row, row.fips, districtPrefix, options);
}
