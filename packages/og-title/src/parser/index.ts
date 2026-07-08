/**
 * Runsheet PDF parser
 * 
 * Deterministic parsing (no LLM) of county index runsheet PDF to structured instrument records.
 * Conservative parsing: every row either parses cleanly or lands in unparsed bucket.
 */

import pdf from 'pdf-parse';
import type {
  InstrumentRecord,
  UnparsedRow,
  RunsheetParseResult,
  LegalDescription,
} from '../types.js';

/**
 * Parse a county index runsheet PDF to structured instrument records
 */
export async function parseRunsheetPdf(pdfBuffer: Buffer): Promise<RunsheetParseResult> {
  const data = await pdf(pdfBuffer);
  const text = data.text;

  return parseRunsheetText(text);
}

/**
 * Parse extracted text from runsheet PDF
 */
export function parseRunsheetText(text: string): RunsheetParseResult {
  const lines = text.split('\n');
  const parsed: InstrumentRecord[] = [];
  const unparsed: UnparsedRow[] = [];

  let currentRow: string[] = [];
  let lineNumber = 0;

  for (const line of lines) {
    lineNumber++;
    const trimmed = line.trim();

    if (trimmed === '') {
      continue;
    }

    // Skip header rows (heuristic: contains column names)
    if (isHeaderRow(trimmed)) {
      continue;
    }

    // Check if this looks like a new instrument row or continuation
    if (looksLikeNewRow(trimmed)) {
      // Process accumulated row if any
      if (currentRow.length > 0) {
        const rowText = currentRow.join(' ');
        const record = parseInstrumentRow(rowText, lineNumber);
        if (record) {
          parsed.push(record);
        } else {
          unparsed.push({
            rawText: rowText,
            reason: 'Failed to parse instrument row',
            lineNumber,
          });
        }
      }
      // Start new row
      currentRow = [trimmed];
    } else {
      // Continuation of previous row
      currentRow.push(trimmed);
    }
  }

  // Process final accumulated row
  if (currentRow.length > 0) {
    const rowText = currentRow.join(' ');
    const record = parseInstrumentRow(rowText, lineNumber);
    if (record) {
      parsed.push(record);
    } else {
      unparsed.push({
        rawText: rowText,
        reason: 'Failed to parse instrument row',
        lineNumber,
      });
    }
  }

  const totalRows = parsed.length + unparsed.length;
  const parseRate = totalRows > 0 ? parsed.length / totalRows : 0;

  return {
    parsed,
    unparsed,
    parseRate,
    totalRows,
  };
}

/**
 * Check if line is a header row
 */
function isHeaderRow(line: string): boolean {
  const headerPatterns = [
    /INSTRUMENT\s+TYPE/i,
    /GRANTOR/i,
    /GRANTEE/i,
    /BOOK.*PAGE/i,
    /INST.*DATE/i,
    /FILED.*DATE/i,
    /LEGAL/i,
    /^Page\s+\d+/i,
  ];

  return headerPatterns.some((pattern) => pattern.test(line));
}

/**
 * Check if line looks like start of new instrument row
 * Heuristic: starts with a known instrument type or date pattern
 */
function looksLikeNewRow(line: string): boolean {
  const instrumentTypePattern = /^(PATENT|DEED|D\/T|MINERAL\s+DEED|ROYALTY\s+DEED|OG\s+LEASE|O&G\s+LEASE|ASSIGNMENT|RELEASE|PROBATE|UNIT|POOLING)/i;
  const datePattern = /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/;

  return instrumentTypePattern.test(line) || datePattern.test(line);
}

/**
 * Parse a single instrument row into structured record
 * 
 * Expected format (with variations):
 * INSTRUMENT_TYPE BOOK PAGE INST# INST_DATE CONSIDERATION GRANTOR GRANTEE LEGAL FILED_DATE RELATED
 */
function parseInstrumentRow(rowText: string, lineNumber: number): InstrumentRecord | null {
  try {
    // This is a simplified parser - real implementation would need more sophisticated parsing
    // based on the actual column layout observed in the PDF

    const record: InstrumentRecord = {
      instrumentType: '',
      grantors: [],
      grantees: [],
      legal: { sections: [], block: undefined, subdivisions: [] },
      rawText: rowText,
    };

    // Extract instrument type (first token typically)
    const instrumentTypeMatch = rowText.match(/^([A-Z&\s\/]+?)(?:\s+\d+|\s+[A-Z])/);
    if (instrumentTypeMatch) {
      record.instrumentType = instrumentTypeMatch[1].trim();
    }

    // Extract book/page references
    const bookPageMatch = rowText.match(/(?:BOOK|BK|VOL)\s*(\d+)\s*(?:PAGE|PG|P)\s*(\d+)/i);
    if (bookPageMatch && bookPageMatch[1] && bookPageMatch[2]) {
      record.book = bookPageMatch[1];
      record.page = bookPageMatch[2];
    }

    // Extract instrument number
    const instNumMatch = rowText.match(/(?:INST|DOC|#)\s*[#:]?\s*(\d+[-\d]*)/i);
    if (instNumMatch && instNumMatch[1]) {
      record.instrumentNumber = instNumMatch[1];
    }

    // Extract dates
    const dates = extractDates(rowText);
    if (dates.length >= 1) {
      record.instrumentDate = dates[0];
    }
    if (dates.length >= 2) {
      record.filedDate = dates[1];
    }

    // Extract legal description
    record.legal = extractLegalDescription(rowText);

    // Extract grantors/grantees (this is complex, simplified here)
    const names = extractNames(rowText);
    if (names.length >= 2) {
      record.grantors = [names[0]];
      record.grantees = [names[1]];
    }

    // Must have at least instrument type and some identifiable content
    if (!record.instrumentType || record.instrumentType.length < 2) {
      return null;
    }

    return record;
  } catch (error) {
    return null;
  }
}

/**
 * Extract dates from row text
 */
function extractDates(text: string): Date[] {
  const dates: Date[] = [];
  const datePattern = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/g;
  let match;

  while ((match = datePattern.exec(text)) !== null) {
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    let year = parseInt(match[3], 10);

    // Handle 2-digit years
    if (year < 100) {
      year += year < 50 ? 2000 : 1900;
    }

    try {
      const date = new Date(year, month - 1, day);
      if (!isNaN(date.getTime())) {
        dates.push(date);
      }
    } catch {
      // Skip invalid dates
    }
  }

  return dates;
}

/**
 * Extract legal description components
 */
function extractLegalDescription(text: string): LegalDescription {
  const legal: LegalDescription = {
    sections: [],
    block: undefined,
    subdivisions: [],
  };

  // Extract section numbers
  const sectionMatch = text.match(/(?:SECTION|SEC|S)\s*(\d+)/gi);
  if (sectionMatch) {
    for (const match of sectionMatch) {
      const num = match.match(/\d+/);
      if (num && num[0]) {
        legal.sections.push(num[0]);
      }
    }
  }

  // Extract block (handle patterns like "BLK B-5", "BLOCK B5", "B-5")
  const blockMatch = text.match(/(?:BLOCK|BLK)\s+([A-Z0-9\-]+)/i);
  if (blockMatch && blockMatch[1]) {
    legal.block = blockMatch[1];
  } else {
    // Try standalone block pattern in context of section
    const standaloneBlockMatch = text.match(/\b(B-?\d+)\b/i);
    if (standaloneBlockMatch && standaloneBlockMatch[1]) {
      legal.block = standaloneBlockMatch[1];
    }
  }

  // Extract subdivisions (SE, W2, S2SW4, ALL, etc.)
  const subdivisionPatterns = [
    /\b(ALL|ENTIRE)\b/gi,
    /\b([NESW])\/?\s*([1-4])\b/gi,  // N/2, S2, etc.
    /\b([NESW]{2,4})\b/gi,           // SE, NW, S2SW4, etc.
  ];

  for (const pattern of subdivisionPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      legal.subdivisions.push(...matches.map((m) => m.trim().toUpperCase()));
    }
  }

  // Extract survey reference
  const surveyMatch = text.match(/(?:PSL|PUBLIC\s+SCHOOL\s+LAND|SURVEY)/i);
  if (surveyMatch) {
    legal.survey = surveyMatch[0];
  }

  return legal;
}

/**
 * Extract names (simplified - real parser would need better NER)
 */
function extractNames(text: string): string[] {
  const names: string[] = [];

  // This is a placeholder - real implementation would need sophisticated name extraction
  // For now, extract capitalized word sequences
  const namePattern = /\b([A-Z][A-Z\s\.]+(?:JR|SR|III|IV)?)\b/g;
  let match;

  while ((match = namePattern.exec(text)) !== null) {
    if (!match[1]) continue;
    const name = match[1].trim();
    if (name.length > 3 && !isCommonWord(name)) {
      names.push(name);
    }
  }

  return names;
}

/**
 * Filter out common non-name words
 */
function isCommonWord(word: string): boolean {
  const commonWords = [
    'SECTION', 'BLOCK', 'PAGE', 'BOOK', 'INST', 'DATE', 'FILED', 'CONSIDERATION',
    'GRANTOR', 'GRANTEE', 'LEGAL', 'RELATED', 'PUBLIC', 'SCHOOL', 'LAND',
    'DEED', 'LEASE', 'ASSIGNMENT', 'RELEASE', 'PATENT', 'PROBATE', 'UNIT',
    'POOLING', 'MINERAL', 'ROYALTY', 'OIL', 'GAS', 'SURVEY', 'COUNTY',
    'TEXAS', 'ALL', 'ENTIRE', 'NORTH', 'SOUTH', 'EAST', 'WEST'
  ];

  return commonWords.includes(word.toUpperCase());
}
