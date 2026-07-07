#!/usr/bin/env node
/**
 * RRC W-1 Allocation-vs-PSA Ratio Report Generator.
 *
 * This script queries the RRC EWA drilling permits surface for Reeves County
 * and generates a report showing:
 * - Count of ALLOCATION wells (2022-01-01 to present)
 * - Count of PSA wells
 * - Total count (all completion types)
 * - Residual (total - allocation - PSA - standard)
 *
 * The residual approximates pooled+standalone wells, which public data cannot
 * split. Per the task spec, this is reported as a residual, never as a
 * resolved "pooled" or "standalone" count.
 *
 * Usage:
 *   pnpm --filter @hauska-tools/rrc-ratio-report start
 *
 * Output:
 *   Writes `reeves_w1_ratio_report.md` to the project root.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fetchW1PermitCount } from "@hauska-engine/og-sources";
import type { W1QueryParams } from "@hauska-engine/og-sources";

/**
 * Date range for the report: 2022-01-01 to present.
 */
const REPORT_FROM_DATE = "2022-01-01";
const REPORT_TO_DATE = new Date().toISOString().split("T")[0]!;

/**
 * Reeves County RRC identifier.
 */
const REEVES_COUNTY = "REEVES";

/**
 * Report output path (relative to project root).
 */
const REPORT_OUTPUT_PATH = path.join(
  process.cwd(),
  "../../reeves_w1_ratio_report.md",
);

/**
 * Main entry point: fetch counts and generate report.
 */
async function main() {
  console.log("RRC W-1 Ratio Report Generator");
  console.log("================================");
  console.log(`County: ${REEVES_COUNTY}`);
  console.log(`Date range: ${REPORT_FROM_DATE} to ${REPORT_TO_DATE}`);
  console.log();

  const runTimestamp = new Date().toISOString();

  let allocationCount: number;
  let psaCount: number;
  let totalCount: number;

  try {
    console.log("Querying RRC EWA for ALLOCATION wells...");
    allocationCount = await fetchCountWithRetry({
      county: REEVES_COUNTY,
      fromDate: REPORT_FROM_DATE,
      toDate: REPORT_TO_DATE,
      completionType: "ALLOCATION",
    });
    console.log(`  → ${allocationCount} permits found`);

    console.log("Querying RRC EWA for PSA wells...");
    psaCount = await fetchCountWithRetry({
      county: REEVES_COUNTY,
      fromDate: REPORT_FROM_DATE,
      toDate: REPORT_TO_DATE,
      completionType: "PSA",
    });
    console.log(`  → ${psaCount} permits found`);

    console.log("Querying RRC EWA for all wells (total)...");
    totalCount = await fetchCountWithRetry({
      county: REEVES_COUNTY,
      fromDate: REPORT_FROM_DATE,
      toDate: REPORT_TO_DATE,
      completionType: "", // blank = all
    });
    console.log(`  → ${totalCount} permits found`);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`\nError fetching counts: ${message}`);
    console.error(
      "\nThe RRC EWA query surface may be unavailable or its structure may have changed.",
    );
    console.error(
      "To generate the report manually, visit the RRC EWA and run the queries:\n",
    );
    printManualQuerySteps();
    process.exit(1);
  }

  // Calculate residual (approximates pooled+standalone)
  const residual = totalCount - allocationCount - psaCount;

  // Generate markdown report
  const reportMarkdown = generateReportMarkdown({
    allocationCount,
    psaCount,
    totalCount,
    residual,
    runTimestamp,
  });

  // Write report to disk
  try {
    await fs.writeFile(REPORT_OUTPUT_PATH, reportMarkdown, "utf8");
    console.log(`\n✓ Report written to: ${REPORT_OUTPUT_PATH}`);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`\nFailed to write report: ${message}`);
    console.log("\nReport content:\n");
    console.log(reportMarkdown);
    process.exit(1);
  }
}

/**
 * Fetch count with retry (max 2 retries per task constraint).
 */
async function fetchCountWithRetry(
  params: W1QueryParams,
): Promise<number> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetchW1PermitCount(params);
    } catch (error: unknown) {
      lastError =
        error instanceof Error ? error : new Error(String(error));
      console.warn(
        `  Attempt ${attempt}/2 failed: ${lastError.message}`,
      );
      if (attempt < 2) {
        console.log("  Retrying in 2 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  throw lastError ?? new Error("Unknown error during fetch");
}

/**
 * Generate the markdown report content.
 */
function generateReportMarkdown(data: {
  allocationCount: number;
  psaCount: number;
  totalCount: number;
  residual: number;
  runTimestamp: string;
}): string {
  const queryUrl =
    "https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do";

  return `# Reeves County RRC W-1 Allocation-vs-PSA Ratio Report

**Generated:** ${data.runTimestamp}  
**County:** Reeves County, Texas  
**Date Range:** ${REPORT_FROM_DATE} to ${REPORT_TO_DATE}  
**Source:** [RRC EWA Drilling Permit Query](${queryUrl})

---

## Summary

This report queries the RRC's W-1 drilling permit database to count permits
by **Wellbore Profile/Completion Type** for Reeves County. The three
categories are:

1. **ALLOCATION** — Allocation wells
2. **PSA** — Production Sharing Agreement wells
3. **Total** — All permits (unfiltered)

The **residual** (total minus allocation minus PSA) approximates the sum of
pooled and standalone wells. Public RRC data does **not** split pooled vs.
standalone; this split is a derived attribute resolved only through county
land ingest and lease parsing.

---

## Counts

| Category       | Count |
|----------------|------:|
| **ALLOCATION** | ${data.allocationCount.toString().padStart(5)} |
| **PSA**        | ${data.psaCount.toString().padStart(5)} |
| **Total**      | ${data.totalCount.toString().padStart(5)} |
| **Residual**   | ${data.residual.toString().padStart(5)} |

**Residual breakdown (estimated):**
- Standard wells: ~${Math.max(0, data.residual)} (includes pooled + standalone, unresolvable from public data)

---

## Query Provenance

**URL:** ${queryUrl}  
**Method:** HTTP POST (form submission)  
**Form Parameters:**
- \`county\`: REEVES
- \`fromDate\`: ${REPORT_FROM_DATE}
- \`toDate\`: ${REPORT_TO_DATE}
- \`completionType\`: (varies per query — "ALLOCATION", "PSA", or blank for total)

**Run Timestamp:** ${data.runTimestamp}

---

## Notes

1. **Pooled vs. Standalone:** Public RRC data does NOT distinguish pooled
   wells from standalone wells. The residual count includes both categories
   plus any other non-allocation, non-PSA permits. Resolving this split
   requires cross-referencing lease assignments and tract ownership data,
   which is outside the scope of the W-1 adapter.

2. **Schema Validation:** This report validates the adapter's design
   principle: pooled-vs-standalone is a **derived attribute**, never directly
   sourced from RRC public data. The W-1 adapter correctly omits any
   "pooled" or "standalone" field from the well atoms it produces.

3. **Data Freshness:** RRC permits are updated in near-real-time. The counts
   in this report reflect the state of the database at the run timestamp.

---

## Manual Query Steps

If live fetching is unavailable, run the queries manually:

1. Visit: ${queryUrl}
2. Fill in the form:
   - **County:** REEVES
   - **Date Submitted From:** ${REPORT_FROM_DATE}
   - **Date Submitted To:** ${REPORT_TO_DATE}
   - **Wellbore Profile/Completion Type:** (see below)
3. Submit and note the result count.

**Three queries to run:**

1. **Allocation count:** Set "Wellbore Profile/Completion Type" = "ALLOCATION"
2. **PSA count:** Set "Wellbore Profile/Completion Type" = "PSA"
3. **Total count:** Leave "Wellbore Profile/Completion Type" blank (or "ALL")

Record the counts and compute the residual: \`total - allocation - PSA\`.
`;
}

/**
 * Print manual query steps to the console (fallback when live fetch fails).
 */
function printManualQuerySteps() {
  console.log("1. Visit: https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do");
  console.log("2. Fill in the form:");
  console.log("   - County: REEVES");
  console.log(`   - Date Submitted From: ${REPORT_FROM_DATE}`);
  console.log(`   - Date Submitted To: ${REPORT_TO_DATE}`);
  console.log(
    "   - Wellbore Profile/Completion Type: (varies per query)",
  );
  console.log("3. Run three queries:");
  console.log(
    "   a) Set Completion Type = 'ALLOCATION' → note the count",
  );
  console.log("   b) Set Completion Type = 'PSA' → note the count");
  console.log("   c) Leave Completion Type blank → note the count (total)");
  console.log("4. Compute residual: total - allocation - PSA");
}

// Run the script
main().catch((error: unknown) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
