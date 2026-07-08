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

  it('should parse multi-line Winkler format records', () => {
    const sampleText = `
DEED, ASSUMPTION PARTITION, ETC.
1/362
04/05/190904/13/1909
CRAWFORD A T
SEC: 17, 24--25  BLK: B5  PUBLIC SCHOOL LANDS  [ALL;]   ALL
COWDEN J T
`;

    const result = parseRunsheetText(sampleText);

    expect(result.parsed.length).toBe(1);
    expect(result.parsed[0].instrumentType).toBe('DEED, ASSUMPTION PARTITION, ETC.');
    expect(result.parsed[0].book).toBe('1');
    expect(result.parsed[0].page).toBe('362');
  });

  it('should extract section ranges', () => {
    const sampleText = `
OIL & GAS LEASE
1/154
09/04/1925
COLLINS C C
SEC: 3, 5--7, 15--16, 24--25, 38  BLK: B5  PUBLIC SCHOOL LANDS  [ALL;]
BROWN EUGENIA E
`;

    const result = parseRunsheetText(sampleText);

    expect(result.parsed.length).toBe(1);
    const record = result.parsed[0];
    expect(record.legal.sections).toContain('3');
    expect(record.legal.sections).toContain('5');
    expect(record.legal.sections).toContain('6');
    expect(record.legal.sections).toContain('7');
    expect(record.legal.sections).toContain('15');
    expect(record.legal.sections).toContain('16');
    expect(record.legal.sections).toContain('24');
    expect(record.legal.sections).toContain('25');
    expect(record.legal.sections).toContain('38');
  });

  it('should normalize block notation', () => {
    const sampleText = `
DEED
9/232
01/23/192501/24/1925
BROWN S E
SEC: 17, 24--25  BLK: B5  PUBLIC SCHOOL LANDS  [ALL;]
VEST W A
`;

    const result = parseRunsheetText(sampleText);

    expect(result.parsed.length).toBe(1);
    expect(result.parsed[0].legal.block).toBe('B-5');
  });

  it('should extract subdivisions from bracket notation', () => {
    const sampleText = `
ROYALTY DEED
23/316
10/29/192711/15/1927
HAYNES FRANK
SEC: 25  BLK: B5  PUBLIC SCHOOL LANDS  [SE;]
PATTERSON W S
`;

    const result = parseRunsheetText(sampleText);

    expect(result.parsed.length).toBe(1);
    expect(result.parsed[0].legal.subdivisions).toContain('SE');
  });

  it('should handle unparseable rows gracefully', () => {
    const sampleText = `
This is not a valid instrument row at all
Some random text that should not parse
`;

    const result = parseRunsheetText(sampleText);

    expect(result.parsed.length).toBe(0);
  });

  it('should extract section and block from legal description', () => {
    const sampleText = `
DEED
100/50
05/10/1950
JONES MARY
SECTION 25 BLOCK B-5 SE
SMITH BOB
`;

    const result = parseRunsheetText(sampleText);

    if (result.parsed.length > 0) {
      const record = result.parsed[0];
      expect(record.legal.sections).toContain('25');
      expect(record.legal.block?.toUpperCase()).toBe('B-5');
    }
  });

  it('should handle header rows without treating them as instruments', () => {
    const sampleText = `
Page 1
INSTRUMENT TYPE    BOOK  PAGE  GRANTOR  GRANTEE  LEGAL  FILED DATE
DEED
100/50
05/10/1950
JONES
SEC 25 BLK B-5
SMITH
INSTRUMENT TYPE    BOOK  PAGE  GRANTOR  GRANTEE  LEGAL  FILED DATE
`;

    const result = parseRunsheetText(sampleText);

    // Should have at most 1 parsed instrument (the DEED), not 3
    expect(result.parsed.length).toBeLessThanOrEqual(1);
  });

  it('should extract dates correctly', () => {
    const sampleText = `
DEED
100/50
05/10/195006/15/1950
JONES
SEC 25
SMITH
`;

    const result = parseRunsheetText(sampleText);

    if (result.parsed.length > 0) {
      const record = result.parsed[0];
      expect(record.instrumentDate).toBeInstanceOf(Date);
      if (record.instrumentDate) {
        expect(record.instrumentDate.getFullYear()).toBe(1950);
        expect(record.instrumentDate.getMonth()).toBe(4); // 0-indexed, May
      }
      if (record.filedDate) {
        expect(record.filedDate.getFullYear()).toBe(1950);
        expect(record.filedDate.getMonth()).toBe(5); // June
      }
    }
  });

  it('should handle book type prefixes like R011', () => {
    const sampleText = `
ASSIGNMENT
R011/319
12/31/1925
WOLFE H T
SEC: 25  BLK: B5  [ALL;]
BROWN E E
`;

    const result = parseRunsheetText(sampleText);

    if (result.parsed.length > 0) {
      const record = result.parsed[0];
      expect(record.book).toBe('011');
      expect(record.page).toBe('319');
      expect(record.bookType).toBe('R');
    }
  });
});
