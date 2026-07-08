/**
 * Data acquisition layer for Reeves County O&G minting.
 *
 * - W-1: Live fetch from RRC EWA (working client)
 * - PDQ: Fixture-based (EXIT-BOUNDED constraint, live client not implemented)
 * - H-10: Fixture-based (EXIT-BOUNDED constraint, live client not implemented)
 *
 * Honest reporting: PDQ and H-10 results are clearly marked as fixture samples,
 * not full-county coverage. The report documents this explicitly.
 */

import { fetchW1Permits, type W1FetchResult } from "@hauska-engine/og-sources";
import type { PdqOilFetchResult, PdqGasFetchResult, H10FetchResult } from "@hauska-engine/og-sources";
// Import fixtures directly from source files (not exported in package public API)
import { reevesOilSample } from "../../og-sources/src/adapters/rrc-pdq/__fixtures__/reeves-oil-sample.js";
import { reevesGasSample } from "../../og-sources/src/adapters/rrc-pdq/__fixtures__/reeves-gas-sample.js";
import { reevesInjectionSample } from "../../og-sources/src/adapters/rrc-h10/__fixtures__/reeves-injection-sample.js";

/**
 * Acquisition status for honest reporting.
 */
export interface AcquisitionStatus {
  source: "w1" | "pdq-oil" | "pdq-gas" | "h10";
  status: "obtained" | "bounded" | "failed";
  recordCount: number;
  error?: string;
  note?: string;
}

/**
 * Aggregated acquisition results with status tracking.
 */
export interface AcquisitionResult {
  w1: W1FetchResult | null;
  pdqOil: PdqOilFetchResult | null;
  pdqGas: PdqGasFetchResult | null;
  h10: H10FetchResult | null;
  statuses: ReadonlyArray<AcquisitionStatus>;
  acquiredAt: string;
}

/**
 * Acquire W-1 drilling permits for Reeves County (live).
 *
 * Query: 2022-01-01 to present, county 389 (Reeves).
 * Strategy: Fetch ALLOCATION and PSA permits separately to avoid pagination issues.
 * The RRC EWA form's ASP.NET pagination is unreliable, so we fetch smaller subsets.
 */
export async function acquireW1Permits(): Promise<{
  result: W1FetchResult | null;
  status: AcquisitionStatus;
}> {
  const fromDate = "2022-01-01";
  const toDate = new Date().toISOString().split("T")[0]!;

  try {
    console.log(`Fetching W-1 permits in chunks (Reeves, ${fromDate} to ${toDate})...`);
    
    // Fetch ALLOCATION permits
    console.log(`  Fetching ALLOCATION permits...`);
    const allocationResult = await fetchW1Permits({
      county: "REEVES",
      fromDate,
      toDate,
      completionType: "ALLOCATION",
      maxResults: 10000,
    });
    console.log(`    Got ${allocationResult.permits.length} ALLOCATION permits`);
    
    // Fetch PSA permits
    console.log(`  Fetching PSA permits...`);
    const psaResult = await fetchW1Permits({
      county: "REEVES",
      fromDate,
      toDate,
      completionType: "PSA",
      maxResults: 10000,
    });
    console.log(`    Got ${psaResult.permits.length} PSA permits`);
    
    // Combine and deduplicate
    const allPermits = [...allocationResult.permits, ...psaResult.permits];
    const uniquePermits = Array.from(
      new Map(allPermits.map(p => [p.apiNumber, p])).values()
    );
    
    console.log(`  Combined: ${allPermits.length} total, ${uniquePermits.length} unique`);
    
    // Note: We're not fetching residual/other permits (no completion type filter)
    // because the RRC form doesn't support that query reliably and it would require pagination.
    // Based on C3b ratio: ALLOCATION=1724, PSA=344, Residual=1819 (~47% of total)
    
    const result: W1FetchResult = {
      permits: uniquePermits,
      queryParams: {
        county: "REEVES",
        fromDate,
        toDate,
        completionType: "ALLOCATION+PSA",
        maxResults: 10000,
      },
      sourceUrl: allocationResult.sourceUrl,
      fetchedAt: allocationResult.fetchedAt,
      totalCount: uniquePermits.length,
    };

    return {
      result,
      status: {
        source: "w1",
        status: "obtained",
        recordCount: result.permits.length,
        note: `Live fetch from RRC EWA (${fromDate} to ${toDate}). ALLOCATION + PSA permits only (standard/pooled/other permits excluded due to pagination limitations).`,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`W-1 fetch failed: ${message}`);
    return {
      result: null,
      status: {
        source: "w1",
        status: "failed",
        recordCount: 0,
        error: message,
      },
    };
  }
}

/**
 * Acquire PDQ oil production (fixture-based, EXIT-BOUNDED).
 *
 * Returns fixture data for Reeves County (3 leases, Jan-Mar 2024).
 * Honest reporting: This is a SAMPLE, not full county coverage.
 */
export function acquirePdqOil(): {
  result: PdqOilFetchResult;
  status: AcquisitionStatus;
} {
  const fetchedAt = new Date().toISOString();
  
  return {
    result: {
      records: reevesOilSample,
      queryParams: {
        district: "08",
        fromMonth: "2024-01",
        toMonth: "2024-03",
      },
      sourceUrl: "https://webapps2.rrc.texas.gov/PDQ/home.do",
      fetchedAt,
      totalCount: reevesOilSample.length,
    },
    status: {
      source: "pdq-oil",
      status: "bounded",
      recordCount: reevesOilSample.length,
      note: "FIXTURE SAMPLE (3 leases, Jan-Mar 2024). Not full county coverage. PDQ live client not implemented (EXIT-BOUNDED constraint).",
    },
  };
}

/**
 * Acquire PDQ gas production (fixture-based, EXIT-BOUNDED).
 *
 * Returns fixture data for Reeves County (3 wells, Jan-Mar 2024).
 * Honest reporting: This is a SAMPLE, not full county coverage.
 */
export function acquirePdqGas(): {
  result: PdqGasFetchResult;
  status: AcquisitionStatus;
} {
  const fetchedAt = new Date().toISOString();
  
  return {
    result: {
      records: reevesGasSample,
      queryParams: {
        district: "08",
        fromMonth: "2024-01",
        toMonth: "2024-03",
      },
      sourceUrl: "https://webapps2.rrc.texas.gov/PDQ/home.do",
      fetchedAt,
      totalCount: reevesGasSample.length,
    },
    status: {
      source: "pdq-gas",
      status: "bounded",
      recordCount: reevesGasSample.length,
      note: "FIXTURE SAMPLE (3 wells, Jan-Mar 2024). Not full county coverage. PDQ live client not implemented (EXIT-BOUNDED constraint).",
    },
  };
}

/**
 * Acquire H-10 injection/disposal data (fixture-based, EXIT-BOUNDED).
 *
 * Returns fixture data for Reeves County (3 wells, Jan-Mar 2024).
 * Honest reporting: This is a SAMPLE, not full county coverage.
 */
export function acquireH10Injection(): {
  result: H10FetchResult;
  status: AcquisitionStatus;
} {
  const fetchedAt = new Date().toISOString();
  
  return {
    result: {
      records: reevesInjectionSample,
      queryParams: {
        district: "08",
        fromMonth: "2024-01",
        toMonth: "2024-03",
      },
      sourceUrl: "https://webapps.rrc.texas.gov/H10/",
      fetchedAt,
      totalCount: reevesInjectionSample.length,
    },
    status: {
      source: "h10",
      status: "bounded",
      recordCount: reevesInjectionSample.length,
      note: "FIXTURE SAMPLE (3 wells, Jan-Mar 2024). Not full county coverage. H-10 live client not implemented (EXIT-BOUNDED constraint).",
    },
  };
}

/**
 * Acquire all sources for Reeves County mint.
 *
 * W-1 is fetched live; PDQ and H-10 use fixture samples (documented honestly).
 */
export async function acquireAll(): Promise<AcquisitionResult> {
  const acquiredAt = new Date().toISOString();
  const statuses: AcquisitionStatus[] = [];

  // W-1: Live fetch
  const w1 = await acquireW1Permits();
  statuses.push(w1.status);

  // PDQ: Fixture samples
  const pdqOil = acquirePdqOil();
  statuses.push(pdqOil.status);

  const pdqGas = acquirePdqGas();
  statuses.push(pdqGas.status);

  // H-10: Fixture sample
  const h10 = acquireH10Injection();
  statuses.push(h10.status);

  return {
    w1: w1.result,
    pdqOil: pdqOil.result,
    pdqGas: pdqGas.result,
    h10: h10.result,
    statuses,
    acquiredAt,
  };
}
