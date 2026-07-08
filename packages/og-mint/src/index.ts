#!/usr/bin/env tsx
/**
 * Reeves County O&G mint orchestration.
 *
 * End-to-end pipeline:
 * 1. Acquire live RRC data (W-1, PDQ fixture, H-10 fixture)
 * 2. Normalize to validated @empressaio/atom-contract@1.7.0 atoms
 * 3. Emit artifacts (ndjson, report, sample, twin-export)
 *
 * EXIT-BOUNDED: No watch modes, dev servers, or non-terminating processes.
 * Wall-clock time and cost capture are tracked and reported.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireAll } from "./acquire.js";
import {
  normalizeW1ToWells,
  normalizePdqOilToAtoms,
  normalizePdqGasToAtoms,
  normalizeH10ToAtoms,
} from "./normalize.js";
import { generateMintReport, type MintStats } from "./report.js";
import { generateTwinExport, validateTwinExportSize } from "./twin-export.js";

const ARTIFACTS_DIR = join(process.cwd(), "artifacts");

/**
 * Main mint orchestration.
 */
async function main() {
  console.log("========================================");
  console.log("Reeves County O&G Mint");
  console.log("========================================\n");

  const startTime = Date.now();

  // Step 1: Acquire data
  console.log("Step 1: Acquiring data from RRC sources...\n");
  const acquisition = await acquireAll();

  console.log("\nAcquisition complete:");
  for (const status of acquisition.statuses) {
    const badge = status.status === "obtained" ? "✓" : status.status === "bounded" ? "⚠" : "✗";
    console.log(`  ${badge} ${status.source}: ${status.recordCount} records (${status.status})`);
    if (status.note) {
      console.log(`     Note: ${status.note}`);
    }
  }

  // Step 2: Normalize to atoms with validation
  console.log("\nStep 2: Normalizing to atoms with validation...\n");

  let wellStats = { attempted: 0, validated: 0, dropped: 0, dropReasons: [] as ReadonlyArray<{ record: string; reason: string }> };
  let pdqOilStats = { attempted: 0, validated: 0, dropped: 0, dropReasons: [] as ReadonlyArray<{ record: string; reason: string }> };
  let pdqGasStats = { attempted: 0, validated: 0, dropped: 0, dropReasons: [] as ReadonlyArray<{ record: string; reason: string }> };
  let h10Stats = { attempted: 0, validated: 0, dropped: 0, dropReasons: [] as ReadonlyArray<{ record: string; reason: string }> };

  let allAtoms: Array<any> = [];

  // W-1 → well atoms
  if (acquisition.w1) {
    console.log("  Normalizing W-1 permits → well atoms...");
    const result = normalizeW1ToWells(acquisition.w1);
    wellStats = result.stats;
    allAtoms.push(...result.atoms);
    console.log(`    ✓ ${result.atoms.length} well atoms validated`);
    if (result.stats.dropped > 0) {
      console.log(`    ⚠ ${result.stats.dropped} records dropped (see report for reasons)`);
    }
  }

  // PDQ Oil → production-timeseries atoms
  if (acquisition.pdqOil) {
    console.log("  Normalizing PDQ oil → production-timeseries atoms...");
    const result = normalizePdqOilToAtoms(acquisition.pdqOil);
    pdqOilStats = result.stats;
    allAtoms.push(...result.atoms);
    console.log(`    ✓ ${result.atoms.length} production-timeseries atoms validated (oil)`);
  }

  // PDQ Gas → production-timeseries atoms
  if (acquisition.pdqGas) {
    console.log("  Normalizing PDQ gas → production-timeseries atoms...");
    const result = normalizePdqGasToAtoms(acquisition.pdqGas);
    pdqGasStats = result.stats;
    allAtoms.push(...result.atoms);
    console.log(`    ✓ ${result.atoms.length} production-timeseries atoms validated (gas)`);
  }

  // H-10 → production-timeseries atoms
  if (acquisition.h10) {
    console.log("  Normalizing H-10 injection → production-timeseries atoms...");
    const result = normalizeH10ToAtoms(acquisition.h10);
    h10Stats = result.stats;
    allAtoms.push(...result.atoms);
    console.log(`    ✓ ${result.atoms.length} production-timeseries atoms validated (injection)`);
  }

  const totalAtoms = allAtoms.length;
  const wallClockMs = Date.now() - startTime;

  console.log(`\n  Total atoms: ${totalAtoms}`);
  console.log(`  Wall-clock time: ${(wallClockMs / 1000).toFixed(2)}s`);

  // Step 3: Generate artifacts
  console.log("\nStep 3: Generating artifacts...\n");

  // Ensure artifacts directory exists
  await mkdir(ARTIFACTS_DIR, { recursive: true });

  // 3a. Full atom set (GITIGNORED)
  const fullNdjson = allAtoms.map((a) => JSON.stringify(a)).join("\n");
  const fullNdjsonPath = join(ARTIFACTS_DIR, "reeves-atoms.ndjson");
  await writeFile(fullNdjsonPath, fullNdjson, "utf8");
  const fullNdjsonSizeMB = (Buffer.byteLength(fullNdjson, "utf8") / (1024 * 1024)).toFixed(2);
  console.log(`  ✓ reeves-atoms.ndjson (${totalAtoms} atoms, ${fullNdjsonSizeMB} MB) [GITIGNORED]`);

  // 3b. Sample (COMMITTED, ~50 atoms spanning all types)
  const sampleAtoms = generateSampleAtoms(allAtoms, 50);
  const sampleNdjson = sampleAtoms.map((a) => JSON.stringify(a)).join("\n");
  const sampleNdjsonPath = join(ARTIFACTS_DIR, "reeves-atom-sample.ndjson");
  await writeFile(sampleNdjsonPath, sampleNdjson, "utf8");
  console.log(`  ✓ reeves-atom-sample.ndjson (${sampleAtoms.length} atoms) [COMMITTED]`);

  // 3c. Mint report (COMMITTED)
  const mintStats: MintStats = {
    acquisition,
    wellStats,
    pdqOilStats,
    pdqGasStats,
    h10Stats,
    totalAtoms,
    wallClockMs,
    reportGeneratedAt: new Date().toISOString(),
  };
  const report = generateMintReport(mintStats);
  const reportPath = join(ARTIFACTS_DIR, "reeves-mint-report.md");
  await writeFile(reportPath, report, "utf8");
  console.log(`  ✓ reeves-mint-report.md [COMMITTED]`);

  // 3d. Twin export (COMMITTED, must stay under ~200KB)
  const wells = allAtoms.filter((a) => a.entityType === "well");
  const productionTimeseries = allAtoms.filter((a) => a.entityType === "production-timeseries");
  const twinExport = generateTwinExport(wells, productionTimeseries, acquisition.acquiredAt);
  const twinExportJson = JSON.stringify(twinExport, null, 2);
  const twinExportPath = join(ARTIFACTS_DIR, "twin-export.json");
  await writeFile(twinExportPath, twinExportJson, "utf8");

  const sizeValidation = validateTwinExportSize(twinExport);
  const sizeKB = (sizeValidation.sizeBytes / 1024).toFixed(2);
  const sizeStatus = sizeValidation.withinLimit ? "✓" : "✗";
  console.log(`  ${sizeStatus} twin-export.json (${sizeKB} KB) [COMMITTED]`);
  if (!sizeValidation.withinLimit) {
    console.warn(`    ⚠ WARNING: Twin export exceeds 200KB limit!`);
  }

  // Done
  const totalElapsedS = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n========================================`);
  console.log(`Mint complete in ${totalElapsedS}s`);
  console.log(`========================================\n`);
  console.log(`Artifacts written to: ${ARTIFACTS_DIR}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review the mint report: cat ${reportPath ?? "artifacts/reeves-mint-report.md"}`);
  console.log(`  2. Run the eval suite: pnpm run eval`);
  console.log(`  3. Commit and push: git add . && git commit -m "feat(c6): Reeves County mint artifacts"`);
  console.log();
}

/**
 * Generate a sample of atoms spanning all types (for review).
 *
 * Takes ~50 atoms (or fewer if total < 50), ensuring at least one of each type
 * is included if available.
 */
function generateSampleAtoms(allAtoms: Array<any>, targetCount: number): Array<any> {
  const sample: Array<any> = [];
  const byType: Record<string, Array<any>> = {};

  // Group by entityType
  for (const atom of allAtoms) {
    const type = atom.entityType || "unknown";
    if (!byType[type]) {
      byType[type] = [];
    }
    byType[type].push(atom);
  }

  // Take at least one of each type
  for (const type in byType) {
    const atoms = byType[type];
    if (atoms && atoms.length > 0 && atoms[0]) {
      sample.push(atoms[0]);
    }
  }

  // Fill remaining slots evenly across types
  const remaining = targetCount - sample.length;
  if (remaining > 0) {
    const types = Object.keys(byType);
    const perType = Math.ceil(remaining / types.length);

    for (const type of types) {
      const atoms = byType[type];
      if (atoms) {
        const available = atoms.slice(1); // Skip first (already added)
        const take = available.slice(0, perType);
        sample.push(...take);
      }
    }
  }

  return sample.slice(0, targetCount);
}

// Run the mint
main().catch((error: unknown) => {
  console.error("\n✗ Mint failed:", error);
  process.exit(1);
});
