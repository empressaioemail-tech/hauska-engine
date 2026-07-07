/**
 * RRC H-10 (Annual Disposal/Injection Well Monitoring) client.
 *
 * The H-10 form tracks injection and disposal volumes for saltwater disposal
 * (SWD) wells and enhanced oil recovery (EOR) injection wells. The data is
 * accessible via:
 *
 * 1. **Web Form**: Manual query at the RRC's H-10 surface
 * 2. **Bulk Data Files**: Annual H-10 submissions are available from the RRC's
 *    public data site
 *
 * This client documents the surface structure but defers to fixtures for
 * activation (EXIT-BOUNDED constraint). For production use:
 *
 * - **Small queries**: Use the web form manually and export CSV
 * - **Full backfill**: Download bulk H-10 files from the RRC's public data
 *   site and parse locally
 *
 * The fixtures cover a representative sample for Reeves County (district 08)
 * to validate the adapter's normalization logic and grain discriminators.
 */

import type { H10QueryParams, H10FetchResult } from "./types.js";

/**
 * H-10 base URL (RRC injection/disposal well reporting).
 */
export const H10_BASE_URL = "https://webapps.rrc.texas.gov/H10/";

/**
 * Fetch injection/disposal data (well-level) from RRC H-10.
 *
 * **IMPLEMENTATION NOTE**: This function is FIXTURE-ONLY for activation. The
 * RRC H-10 surface requires form submission and session handling that is not
 * suited for EXIT-BOUNDED scripting. For production use, download bulk H-10
 * files or use the manual CSV export.
 *
 * @param params - Query parameters.
 * @returns Fetch result with H-10 injection/disposal records.
 * @throws Error with manual instructions if live fetching is attempted.
 */
export async function fetchH10Injection(
  params: H10QueryParams,
): Promise<H10FetchResult> {
  throw new Error(
    `RRC H-10 live fetching is not implemented (EXIT-BOUNDED constraint). ` +
      `Use fixtures or download bulk H-10 files from the RRC public data site. ` +
      `For small queries, visit ${H10_BASE_URL} and export CSV manually.`,
  );
}

/**
 * Manual query instructions for RRC H-10.
 *
 * 1. Visit: https://webapps.rrc.texas.gov/H10/
 * 2. Select "Injection/Disposal Well Query"
 * 3. Enter district/API/operator criteria and date range
 * 4. Submit query and export results as CSV
 * 5. Parse CSV and normalize to production-timeseries atoms (product: "injection")
 *
 * **Bulk Data Path**:
 *
 * 1. Download annual H-10 files from the RRC's public data site
 * 2. Parse files and filter to district/well of interest
 * 3. Normalize to production-timeseries atoms using this adapter's normalize module
 *
 * Injection volumes are reported at the well level (same grain as gas production).
 */
export const H10_MANUAL_INSTRUCTIONS = `
RRC H-10 Manual Query Instructions
===================================

For small queries (single well, limited date range):

1. Visit: https://webapps.rrc.texas.gov/H10/
2. Select "Injection/Disposal Well Query"
3. Enter district/API/operator criteria and date range (YYYY-MM format)
4. Submit query and export results as CSV
5. Parse CSV and normalize to production-timeseries atoms (product: "injection")

For bulk backfill (full history):

1. Download annual H-10 files from the RRC's public data site
2. Parse files and filter to district/well of interest
3. Normalize to production-timeseries atoms using this adapter's normalize module

Injection volumes are reported at the well level (same grain as gas production).
The product field is set to "injection" to distinguish from production volumes.
`;
