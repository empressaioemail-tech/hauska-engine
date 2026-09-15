/**
 * Resolve parcel situs for export-time R30 road labeling.
 * Prefers caller-supplied descriptor address; falls back to txgio_parcel
 * (same source cert-grade uses) when TXGIO_DATABASE_URL is configured.
 *
 * P-219 FINDING, DELIBERATELY NOT FIXED HERE (routed to P-218, which owns
 * situs). The live feasibility study for `48021:34049` prints "Address —
 * UNAVAILABLE No addressed record on file for this parcel", i.e. BOTH sources
 * above miss, so this export hands `labelEdgesFromRoads` a null situs and it
 * cannot use its situs-street-match front basis. Meanwhile the parcel_record
 * `situsAddress` rail carries "1109 PECAN ST" and serves `record`, and P-219
 * already reads that record for the setback rails — so the fix is one line
 * here and costs no extra round trip and no new credential.
 *
 * It is not taken in this row for two reasons, both measured rather than
 * assumed. First, it does not fix this parcel: `labelEdgesFromRoads` was run
 * against this parcel's real ring and its three attaching OSM ways both WITH
 * and WITHOUT the situs, 2026-09-15, and produced the identical role set both
 * times (`side_corner, front, side, side, rear`) — so the corner-side line
 * P-219 owes does not depend on it. Second, supplying a situs where there was
 * none STRENGTHENS the front-edge basis product-wide, which can move the front
 * edge on other parcels; that is a change no one has measured, in the subject
 * area of another open row.
 */

import postgres from "postgres";

function parseParcelNodeId(parcelNodeId: string): { countyFips: string; propId: string } | null {
  const m = parcelNodeId.trim().match(/^(\d{5}):([^/\s]+)$/);
  if (!m) return null;
  return { countyFips: m[1]!, propId: m[2]! };
}

/**
 * Best-effort situs for `labelEdgesFromRoads` situs-street-match.
 * Never throws — missing situs degrades to adjacency-heuristic (unchanged).
 */
export async function resolveSitusAddressForExport(input: {
  parcelNodeId: string;
  descriptorAddress?: string | null;
}): Promise<string | null> {
  const fromDescriptor = input.descriptorAddress?.trim();
  if (fromDescriptor) return fromDescriptor;

  const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim();
  if (!txgioUrl) return null;

  const parts = parseParcelNodeId(input.parcelNodeId);
  if (!parts) return null;

  const txSql = postgres(txgioUrl, { ssl: "require", max: 1 });
  try {
    const [row] = await txSql`
      SELECT situs_address FROM txgio_parcel
      WHERE county_fips = ${parts.countyFips} AND prop_id = ${parts.propId}
      LIMIT 1
    `;
    const situs = row?.situs_address;
    return typeof situs === "string" && situs.trim() ? situs.trim() : null;
  } catch {
    return null;
  } finally {
    await txSql.end({ timeout: 2 });
  }
}
