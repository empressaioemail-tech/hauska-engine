/**
 * Live polygon-intersects queries against FEMA's public National Flood
 * Hazard Layer (NFHL) ArcGIS MapServer.
 *
 * `@hauska-engine/adapters/federal/fema-nfhl` (CTX-B's package for the
 * duration of this sprint -- not touched here) already queries layer 28 by
 * POINT for a single-zone read, and already requests `DFIRM_ID` in its
 * `outFields` but only threads the classification fields
 * (`FLD_ZONE`/`ZONE_SUBTY`/`SFHA_TF`/`STATIC_BFE`) onto its typed payload;
 * the raw `features` array it returns does still carry `DFIRM_ID` per
 * feature, just unnamed on the payload type.
 *
 * This module needs something the point adapter cannot give: EVERY zone
 * polygon that intersects the parcel's full ring (a parcel can straddle a
 * zone boundary; "the acreage is the intersection... not a whole-parcel
 * flag" -- 2026-09-07_r-03_dispatch.md), plus the actual FIRM PANEL number
 * and effective date, which live on a sibling layer FEMA does not surface
 * from any point query: layer 28's own `DFIRM_ID` is only the 6-character
 * county-level FIRM database id (e.g. "48021C"), never a citable panel
 * (confirmed live 2026-09-07: Bastrop 48021:52726/52727 both return
 * DFIRM_ID "48021C" from layer 28, while layer 3 "FIRM Panels" resolves the
 * same point to the real citation FIRM_PAN "48021C0355F", EFF_DATE
 * 2023-05-09, PANEL_TYP "Countywide, Panel Printed"). Nothing in this repo
 * queries layer 3 today.
 *
 * A polygon-intersects query is a genuinely new capability (no ST_Intersect
 * / polygon-vs-polygon flood query exists anywhere in this codebase, staged
 * or live), not a second derivation of an existing one, so it is written
 * fresh here rather than requested as a change to the point adapter.
 */
import type { Ring } from "./geo.js";

const NFHL_BASE = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer";
const FLOOD_HAZARD_ZONES_LAYER = `${NFHL_BASE}/28`;
const FIRM_PANELS_LAYER = `${NFHL_BASE}/3`;

export interface NfhlZoneFeature {
  fldZone: string | null;
  zoneSubty: string | null;
  sfhaTf: boolean;
  staticBfe: number | null;
  dfirmId: string | null;
  /** Exterior ring, WGS84 [lng, lat], closed (first === last). */
  ring: Ring;
}

export interface FirmPanelCitation {
  dfirmId: string;
  firmPan: string;
  panel: string;
  suffix: string;
  /** ISO 8601 date, converted from the ArcGIS epoch-ms field. */
  effectiveDate: string | null;
  panelType: string | null;
  sourceCitation: string | null;
}

function esriPolygonGeometry(ring: Ring): string {
  return JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } });
}

async function arcgisPolygonQuery(
  layerUrl: string,
  ring: Ring,
  outFields: string,
  returnGeometry: boolean,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const url = new URL(`${layerUrl}/query`);
  url.searchParams.set("geometry", esriPolygonGeometry(ring));
  url.searchParams.set("geometryType", "esriGeometryPolygon");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("outFields", outFields);
  url.searchParams.set("returnGeometry", String(returnGeometry));
  if (returnGeometry) url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "json");

  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new Error(`NFHL query HTTP ${response.status} (${layerUrl})`);
  }
  const body = (await response.json()) as {
    error?: { message?: string };
    features?: Array<{ attributes: Record<string, unknown>; geometry?: { rings?: number[][][] } }>;
  };
  if (body.error) {
    throw new Error(`NFHL query error: ${body.error.message ?? "unknown"}`);
  }
  return (body.features ?? []).map((f) => ({ ...f.attributes, __rings: f.geometry?.rings }));
}

/**
 * Every flood-hazard-zone polygon intersecting the parcel ring. Empty array
 * means the parcel is fully outside every mapped zone (NFHL has no
 * "unmapped void" feature; it is a real, positive "no zone here" the same
 * way `femaNfhlAdapter`'s point read treats zero features as Zone X by
 * omission) -- callers still receive real query success, never confused
 * with a network failure.
 */
export async function queryFloodHazardZones(
  parcelRing: Ring,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<NfhlZoneFeature[]> {
  const rows = await arcgisPolygonQuery(
    FLOOD_HAZARD_ZONES_LAYER,
    parcelRing,
    "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID",
    true,
    fetchImpl,
    signal,
  );
  const zones: NfhlZoneFeature[] = [];
  for (const row of rows) {
    const rings = (row.__rings as number[][][] | undefined) ?? [];
    const firstRing = rings[0];
    if (!firstRing) continue; // no geometry returned -- cannot intersect, skip rather than guess
    zones.push({
      fldZone: typeof row.FLD_ZONE === "string" ? row.FLD_ZONE : null,
      zoneSubty: typeof row.ZONE_SUBTY === "string" ? row.ZONE_SUBTY : null,
      sfhaTf: row.SFHA_TF === "T" || row.SFHA_TF === "t" || row.SFHA_TF === "true",
      staticBfe:
        typeof row.STATIC_BFE === "number" && row.STATIC_BFE !== -9999 ? row.STATIC_BFE : null,
      dfirmId: typeof row.DFIRM_ID === "string" ? row.DFIRM_ID : null,
      ring: firstRing.map(([lng, lat]) => [lng, lat] as [number, number]),
    });
  }
  return zones;
}

/**
 * The FIRM panel(s) covering the parcel. A parcel usually sits on exactly
 * one panel; more than one intersecting is a real (if rare) edge case near
 * a panel boundary, reported in full rather than arbitrarily narrowed to
 * one.
 */
export async function queryFirmPanels(
  parcelRing: Ring,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<FirmPanelCitation[]> {
  const rows = await arcgisPolygonQuery(
    FIRM_PANELS_LAYER,
    parcelRing,
    "DFIRM_ID,FIRM_PAN,PANEL,SUFFIX,EFF_DATE,PANEL_TYP,SOURCE_CIT",
    false,
    fetchImpl,
    signal,
  );
  return rows
    .filter((row) => typeof row.FIRM_PAN === "string")
    .map((row) => ({
      dfirmId: String(row.DFIRM_ID ?? ""),
      firmPan: String(row.FIRM_PAN),
      panel: String(row.PANEL ?? ""),
      suffix: String(row.SUFFIX ?? ""),
      effectiveDate:
        typeof row.EFF_DATE === "number" ? new Date(row.EFF_DATE).toISOString().slice(0, 10) : null,
      panelType: typeof row.PANEL_TYP === "string" ? row.PANEL_TYP : null,
      sourceCitation: typeof row.SOURCE_CIT === "string" ? row.SOURCE_CIT : null,
    }));
}
