#!/usr/bin/env node
/**
 * End-to-end runner for Winkler County title method baseline
 * 
 * Reads the Winkler PDFs from doc_repo, runs the full pipeline, generates grade report
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRunsheetPdf } from './parser/index.js';
import { scopeInstrumentsToTract } from './chain/scoping.js';
import { assembleChain } from './chain/assembly.js';
import { parseWIReportPdf } from './grading/wi-report-parser.js';
import { compareWorkingInterest } from './grading/comparator.js';
import { generateGradeReport } from './grading/report-generator.js';
import type { VarianceLedgerEntry } from './types.js';

const DOC_REPO_BASE = 'P:\\doc_repo\\_verticals\\oil_gas\\assets\\title_exemplars';

const RUNSHEET_PDF = resolve(
  DOC_REPO_BASE,
  '2015-12-14_county_index_runsheet_winkler_sec25_blkB5.pdf'
);

const WI_REPORT_PDF = resolve(
  DOC_REPO_BASE,
  '2015-10-24_working_interest_report_winkler_s2sw4_sec25_blkB5.pdf'
);

const OUTPUT_REPORT = resolve(process.cwd(), 'artifacts/winkler-grade-report.md');

async function main() {
  console.log('=== Winkler County Title Method Baseline ===\n');

  // Step 1: Parse runsheet
  console.log('Step 1: Parsing county index runsheet...');
  const runsheetBuffer = readFileSync(RUNSHEET_PDF);
  const parseResult = await parseRunsheetPdf(runsheetBuffer);
  console.log(`  Parsed ${parseResult.parsed.length} of ${parseResult.totalRows} rows (${(parseResult.parseRate * 100).toFixed(1)}%)\n`);

  // Step 2: Scope to target tract
  console.log('Step 2: Scoping instruments to S/2 SW/4 Section 25, Block B-5...');
  const target = {
    section: '25',
    block: 'B-5',
    subdivision: 'S2SW4',
    county: 'Winkler',
  };
  const scoped = scopeInstrumentsToTract(parseResult.parsed, target);
  console.log(`  ${scoped.length} instruments scoped to target tract\n`);

  // Step 3: Assemble chain
  console.log('Step 3: Assembling working interest chain...');
  const chainAssembly = assembleChain(scoped);
  console.log(`  ${chainAssembly.instruments.length} instruments in chain`);
  console.log(`  ${chainAssembly.gaps.length} gaps identified`);
  console.log(`  ${chainAssembly.workingInterest.length} WI owners computed\n`);

  // Step 4: Parse WI report
  console.log('Step 4: Parsing certified WI report...');
  const wiReportBuffer = readFileSync(WI_REPORT_PDF);
  const reportWI = await parseWIReportPdf(wiReportBuffer);
  console.log(`  ${reportWI.length} owners in certified report\n`);

  // Step 5: Grade method against report
  console.log('Step 5: Grading method output...');
  const gradeResult = compareWorkingInterest(chainAssembly.workingInterest, reportWI);
  console.log(`  Matched: ${gradeResult.matched.length}`);
  console.log(`  Missed: ${gradeResult.missed.length}`);
  console.log(`  Spurious: ${gradeResult.spurious.length}\n`);

  // Step 6: Build variance ledger
  console.log('Step 6: Building variance ledger...');
  const varianceLedger = buildVarianceLedger();
  console.log(`  ${varianceLedger.length} ledger entries documented\n`);

  // Step 7: Generate grade report
  console.log('Step 7: Generating grade report...');
  const report = generateGradeReport({
    parseResult,
    chainAssembly,
    gradeResult,
    varianceLedger,
  });

  writeFileSync(OUTPUT_REPORT, report, 'utf-8');
  console.log(`  Report written to: ${OUTPUT_REPORT}\n`);

  console.log('=== Complete ===');
  console.log('\nHonest grade summary:');
  const matchRate = gradeResult.matched.length / (gradeResult.matched.length + gradeResult.missed.length) * 100;
  console.log(`  Owner match rate: ${matchRate.toFixed(1)}%`);
  console.log(`  This is an EXPECTED low first score for method v0.`);
  console.log(`  See ${OUTPUT_REPORT} for full analysis.\n`);
}

/**
 * Build variance ledger documenting Winkler-specific assumptions
 */
function buildVarianceLedger(): VarianceLedgerEntry[] {
  return [
    {
      assumption: 'Columnar index format with INSTRUMENT TYPE, BOOK/PAGE, INST#, dates, parties, LEGAL, FILED DATE',
      category: 'index-format',
      notes: 'Winkler County clerk provides a structured "EDIT LIST" with consistent column headers. Other counties may use freeform chronological lists or different column orders.',
    },
    {
      assumption: 'INSTRUMENT TYPE vocabulary includes "OG LEASE", "MINERAL DEED", "ROYALTY DEED", "ASSIGNMENT", etc.',
      category: 'instrument-type-vocabulary',
      notes: 'These abbreviations are Winkler-specific. Other counties may use "O&G LEASE", "OIL AND GAS LEASE", "M/D", or full instrument names.',
    },
    {
      assumption: 'Public School Lands (PSL) survey with "BLK B-5" notation',
      category: 'survey-convention',
      notes: 'PSL surveys use Block notation. Other Texas counties may use different surveys (e.g., metes and bounds, railroad surveys, abstracts without blocks).',
    },
    {
      assumption: 'Legal descriptions use "SEC 25 BLK B-5" followed by subdivisions (SE, W2, S2SW4, ALL)',
      category: 'legal-description-pattern',
      notes: 'This section-block-subdivision pattern is common in West Texas PSL. Other regions may use township-range (PLSS), abstract-survey, or metes and bounds exclusively.',
    },
    {
      assumption: 'Subdivision notation: "S2SW4" means S/2 of SW/4, "ALL" means entire section',
      category: 'legal-description-pattern',
      notes: 'This aliquot-part notation is standard but not universal. Some counties spell out "South Half of Southwest Quarter" or use fractions.',
    },
    {
      assumption: 'Two-date system: instrument date and filed date, with filed date occasionally years later',
      category: 'recording-practice',
      notes: 'Winkler shows some instruments filed decades after execution. Other counties may have different filing patterns or single-date systems.',
    },
    {
      assumption: 'RELATED BK/PG column cross-references amendments, releases, and related instruments',
      category: 'index-format',
      notes: 'Winkler index includes explicit cross-references. Other counties may lack this field, requiring inference from document content.',
    },
    {
      assumption: 'Index coverage appears complete from sovereignty grant forward',
      category: 'recording-practice',
      notes: 'Winkler runsheet spans 1909-2015 with no obvious gaps. Other counties may have incomplete digitization, lost records, or multiple index systems by era.',
    },
  ];
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
