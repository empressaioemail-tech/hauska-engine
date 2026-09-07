/**
 * Live point-in-polygon query against HIFLD's public
 * "Electric Retail Service Territories" ArcGIS FeatureServer.
 *
 * This is the SAME source lane L22 staged into `tx_utility_territory_staging`
 * on 2026-08-14 (source_key `hifld-electric-retail`, 139 rows, 254/254 TX
 * counties) -- the mission text ("look at the staged HIFLD data FIRST")
 * means this exact dataset, not a fresh acquisition. That staging table is
 * not reachable from this lane (no `tx_utility_territory_staging` migration
 * exists in `hauska-engine`; the table lives in whatever database L22's
 * `legacy-design-tools` session wrote it into, and this lane holds no
 * credential for it -- see CP1). Rather than block on that credential, this
 * queries the public upstream directly: the same
 * `HIFLD_Electric_Retail_Service_Territories` FeatureServer, verified live
 * by three independent prior lanes (L10, L14, L22) at
 * `_inbox/2026-08-12_L10_cp2_posture_midpoint.json`,
 * `_inbox/2026-08-14_l22_cp1.json`, `_inbox/2026-09-03_parcel-wave2_inventory.md`.
 * TX feature count re-verified live 2026-09-07 == 139, matching L22's staged
 * count exactly.
 */

const HIFLD_ELECTRIC_RETAIL_TERRITORIES =
  "https://services2.arcgis.com/LYMgRMwHfrWWEg3s/arcgis/rest/services/HIFLD_Electric_Retail_Service_Territories/FeatureServer/0";

export interface HifldElectricTerritory {
  name: string;
  type: string | null;
  naicsDescription: string | null;
  website: string | null;
  source: string | null;
}

/**
 * Every HIFLD electric-retail-territory polygon containing the point.
 * Almost always length 0 or 1; HIFLD's retail-territory layer has known
 * overlap artifacts at municipal-utility boundaries (a municipal carve-out
 * inside a larger co-op's nominal territory is not always cleanly clipped),
 * so more than one hit is reported as ambiguity by the caller rather than
 * silently narrowed here.
 */
export async function queryHifldElectricTerritory(
  point: { latitude: number; longitude: number },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<HifldElectricTerritory[]> {
  const url = new URL(`${HIFLD_ELECTRIC_RETAIL_TERRITORIES}/query`);
  url.searchParams.set("geometry", `${point.longitude},${point.latitude}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", "NAME,TYPE,NAICS_DESC,WEBSITE,SOURCE");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");

  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new Error(`HIFLD electric-retail-territory query HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    error?: { message?: string };
    features?: Array<{ attributes: Record<string, unknown> }>;
  };
  if (body.error) {
    throw new Error(`HIFLD electric-retail-territory query error: ${body.error.message ?? "unknown"}`);
  }
  return (body.features ?? [])
    .filter((f) => typeof f.attributes.NAME === "string" && f.attributes.NAME.trim() !== "")
    .map((f) => ({
      name: String(f.attributes.NAME).trim(),
      type: typeof f.attributes.TYPE === "string" ? f.attributes.TYPE : null,
      naicsDescription: typeof f.attributes.NAICS_DESC === "string" ? f.attributes.NAICS_DESC : null,
      website: typeof f.attributes.WEBSITE === "string" && f.attributes.WEBSITE !== "NOT AVAILABLE" ? f.attributes.WEBSITE : null,
      source: typeof f.attributes.SOURCE === "string" ? f.attributes.SOURCE : null,
    }));
}
