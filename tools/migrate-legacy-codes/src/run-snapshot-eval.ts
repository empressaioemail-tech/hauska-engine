#!/usr/bin/env tsx
/**
 * Run eval harness against the committed corpus snapshot to generate
 * per-jurisdiction retrieval-quality eval-scores artifact.
 *
 * This script loads the snapshot, runs the eval with curated queries,
 * and outputs per-jurisdiction JSON reports plus a summary README.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { InMemoryStorage, type CorpusSnapshot } from "@hauska-engine/storage";
import { evaluate, DEFAULT_QUALITY_BAR, type EvalReport } from "@hauska-engine/corpus/eval";
import { curatedQueriesForJurisdiction } from "./seed-curated-queries.js";

interface EvalScoresSummary {
  jurisdictionTenant: string;
  jurisdictionName: string;
  top3Accuracy: number;
  sectionRetrievability: number;
  crossRefAccuracy: number;
  atomCount: number;
  qualityBarPassed: boolean;
  evaluatedAt: string;
  sectionsSampled: number;
  crossRefsSampled: number;
  queriesEvaluated: number;
}

async function main() {
  console.log("Loading corpus snapshot...");
  const snapshotPath = join(
    process.cwd(),
    "..",
    "..",
    "services",
    "retrieval-api",
    "corpus",
    "snapshot.json"
  );
  
  const snapshotRaw = readFileSync(snapshotPath, "utf-8");
  const snapshot: CorpusSnapshot = JSON.parse(snapshotRaw);

  console.log(`Snapshot loaded: ${snapshot.atoms.length} atoms`);
  console.log("Hydrating in-memory storage...");
  const storage = await InMemoryStorage.fromSnapshot(snapshot);
  console.log("Storage hydrated.\n");

  // Extract jurisdictions from snapshot's jurisdictionStatus (includes proper names)
  const jurisdictions = snapshot.jurisdictionStatus.map((js) => ({
    tenant: js.jurisdictionTenant,
    name: js.jurisdictionName,
    atomCount: js.atomCount,
  }));

  console.log(`Found ${jurisdictions.length} jurisdictions\n`);

  const summaries: EvalScoresSummary[] = [];
  const detailedReports: Map<string, EvalReport> = new Map();

  for (const jurisdiction of jurisdictions) {
    console.log(`Evaluating ${jurisdiction.name} (${jurisdiction.tenant})...`);

    // Get curated queries for this jurisdiction
    const queries = curatedQueriesForJurisdiction(jurisdiction.tenant);
    
    try {
      const report = await evaluate({
        storage,
        jurisdictionTenant: jurisdiction.tenant,
        queries,
        sectionSampleSize: 100,
        crossRefSampleSize: 100,
        thresholds: DEFAULT_QUALITY_BAR,
      });

      detailedReports.set(jurisdiction.tenant, report);

      const summary: EvalScoresSummary = {
        jurisdictionTenant: jurisdiction.tenant,
        jurisdictionName: jurisdiction.name,
        top3Accuracy: report.scores.top3Score,
        sectionRetrievability: report.scores.sectionNumScore,
        crossRefAccuracy: report.scores.crossRefScore,
        atomCount: jurisdiction.atomCount,
        qualityBarPassed: report.passed,
        evaluatedAt: report.evaluatedAt,
        sectionsSampled: report.sectionsSampled,
        crossRefsSampled: report.crossRefsSampled,
        queriesEvaluated: report.queriesEvaluated,
      };

      summaries.push(summary);

      console.log(`  ✓ Top-3 Accuracy: ${(summary.top3Accuracy * 100).toFixed(1)}% (${summary.queriesEvaluated} queries)`);
      console.log(`  ✓ Section Retrievability: ${(summary.sectionRetrievability * 100).toFixed(1)}% (${summary.sectionsSampled} sampled)`);
      console.log(`  ✓ Cross-ref Accuracy: ${(summary.crossRefAccuracy * 100).toFixed(1)}% (${summary.crossRefsSampled} sampled)`);
      console.log(`  ✓ Quality Bar: ${summary.qualityBarPassed ? "PASSED" : "FAILED"}\n`);
    } catch (error) {
      console.error(`  ✗ Error evaluating ${jurisdiction.tenant}:`, error);
      // Continue with next jurisdiction
    }
  }

  // Write results to eval-scores/ directory
  console.log("\nWriting results to eval-scores/...");
  const outputDir = join(process.cwd(), "..", "..", "eval-scores");
  await mkdir(outputDir, { recursive: true });

  // Write individual jurisdiction reports
  for (const [tenant, report] of detailedReports.entries()) {
    const reportPath = join(outputDir, `${tenant}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  }

  // Generate and write summary README
  const readmeContent = generateReadme(summaries);
  const readmePath = join(outputDir, "README.md");
  await writeFile(readmePath, readmeContent, "utf-8");

  console.log(`\n✓ Eval complete!`);
  console.log(`  - ${detailedReports.size} jurisdiction JSON reports`);
  console.log(`  - 1 summary README.md`);
  console.log(`\nResults written to: ${outputDir}/`);
}

function generateReadme(summaries: EvalScoresSummary[]): string {
  const lines: string[] = [
    "# Retrieval Quality Eval Scores",
    "",
    "Per-jurisdiction retrieval quality metrics demonstrating that confidence is earned and made visible.",
    "",
    "## Quality Bar Thresholds",
    "",
    "- **Top-3 Accuracy**: 90% minimum (retrieval on curated queries)",
    "- **Section Retrievability**: 100% minimum (section-number lookup accuracy)",
    "- **Cross-ref Accuracy**: 95% minimum (cross-reference resolution)",
    "",
    "## Evaluation Methodology",
    "",
    "This evaluation was run against the committed corpus snapshot at `services/retrieval-api/corpus/snapshot.json` using the eval harness at `packages/corpus/src/eval/index.ts`.",
    "",
    "### Metrics Tested",
    "",
    "1. **Top-3 Accuracy**: For each curated query, retrieves top-3 results and verifies the expected atom DID is present",
    "2. **Section Retrievability**: Samples up to 100 section atoms per jurisdiction and verifies each is retrievable by exact section number via `getSectionsBySectionNumber`",
    "3. **Cross-ref Accuracy**: Samples up to 100 cross-reference atoms per jurisdiction and verifies each `toSectionId` resolves to a real section atom",
    "",
    "### Curated Queries",
    "",
    "Curated queries are sourced from `tools/migrate-legacy-codes/src/*-curated-queries.ts` files. These are reviewer-zero-style queries targeting specific sections with natural language text. Jurisdictions without curated queries receive a default score of 100% for Top-3 Accuracy (N/A case).",
    "",
    "## Results",
    "",
    `Evaluated at: ${new Date().toISOString()}`,
    "",
    "| Jurisdiction | Top-3 Accuracy | Section Retrievability | Cross-ref Accuracy | Atom Count | Quality Bar |",
    "|-------------|----------------|------------------------|-------------------|------------|-------------|",
  ];

  // Sort by jurisdiction name
  const sorted = [...summaries].sort((a, b) =>
    a.jurisdictionName.localeCompare(b.jurisdictionName)
  );

  for (const summary of sorted) {
    const top3 = summary.queriesEvaluated === 0 
      ? "N/A (no queries)"
      : `${(summary.top3Accuracy * 100).toFixed(1)}%`;
    const section = summary.sectionsSampled === 0
      ? "N/A (no sections)"
      : `${(summary.sectionRetrievability * 100).toFixed(1)}%`;
    const xref = summary.crossRefsSampled === 0
      ? "N/A (no xrefs)"
      : `${(summary.crossRefAccuracy * 100).toFixed(1)}%`;
    const qualityBar = summary.qualityBarPassed ? "✓ PASS" : "✗ FAIL";
    
    lines.push(
      `| ${summary.jurisdictionName} | ${top3} | ${section} | ${xref} | ${summary.atomCount.toLocaleString()} | ${qualityBar} |`
    );
  }

  lines.push("");
  lines.push("## Individual Reports");
  lines.push("");
  lines.push("Detailed per-jurisdiction eval reports are available as JSON files in this directory:");
  lines.push("");

  for (const summary of sorted) {
    lines.push(`- \`${summary.jurisdictionTenant}.json\` - ${summary.jurisdictionName}`);
  }

  lines.push("");
  lines.push("## Report Schema");
  lines.push("");
  lines.push("Each jurisdiction JSON file contains:");
  lines.push("");
  lines.push("```typescript");
  lines.push("interface EvalReport {");
  lines.push("  jurisdictionTenant: string;");
  lines.push("  evaluatedAt: string;");
  lines.push("  passed: boolean;");
  lines.push("  scores: {");
  lines.push("    top3Score: number;");
  lines.push("    sectionNumScore: number;");
  lines.push("    crossRefScore: number;");
  lines.push("  };");
  lines.push("  thresholds: QualityBarThresholds;");
  lines.push("  failures: QueryRunFailure[];");
  lines.push("  queriesEvaluated: number;");
  lines.push("  sectionsSampled: number;");
  lines.push("  crossRefsSampled: number;");
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- Scores are expressed as decimals (0.0 to 1.0)");
  lines.push("- Jurisdictions with zero samples for a metric default to 100% (no data to test)");
  lines.push("- Quality bar passing requires ALL three metrics to meet their respective thresholds");
  lines.push("- The `failures` array in each report contains details on any queries that did not retrieve their expected atom in the top-3 results");
  lines.push("");

  return lines.join("\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
