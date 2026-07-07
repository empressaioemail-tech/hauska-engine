/**
 * RRC PDQ (Production Data Query) client.
 *
 * The RRC PDQ surface (https://webapps2.rrc.texas.gov/PDQ) provides monthly
 * production volumes with the Texas reporting split: oil at lease level, gas
 * at well level. The surface is accessible via:
 *
 * 1. **Web Form**: Manual query at the PDQ interface
 * 2. **Bulk EBCDIC Extracts**: Full-history mainframe files from RRC's public
 *    data site (ftp://ftpe.rrc.texas.gov/shfwba/)
 *
 * This client documents the surface structure but defers to fixtures for
 * activation (EXIT-BOUNDED constraint). The PDQ web form is complex
 * (multi-step navigation, session handling), and bulk EBCDIC extracts exceed
 * the 20MB constraint for in-environment processing. For production use:
 *
 * - **Small queries**: Use the web form manually and export CSV
 * - **Full backfill**: Download EBCDIC files, parse with a mainframe COBOL
 *   layout reader (see RRC's dbf900 format spec), and ingest locally
 *
 * The fixtures cover a representative sample for Reeves County (district 08)
 * to validate the adapter's normalization logic and grain discriminators.
 */

import type {
  PdqQueryParams,
  PdqOilFetchResult,
  PdqGasFetchResult,
} from "./types.js";

/**
 * PDQ base URL.
 */
export const PDQ_BASE_URL = "https://webapps2.rrc.texas.gov/PDQ/home.do";

/**
 * Fetch oil production data (lease-level) from RRC PDQ.
 *
 * **IMPLEMENTATION NOTE**: This function is FIXTURE-ONLY for activation. The
 * RRC PDQ surface requires complex session/navigation handling that is not
 * suited for EXIT-BOUNDED scripting. For production use, download bulk EBCDIC
 * extracts from ftp://ftpe.rrc.texas.gov/shfwba/ or use the manual CSV export.
 *
 * @param params - Query parameters.
 * @returns Fetch result with oil production records.
 * @throws Error with manual instructions if live fetching is attempted.
 */
export async function fetchOilProduction(
  params: PdqQueryParams,
): Promise<PdqOilFetchResult> {
  throw new Error(
    `RRC PDQ live fetching is not implemented (EXIT-BOUNDED constraint). ` +
      `Use fixtures or download bulk extracts from ftp://ftpe.rrc.texas.gov/shfwba/ ` +
      `(dbf900 format). For small queries, visit ${PDQ_BASE_URL} and export CSV manually.`,
  );
}

/**
 * Fetch gas production data (well-level) from RRC PDQ.
 *
 * **IMPLEMENTATION NOTE**: This function is FIXTURE-ONLY for activation. The
 * RRC PDQ surface requires complex session/navigation handling that is not
 * suited for EXIT-BOUNDED scripting. For production use, download bulk EBCDIC
 * extracts from ftp://ftpe.rrc.texas.gov/shfwba/ or use the manual CSV export.
 *
 * @param params - Query parameters.
 * @returns Fetch result with gas production records.
 * @throws Error with manual instructions if live fetching is attempted.
 */
export async function fetchGasProduction(
  params: PdqQueryParams,
): Promise<PdqGasFetchResult> {
  throw new Error(
    `RRC PDQ live fetching is not implemented (EXIT-BOUNDED constraint). ` +
      `Use fixtures or download bulk extracts from ftp://ftpe.rrc.texas.gov/shfwba/ ` +
      `(dbf900 format). For small queries, visit ${PDQ_BASE_URL} and export CSV manually.`,
  );
}

/**
 * Manual query instructions for RRC PDQ.
 *
 * 1. Visit: https://webapps2.rrc.texas.gov/PDQ/home.do
 * 2. Select query type:
 *    - "Lease Production Query" for oil (lease-level)
 *    - "Well Production Query" for gas (well-level)
 * 3. Enter district/lease/well criteria and date range
 * 4. Submit query and export results as CSV
 * 5. Parse CSV and normalize to production-timeseries atoms
 *
 * **Bulk Extract Path**:
 *
 * 1. Download EBCDIC files from ftp://ftpe.rrc.texas.gov/shfwba/
 *    - `dbf900.ebc.gz` for monthly production data
 * 2. Decompress and parse using the RRC's published dbf900 COBOL layout
 * 3. Filter to district/lease/well of interest
 * 4. Normalize to production-timeseries atoms
 *
 * The bulk extract includes full history back to ~1993 and is the recommended
 * path for comprehensive backfill.
 */
export const PDQ_MANUAL_INSTRUCTIONS = `
RRC PDQ Manual Query Instructions
==================================

For small queries (single lease/well, limited date range):

1. Visit: https://webapps2.rrc.texas.gov/PDQ/home.do
2. Select query type:
   - "Lease Production Query" for oil (lease-level)
   - "Well Production Query" for gas (well-level)
3. Enter district/lease/well criteria and date range (YYYY-MM format)
4. Submit query and export results as CSV
5. Parse CSV and normalize to production-timeseries atoms

For bulk backfill (full history):

1. Download EBCDIC files from ftp://ftpe.rrc.texas.gov/shfwba/
   - dbf900.ebc.gz for monthly production data
2. Decompress and parse using the RRC's published dbf900 COBOL layout
3. Filter to district/lease/well of interest
4. Normalize to production-timeseries atoms using this adapter's normalize module

The bulk extract includes full history back to ~1993 and is the recommended
path for comprehensive backfill. The dbf900 format is a fixed-width EBCDIC
mainframe file; use a COBOL layout reader or convert to ASCII first.
`;
