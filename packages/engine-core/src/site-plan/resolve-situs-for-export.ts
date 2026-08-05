/**
 * Resolve parcel situs for export-time R30 road labeling.
 * Prefers caller-supplied descriptor address; falls back to txgio_parcel
 * (same source cert-grade uses) when TXGIO_DATABASE_URL is configured.
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
