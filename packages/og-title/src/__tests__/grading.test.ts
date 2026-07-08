/**
 * Grading harness tests
 */

import { describe, it, expect } from 'vitest';
import { compareWorkingInterest } from '../grading/comparator.js';
import { normalizeOwnerName } from '../grading/wi-report-parser.js';
import type { WorkingInterestEntry } from '../types.js';

describe('Grading Harness', () => {
  it('should match owners with exact names and interests', () => {
    const methodWI: WorkingInterestEntry[] = [
      { ownerName: 'ACME OIL CO', interest: 0.5 },
      { ownerName: 'XYZ ENERGY', interest: 0.5 },
    ];

    const reportWI: WorkingInterestEntry[] = [
      { ownerName: 'ACME OIL CO', interest: 0.5 },
      { ownerName: 'XYZ ENERGY', interest: 0.5 },
    ];

    const result = compareWorkingInterest(methodWI, reportWI);

    expect(result.matched.length).toBe(2);
    expect(result.missed.length).toBe(0);
    expect(result.spurious.length).toBe(0);
  });

  it('should detect interest mismatches', () => {
    const methodWI: WorkingInterestEntry[] = [
      { ownerName: 'ACME OIL CO', interest: 0.6 }, // Wrong interest
    ];

    const reportWI: WorkingInterestEntry[] = [
      { ownerName: 'ACME OIL CO', interest: 0.5 },
    ];

    const result = compareWorkingInterest(methodWI, reportWI);

    expect(result.matched.length).toBe(1);
    expect(Math.abs(result.matched[0].delta)).toBeCloseTo(0.1, 2);
  });

  it('should detect missed owners', () => {
    const methodWI: WorkingInterestEntry[] = [
      { ownerName: 'ACME OIL CO', interest: 1.0 },
    ];

    const reportWI: WorkingInterestEntry[] = [
      { ownerName: 'ACME OIL CO', interest: 0.5 },
      { ownerName: 'MISSING OWNER', interest: 0.5 },
    ];

    const result = compareWorkingInterest(methodWI, reportWI);

    expect(result.missed.length).toBe(1);
    expect(result.missed[0].owner).toBe('MISSING OWNER');
  });

  it('should detect spurious owners', () => {
    const methodWI: WorkingInterestEntry[] = [
      { ownerName: 'ACME OIL CO', interest: 0.5 },
      { ownerName: 'SPURIOUS OWNER', interest: 0.5 },
    ];

    const reportWI: WorkingInterestEntry[] = [
      { ownerName: 'ACME OIL CO', interest: 0.5 },
    ];

    const result = compareWorkingInterest(methodWI, reportWI);

    expect(result.spurious.length).toBe(1);
    expect(result.spurious[0].owner).toBe('SPURIOUS OWNER');
  });

  it('should normalize owner names for comparison', () => {
    expect(normalizeOwnerName('Smith, John Jr.')).toBe(normalizeOwnerName('SMITH JOHN'));
    expect(normalizeOwnerName('Acme Oil Co., LLC')).toBe(normalizeOwnerName('ACME OIL CO'));
  });

  it('should handle empty inputs gracefully', () => {
    const result = compareWorkingInterest([], []);

    expect(result.matched.length).toBe(0);
    expect(result.missed.length).toBe(0);
    expect(result.spurious.length).toBe(0);
  });
});
