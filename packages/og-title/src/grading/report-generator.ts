/**
 * Grade report generator
 */

import type {
  RunsheetParseResult,
  ChainAssembly,
  GradeResult,
  VarianceLedgerEntry,
} from '../types.js';

export interface GradeReportInput {
  parseResult: RunsheetParseResult;
  chainAssembly: ChainAssembly;
  gradeResult: GradeResult;
  varianceLedger: VarianceLedgerEntry[];
}

/**
 * Generate complete grade report in markdown
 */
export function generateGradeReport(input: GradeReportInput): string {
  const { parseResult, chainAssembly, gradeResult, varianceLedger } = input;

  const sections: string[] = [];

  // Header
  sections.push('# Winkler County Title Method Baseline - Grade Report\n');
  sections.push(`**Generated:** ${new Date().toISOString()}\n`);
  sections.push(`**Target Tract:** S/2 SW/4 Section 25, Block B-5, PSL Survey, Winkler County, TX\n`);
  sections.push('---\n');

  // Executive Summary
  sections.push('## Executive Summary\n');
  sections.push(generateExecutiveSummary(parseResult, chainAssembly, gradeResult));
  sections.push('');

  // Parse Statistics
  sections.push('## Runsheet Parse Statistics\n');
  sections.push(generateParseStats(parseResult));
  sections.push('');

  // Chain Statistics
  sections.push('## Chain Assembly Statistics\n');
  sections.push(generateChainStats(chainAssembly));
  sections.push('');

  // Grade Results
  sections.push('## Grade: Method vs. Certified Report\n');
  sections.push(generateGradeStats(gradeResult));
  sections.push('');

  // Detailed Mismatches
  if (gradeResult.explanation.length > 0) {
    sections.push('## Detailed Analysis\n');
    sections.push(generateDetailedAnalysis(gradeResult));
    sections.push('');
  }

  // Variance Ledger
  sections.push('## Variance Ledger: County-Specific Assumptions\n');
  sections.push(generateVarianceLedger(varianceLedger));
  sections.push('');

  // Method Limitations
  sections.push('## Method v0 Limitations (Honest Assessment)\n');
  sections.push(generateMethodLimitations(chainAssembly, gradeResult));
  sections.push('');

  return sections.join('\n');
}

function generateExecutiveSummary(
  parseResult: RunsheetParseResult,
  chainAssembly: ChainAssembly,
  gradeResult: GradeResult
): string {
  const totalOwners = gradeResult.matched.length + gradeResult.missed.length + gradeResult.spurious.length;
  const matchedCount = gradeResult.matched.length;
  const matchRate = totalOwners > 0 ? (matchedCount / (matchedCount + gradeResult.missed.length)) * 100 : 0;

  const perfectMatches = gradeResult.matched.filter((m) => Math.abs(m.delta) < 0.001).length;
  const closeMatches = gradeResult.matched.filter((m) => Math.abs(m.delta) >= 0.001 && Math.abs(m.delta) < 0.05).length;

  return `This report grades the title-method baseline (method v0) against a certified Working Interest Ownership Report for S/2 SW/4 Section 25, Block B-5, Winkler County.

**Parse Performance:**
- Parsed ${parseResult.parsed.length} of ${parseResult.totalRows} instrument rows (${(parseResult.parseRate * 100).toFixed(1)}%)
- ${parseResult.unparsed.length} rows unparsed

**Chain Assembly:**
- ${chainAssembly.instruments.length} instruments scoped to target tract
- ${chainAssembly.gaps.length} gaps/ambiguities identified
- ${chainAssembly.workingInterest.length} working interest owners computed

**Grade:**
- **Owner Match Rate:** ${matchRate.toFixed(1)}% (${matchedCount}/${matchedCount + gradeResult.missed.length} owners found)
- **Perfect Interest Matches:** ${perfectMatches}
- **Close Matches (Δ < 5%):** ${closeMatches}
- **Missed Owners:** ${gradeResult.missed.length}
- **Spurious Owners:** ${gradeResult.spurious.length}

**Conclusion:** This is an EXPECTED low first score. Method v0 uses simplified chain logic and conservative name parsing. The variance ledger below documents Winkler-specific assumptions for future county-to-county calibration.`;
}

function generateParseStats(parseResult: RunsheetParseResult): string {
  const lines: string[] = [];

  lines.push(`- **Total Rows:** ${parseResult.totalRows}`);
  lines.push(`- **Successfully Parsed:** ${parseResult.parsed.length}`);
  lines.push(`- **Unparsed:** ${parseResult.unparsed.length}`);
  lines.push(`- **Parse Rate:** ${(parseResult.parseRate * 100).toFixed(2)}%`);

  if (parseResult.unparsed.length > 0) {
    lines.push('');
    lines.push('### Sample Unparsed Rows (first 5)');
    lines.push('');
    const samples = parseResult.unparsed.slice(0, 5);
    for (const unparsed of samples) {
      lines.push(`- **Line ${unparsed.lineNumber ?? '?'}:** ${unparsed.reason}`);
      lines.push(`  \`${unparsed.rawText.substring(0, 100)}${unparsed.rawText.length > 100 ? '...' : ''}\``);
    }
  }

  return lines.join('\n');
}

function generateChainStats(chainAssembly: ChainAssembly): string {
  const lines: string[] = [];

  const byFamily: Record<string, number> = {};
  for (const inst of chainAssembly.instruments) {
    byFamily[inst.typeFamily] = (byFamily[inst.typeFamily] ?? 0) + 1;
  }

  lines.push(`- **Total Scoped Instruments:** ${chainAssembly.instruments.length}`);
  lines.push(`- **Instrument Type Distribution:**`);
  for (const [family, count] of Object.entries(byFamily).sort((a, b) => b[1] - a[1])) {
    lines.push(`  - ${family}: ${count}`);
  }

  lines.push('');
  lines.push(`- **Identified Gaps:** ${chainAssembly.gaps.length}`);
  if (chainAssembly.gaps.length > 0) {
    for (const gap of chainAssembly.gaps) {
      lines.push(`  - ${gap}`);
    }
  }

  lines.push('');
  lines.push(`- **Computed Working Interest Owners:** ${chainAssembly.workingInterest.length}`);

  return lines.join('\n');
}

function generateGradeStats(gradeResult: GradeResult): string {
  const lines: string[] = [];

  lines.push('### Matched Owners\n');
  if (gradeResult.matched.length === 0) {
    lines.push('*None*\n');
  } else {
    lines.push('| Owner | Method WI | Report WI | Delta |');
    lines.push('|-------|-----------|-----------|-------|');
    for (const match of gradeResult.matched) {
      lines.push(
        `| ${match.owner} | ${match.methodInterest.toFixed(4)} | ${match.reportInterest.toFixed(4)} | ${Math.abs(match.delta).toFixed(4)} |`
      );
    }
    lines.push('');
  }

  lines.push('### Missed Owners (in Report, not in Method)\n');
  if (gradeResult.missed.length === 0) {
    lines.push('*None*\n');
  } else {
    lines.push('| Owner | Report WI |');
    lines.push('|-------|-----------|');
    for (const miss of gradeResult.missed) {
      lines.push(`| ${miss.owner} | ${miss.reportInterest.toFixed(4)} |`);
    }
    lines.push('');
  }

  lines.push('### Spurious Owners (in Method, not in Report)\n');
  if (gradeResult.spurious.length === 0) {
    lines.push('*None*\n');
  } else {
    lines.push('| Owner | Method WI |');
    lines.push('|-------|-----------|');
    for (const spurious of gradeResult.spurious) {
      lines.push(`| ${spurious.owner} | ${spurious.methodInterest.toFixed(4)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateDetailedAnalysis(gradeResult: GradeResult): string {
  const lines: string[] = [];

  lines.push('Each mismatch below includes the method\'s best explanation:\n');

  for (let i = 0; i < gradeResult.explanation.length; i++) {
    lines.push(`${i + 1}. ${gradeResult.explanation[i]}`);
    lines.push('');
  }

  return lines.join('\n');
}

function generateVarianceLedger(ledger: VarianceLedgerEntry[]): string {
  const lines: string[] = [];

  lines.push(
    'The variance ledger documents every Winkler-specific assumption baked into this baseline method. ' +
      'When the method encounters new counties, these entries become calibration points.\n'
  );

  const byCategory: Record<string, VarianceLedgerEntry[]> = {};
  for (const entry of ledger) {
    const cat = byCategory[entry.category];
    if (!cat) {
      byCategory[entry.category] = [];
    }
    byCategory[entry.category]?.push(entry);
  }

  for (const [category, entries] of Object.entries(byCategory)) {
    lines.push(`### ${categoryLabel(category)}\n`);
    for (const entry of entries) {
      lines.push(`- **${entry.assumption}**`);
      lines.push(`  ${entry.notes}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    'index-format': 'County Index Format',
    'instrument-type-vocabulary': 'Instrument Type Vocabulary',
    'survey-convention': 'Survey Convention',
    'legal-description-pattern': 'Legal Description Pattern',
    'recording-practice': 'Recording Practice',
  };
  const label = labels[category];
  return label ?? category;
}

function generateMethodLimitations(chainAssembly: ChainAssembly, gradeResult: GradeResult): string {
  const lines: string[] = [];

  lines.push('Method v0 is intentionally simplified to establish a graded baseline. Known limitations:\n');

  lines.push('1. **Parser conservatism:** The runsheet parser requires clean columnar structure. Wrapped rows or irregular formatting lands in the unparsed bucket, which may miss relevant instruments.');
  lines.push('');
  
  lines.push('2. **Name extraction:** Grantor/grantee name parsing uses simple capitalization heuristics. Names embedded in legal descriptions or split across lines are frequently missed.');
  lines.push('');
  
  lines.push('3. **Tract intersection logic:** Subdivision parsing (S2SW4, etc.) is conservative. Instruments with complex or non-standard legal descriptions may be incorrectly scoped.');
  lines.push('');
  
  lines.push('4. **Chain linkage:** Method v0 does not verify grantor-grantee linkage through the chain. It orders by date and classifies by type but does not validate that grantees in one deed become grantors in the next.');
  lines.push('');
  
  lines.push('5. **Interest computation:** Working interest calculation uses a placeholder equal-split rule when multiple assignments exist. It does not parse assignment fractions or depth severances.');
  lines.push('');
  
  lines.push('6. **Depth handling:** The certified report shows depth-severanced ownership. Method v0 does not parse depth intervals from instruments.');
  lines.push('');

  if (chainAssembly.gaps.length > 0) {
    lines.push(`7. **Identified gaps:** The method explicitly flagged ${chainAssembly.gaps.length} gaps in the chain (see Chain Assembly Statistics above). These represent known incompleteness.`);
    lines.push('');
  }

  lines.push('These limitations are expected and documented. Future method revisions will address them incrementally, with each change measured against this baseline.');

  return lines.join('\n');
}
