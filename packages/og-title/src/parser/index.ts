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
 * 
 * Multi-line record structure:
 * - Line 1: INSTRUMENT TYPE
 * - Line 2: BOOK/PAGE (e.g. "1/362" or "R011/319")
 * - Line 3: INST DATE + FILED DATE (may be concatenated)
 * - Line 4+: GRANTOR, LEGAL (wraps), GRANTEE interleaved
 */
export function parseRunsheetText(text: string): RunsheetParseResult {
  const lines = text.split('\n');
  const parsed: InstrumentRecord[] = [];
  const unparsed: UnparsedRow[] = [];

  let i = 0;
  let recordStartLine = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    i++;

    if (line === '' || isHeaderRow(line)) {
      continue;
    }

    // Check if this line starts a new record (instrument type vocabulary)
    const instrumentType = matchInstrumentType(line);
    if (!instrumentType) {
      continue;
    }

    // Found potential instrument type, accumulate lines for this record
    recordStartLine = i;
    const recordLines: string[] = [line];

    // Check if this might be a single-line format (has dates or book/page on same line)
    const hasDateOnSameLine = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(line);
    const hasBookPageOnSameLine = /\d+\s+\d+/.test(line);
    
    if (hasDateOnSameLine || hasBookPageOnSameLine) {
      // Single-line format - parse immediately
      const record = parseSingleLineRecord(line, recordStartLine);
      if (record) {
        parsed.push(record);
      } else {
        unparsed.push({
          rawText: line,
          reason: 'Failed to parse single-line record',
          lineNumber: recordStartLine,
        });
      }
      continue;
    }

    // Multi-line format - collect lines until we hit the next instrument type or end
    while (i < lines.length) {
      const nextLine = lines[i].trim();
      if (nextLine === '') {
        i++;
        continue;
      }
      if (isHeaderRow(nextLine)) {
        i++;
        continue;
      }
      // Check if this starts a new record
      if (matchInstrumentType(nextLine)) {
        break;
      }
      recordLines.push(nextLine);
      i++;
    }

    // Now parse the accumulated record lines
    const record = parseMultiLineRecord(recordLines, recordStartLine);
    if (record) {
      parsed.push(record);
    } else {
      unparsed.push({
        rawText: recordLines.join('\n'),
        reason: 'Failed to parse multi-line record',
        lineNumber: recordStartLine,
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
 * Instrument type vocabulary observed in Winkler County index
 */
const INSTRUMENT_TYPES = [
  'PATENT',
  'DEED',
  'WARRANTY DEED',
  'QUIT CLAIM DEED',
  'SPECIAL WARRANTY DEED',
  'DEED, ASSUMPTION PARTITION, ETC.',
  'D/T',
  'DEED OF TRUST',
  'MINERAL DEED',
  'ROYALTY DEED',
  'OG LEASE',
  'OIL & GAS LEASE',
  'O&G LEASE',
  'OIL AND GAS LEASE',
  'ASSIGNMENT',
  'ASSIGNMENT OF OIL & GAS LEASE',
  'RELEASE',
  'PARTIAL RELEASE',
  'PROBATE',
  'AFFIDAVIT',
  'CERTIFICATE',
  'UNIT',
  'UNIT DESIGNATION',
  'POOLING',
  'DECLARATION',
  'RATIFICATION',
];

/**
 * Check if line matches an instrument type from vocabulary
 * Returns the matched type or null
 */
function matchInstrumentType(line: string): string | null {
  const normalized = line.trim().toUpperCase();
  
  for (const type of INSTRUMENT_TYPES) {
    if (normalized === type || normalized.startsWith(type + ' ')) {
      return type;
    }
  }
  
  return null;
}

/**
 * Parse a single-line instrument record (fallback format)
 */
function parseSingleLineRecord(line: string, startLine: number): InstrumentRecord | null {
  try {
    const record: InstrumentRecord = {
      instrumentType: '',
      grantors: [],
      grantees: [],
      legal: { sections: [], block: undefined, subdivisions: [] },
      rawText: line,
    };

    // Extract instrument type
    const instrumentType = matchInstrumentType(line);
    if (!instrumentType) {
      return null;
    }
    record.instrumentType = instrumentType;

    // Extract dates
    const dates = extractDates(line);
    if (dates.length >= 1) {
      record.instrumentDate = dates[0];
    }
    if (dates.length >= 2) {
      record.filedDate = dates[1];
    }

    // Extract legal description
    record.legal = extractLegalDescription(line);

    // Extract names (simplified for single-line)
    const names = extractNames(line);
    if (names.length >= 2) {
      record.grantors = [names[0]];
      record.grantees = [names[1]];
    } else if (names.length === 1) {
      record.grantors = [names[0]];
    }

    return record;
  } catch (error) {
    return null;
  }
}

/**
 * Parse a multi-line instrument record
 * 
 * Expected structure:
 * Line 0: INSTRUMENT TYPE
 * Line 1: BOOK/PAGE (e.g., "1/362", "R011/319")
 * Line 2: Dates (INST DATE + FILED DATE, often concatenated)
 * Line 3+: GRANTOR, LEGAL, GRANTEE interleaved and wrapped
 */
function parseMultiLineRecord(lines: string[], startLine: number): InstrumentRecord | null {
  if (lines.length < 2) {
    return null;
  }

  try {
    const record: InstrumentRecord = {
      instrumentType: '',
      grantors: [],
      grantees: [],
      legal: { sections: [], block: undefined, subdivisions: [] },
      rawText: lines.join('\n'),
    };

    let lineIdx = 0;

    // Line 0: Instrument type (may have consideration on same line)
    const instrumentType = matchInstrumentType(lines[lineIdx]);
    if (!instrumentType) {
      return null;
    }
    record.instrumentType = instrumentType;

    // Extract consideration if present
    const considerationMatch = lines[lineIdx].match(/\$[\d,]+(\.\d+)?/);
    if (considerationMatch) {
      record.consideration = considerationMatch[0];
    }

    lineIdx++;
    if (lineIdx >= lines.length) {
      return null;
    }

    // Check if next line is a book type (TRANSFER, LRI, etc.)
    const bookTypePatterns = ['TRANSFER', 'LRI', 'RECORDING', 'FILM', 'FILE'];
    if (bookTypePatterns.some(pattern => lines[lineIdx].trim().toUpperCase() === pattern)) {
      record.bookType = lines[lineIdx].trim();
      lineIdx++;
      if (lineIdx >= lines.length) {
        return null;
      }
    }

    // Next line should be book/page pattern like "1/362" or "R011/319"
    const bookPageMatch = lines[lineIdx].match(/^([A-Z]?\d+)\/(\d+)/);
    if (bookPageMatch) {
      const bookRef = bookPageMatch[1];
      record.page = bookPageMatch[2];
      // Extract book number (strip letter prefix if present)
      const bookNum = bookRef.match(/\d+/);
      if (bookNum) {
        record.book = bookNum[0];
      }
      // Check for book type prefix (e.g., "R" in "R011")
      const bookTypePrefix = bookRef.match(/^([A-Z])/);
      if (bookTypePrefix && !record.bookType) {
        record.bookType = bookTypePrefix[1];
      }
      lineIdx++;
    } else {
      // No book/page found - this might be a malformed record
      // Try to extract what we can from remaining lines
      const remainingText = lines.slice(lineIdx).join(' ');
      record.legal = extractLegalDescription(remainingText);
      const names = extractNames(remainingText);
      if (names.length > 0) {
        record.grantors = [names[0]];
        if (names.length > 1) {
          record.grantees = [names[1]];
        }
      }
      // Return the record even without book/page
      return record;
    }

    if (lineIdx >= lines.length) {
      return record; // Minimal record with just type and book/page
    }

    // Check if next line is instrument/doc number (starts with B or just numbers)
    if (lines[lineIdx].match(/^[B]?\d+$/)) {
      record.instrumentNumber = lines[lineIdx].trim();
      lineIdx++;
    }

    if (lineIdx >= lines.length) {
      return record;
    }

    // Next line(s): Dates (may be on one or two lines)
    const dates = extractDates(lines[lineIdx]);
    if (dates.length >= 1) {
      record.instrumentDate = dates[0];
    }
    if (dates.length >= 2) {
      record.filedDate = dates[1];
    } else if (dates.length === 1 && lineIdx + 1 < lines.length) {
      // Check next line for second date
      const moreDates = extractDates(lines[lineIdx + 1]);
      if (moreDates.length > 0) {
        record.filedDate = moreDates[0];
        lineIdx++;
      }
    }
    lineIdx++;

    if (lineIdx >= lines.length) {
      return record;
    }

    // Remaining lines: GRANTOR, LEGAL, GRANTEE interleaved and wrapped
    const remainingText = lines.slice(lineIdx).join(' ');

    // Extract legal description (look for SEC: ... BLK: ... pattern)
    record.legal = extractLegalDescription(remainingText);

    // Extract names around the legal description
    const names = extractNamesFromRecord(lines.slice(lineIdx), record.legal);
    record.grantors = names.grantors;
    record.grantees = names.grantees;

    // Must have at least instrument type to be valid
    if (!record.instrumentType) {
      return null;
    }

    return record;
  } catch (error) {
    return null;
  }
}

/**
 * Extract grantor and grantee names from record lines
 * Strategy: Names appear before and after the LEGAL section marker
 */
function extractNamesFromRecord(
  lines: string[],
  legal: LegalDescription
): { grantors: string[]; grantees: string[] } {
  const fullText = lines.join(' ');
  const grantors: string[] = [];
  const grantees: string[] = [];

  // Find where the legal description starts (SEC: or SECTION)
  const legalStartMatch = fullText.match(/\b(SEC:|SECTION|S:)\s*\d/i);
  
  if (legalStartMatch && legalStartMatch.index !== undefined) {
    // Text before legal = grantor area
    const beforeLegal = fullText.substring(0, legalStartMatch.index).trim();
    // Text after legal end (look for bracket pattern end)
    const legalEndMatch = fullText.match(/\[[^\]]*\]|PUBLIC\s+SCHOOL\s+LANDS/i);
    let afterLegal = '';
    if (legalEndMatch && legalEndMatch.index !== undefined) {
      const endPos = legalEndMatch.index + legalEndMatch[0].length;
      afterLegal = fullText.substring(endPos).trim();
    }

    // Extract names from before legal (grantors)
    const grantorNames = extractNames(beforeLegal);
    if (grantorNames.length > 0) {
      grantors.push(...grantorNames.slice(0, 3)); // Take up to 3 names
    }

    // Extract names from after legal (grantees)
    const granteeNames = extractNames(afterLegal);
    if (granteeNames.length > 0) {
      grantees.push(...granteeNames.slice(0, 3)); // Take up to 3 names
    }
  } else {
    // No legal found, try to extract any names
    const allNames = extractNames(fullText);
    if (allNames.length >= 2) {
      grantors.push(allNames[0]);
      grantees.push(allNames[1]);
    } else if (allNames.length === 1) {
      grantors.push(allNames[0]);
    }
  }

  return { grantors, grantees };
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
 * Handles section ranges like "SEC: 17, 24--25" or "SEC: 3, 5--7, 15--16, 24--25, 38"
 */
function extractLegalDescription(text: string): LegalDescription {
  const legal: LegalDescription = {
    sections: [],
    block: undefined,
    subdivisions: [],
  };

  // Extract section numbers with range support
  // Pattern: SEC: 17, 24--25, 38 or SECTION 17 or SEC 25
  const sectionMatch = text.match(/(?:SECTION|SEC|S):\s*([\d\s,\-]+?)(?=\s+BLK|BLOCK|$)/i);
  if (sectionMatch && sectionMatch[1]) {
    const sectionText = sectionMatch[1];
    // Parse ranges and individual sections
    const parts = sectionText.split(',').map(p => p.trim());
    for (const part of parts) {
      if (part.includes('--') || part.includes('-')) {
        // Range like "24--25" or "5-7"
        const rangeMatch = part.match(/(\d+)\s*-+\s*(\d+)/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          for (let sec = start; sec <= end; sec++) {
            legal.sections.push(sec.toString());
          }
        }
      } else {
        // Individual section
        const num = part.match(/\d+/);
        if (num && num[0]) {
          legal.sections.push(num[0]);
        }
      }
    }
  } else {
    // Fallback: try simple section pattern without colon
    const simpleSectionMatch = text.match(/(?:SECTION|SEC|S)\s+(\d+)/gi);
    if (simpleSectionMatch) {
      for (const match of simpleSectionMatch) {
        const num = match.match(/\d+/);
        if (num && num[0]) {
          if (!legal.sections.includes(num[0])) {
            legal.sections.push(num[0]);
          }
        }
      }
    }
  }

  // Extract block (handle patterns like "BLK: B5", "BLOCK B-5", "BLK B5")
  const blockMatch = text.match(/(?:BLOCK|BLK):\s*([A-Z]?\d+)|(?:BLOCK|BLK)\s+([A-Z]?-?\d+)/i);
  if (blockMatch) {
    const blockValue = blockMatch[1] || blockMatch[2];
    if (blockValue) {
      // Normalize: "B5" -> "B-5", but keep "B-5" as is
      let normalized = blockValue.toUpperCase();
      if (/^[A-Z]\d+$/.test(normalized)) {
        // Insert hyphen: B5 -> B-5
        normalized = normalized[0] + '-' + normalized.substring(1);
      }
      legal.block = normalized;
    }
  }

  // Extract subdivisions from bracket notation: [ALL;], [SE;], [S2SW4;], etc.
  const bracketSubdivs = text.match(/\[([^\]]+)\]/g);
  if (bracketSubdivs) {
    for (const bracket of bracketSubdivs) {
      // Remove brackets and semicolons, split by space/comma
      const content = bracket.replace(/[\[\];]/g, '').trim();
      const parts = content.split(/[\s,]+/).filter(p => p.length > 0);
      for (const part of parts) {
        const normalized = part.toUpperCase();
        // Filter out non-subdivision terms
        if (normalized !== 'ALL' && !isSubdivisionToken(normalized)) {
          continue;
        }
        if (!legal.subdivisions.includes(normalized)) {
          legal.subdivisions.push(normalized);
        }
      }
    }
  }

  // Also extract unbracke ted subdivisions (less common but possible)
  const subdivisionPatterns = [
    /\b(ALL|ENTIRE)\b/gi,
    /\b([NESW])\/?\s*([2-4])\b/gi,  // N/2, S2, etc.
    /\b([NESW]{2}[2-4]?)\b/gi,       // SE, NW, S2SW4, etc.
  ];

  for (const pattern of subdivisionPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        const normalized = m.trim().toUpperCase().replace(/\s/g, '').replace(/\//g, '');
        if (isSubdivisionToken(normalized) && !legal.subdivisions.includes(normalized)) {
          legal.subdivisions.push(normalized);
        }
      }
    }
  }

  // Extract survey reference
  const surveyMatch = text.match(/(?:PSL|PUBLIC\s+SCHOOL\s+LAND)/i);
  if (surveyMatch) {
    legal.survey = surveyMatch[0];
  }

  return legal;
}

/**
 * Check if token is a valid subdivision (not a common word)
 */
function isSubdivisionToken(token: string): boolean {
  const valid = [
    'ALL', 'ENTIRE',
    'N', 'S', 'E', 'W',
    'NE', 'NW', 'SE', 'SW',
    'N2', 'S2', 'E2', 'W2',
    'N4', 'S4', 'E4', 'W4',
  ];
  
  // Check exact match
  if (valid.includes(token)) {
    return true;
  }
  
  // Check compound patterns like S2SW4, N2NE4, etc.
  if (/^[NESW][2-4][NESW]{2}[2-4]?$/.test(token)) {
    return true;
  }
  
  return false;
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
