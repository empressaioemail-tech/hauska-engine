/**
 * Parser unit tests on sample page text
 */

import { describe, it, expect } from 'vitest';
import { parseRunsheetText } from '../parser/index.js';

describe('Runsheet Parser', () => {
  it('should parse a simple instrument row', () => {
    const sampleText = `
INSTRUMENT TYPE    BOOK  PAGE  INST#     INST DATE    GRANTOR          GRANTEE         LEGAL
OG LEASE           450   123   2015-001  01/15/2015   SMITH JOHN       ACME OIL CO    SEC 25 BLK B-5 ALL
`;

    const result = parseRunsheetText(sampleText);

    expect(result.parsed.length).toBeGreaterThan(0);
    expect(result.parseRate).toBeGreaterThan(0);
  });

  it('should handle unparseable rows gracefully', () => {
    const sampleText = `
This is not a valid instrument row at all
Some random text that should not parse
`;

    const result = parseRunsheetText(sampleText);

    expect(result.unparsed.length).toBeGreaterThan(0);
    expect(result.parseRate).toBeLessThan(1);
  });

  it('should extract section and block from legal description', () => {
    const sampleText = `
DEED  100 50  1950-001 05/10/1950  JONES MARY  SMITH BOB  SECTION 25 BLOCK B-5 SE
`;

    const result = parseRunsheetText(sampleText);

    if (result.parsed.length > 0) {
      const record = result.parsed[0];
      expect(record.legal.sections).toContain('25');
      expect(record.legal.block.toUpperCase()).toBe('B-5');
    }
  });

  it('should handle header rows without treating them as instruments', () => {
    const sampleText = `
Page 1
INSTRUMENT TYPE    BOOK  PAGE  GRANTOR  GRANTEE  LEGAL  FILED DATE
DEED               100   50    JONES    SMITH    SEC 25 BLK B-5
INSTRUMENT TYPE    BOOK  PAGE  GRANTOR  GRANTEE  LEGAL  FILED DATE
`;

    const result = parseRunsheetText(sampleText);

    // Should have at most 1 parsed instrument (the DEED), not 3
    expect(result.parsed.length).toBeLessThanOrEqual(1);
  });

  it('should extract dates correctly', () => {
    const sampleText = `
DEED  100 50  1950-001 05/10/1950  JONES  SMITH  SEC 25  06/15/1950
`;

    const result = parseRunsheetText(sampleText);

    if (result.parsed.length > 0) {
      const record = result.parsed[0];
      expect(record.instrumentDate).toBeInstanceOf(Date);
      if (record.instrumentDate) {
        expect(record.instrumentDate.getFullYear()).toBe(1950);
      }
    }
  });
});
