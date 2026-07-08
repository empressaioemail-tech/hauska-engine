/**
 * Tract scoping tests
 */

import { describe, it, expect } from 'vitest';
import { scopeInstrumentsToTract } from '../chain/scoping.js';
import type { InstrumentRecord } from '../types.js';

describe('Tract Scoping', () => {
  const target = {
    section: '25',
    block: 'B-5',
    subdivision: 'S2SW4', // S/2 of SW/4
    county: 'Winkler',
  };

  it('should include instruments covering ALL', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-5',
          subdivisions: ['ALL'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(1);
    expect(scoped[0].intersection).toBe('certain');
  });

  it('should include instruments covering SW quarter', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-5',
          subdivisions: ['SW'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(1);
    expect(scoped[0].intersection).toBe('certain');
  });

  it('should include instruments covering SW4 quarter', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-5',
          subdivisions: ['SW4'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(1);
    expect(scoped[0].intersection).toBe('certain');
  });

  it('should include instruments covering S2 (south half)', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-5',
          subdivisions: ['S2'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(1);
    expect(scoped[0].intersection).toBe('certain');
  });

  it('should include instruments covering W2 (west half, contains SW)', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-5',
          subdivisions: ['W2'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(1);
    expect(scoped[0].intersection).toBe('certain');
  });

  it('should exclude instruments covering SE (no overlap with S2SW4)', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-5',
          subdivisions: ['SE'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(0);
  });

  it('should exclude instruments covering NE (no overlap)', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-5',
          subdivisions: ['NE'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(0);
  });

  it('should exclude instruments covering E2 (no overlap)', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-5',
          subdivisions: ['E2'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(0);
  });

  it('should handle section ranges like "24--25"', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['24', '25'], // Expanded from range
          block: 'B-5',
          subdivisions: ['ALL'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(1);
    expect(scoped[0].intersection).toBe('certain');
  });

  it('should handle section ranges like "15--16, 25--27"', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['15', '16', '25', '26', '27'], // Expanded from ranges
          block: 'B-5',
          subdivisions: ['ALL'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(1);
    expect(scoped[0].intersection).toBe('certain');
  });

  it('should normalize block matching (B5 vs B-5)', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B5', // No hyphen
          subdivisions: ['ALL'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(1);
    expect(scoped[0].intersection).toBe('certain');
  });

  it('should exclude instruments from wrong section', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['24'], // Different section
          block: 'B-5',
          subdivisions: ['ALL'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(0);
  });

  it('should exclude instruments from wrong block', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-6', // Different block
          subdivisions: ['ALL'],
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(0);
  });

  it('should handle exact subdivision match', () => {
    const instruments: InstrumentRecord[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: {
          sections: ['25'],
          block: 'B-5',
          subdivisions: ['S2SW4'], // Exact match
        },
        rawText: 'test',
      },
    ];

    const scoped = scopeInstrumentsToTract(instruments, target);

    expect(scoped.length).toBe(1);
    expect(scoped[0].intersection).toBe('certain');
  });
});
