/**
 * Chain assembly tests
 */

import { describe, it, expect } from 'vitest';
import { assembleChain } from '../chain/assembly.js';
import type { ScopedInstrument } from '../types.js';

describe('Chain Assembly', () => {
  it('should order instruments by date', () => {
    const instruments: ScopedInstrument[] = [
      {
        instrumentType: 'DEED',
        grantors: ['B'],
        grantees: ['C'],
        legal: { sections: ['25'], block: 'B-5', subdivisions: ['ALL'] },
        rawText: 'test',
        intersection: 'certain',
        scopingReason: 'test',
        instrumentDate: new Date('2010-01-01'),
      },
      {
        instrumentType: 'PATENT',
        grantors: ['STATE'],
        grantees: ['A'],
        legal: { sections: ['25'], block: 'B-5', subdivisions: ['ALL'] },
        rawText: 'test',
        intersection: 'certain',
        scopingReason: 'test',
        instrumentDate: new Date('1900-01-01'),
      },
      {
        instrumentType: 'DEED',
        grantors: ['A'],
        grantees: ['B'],
        legal: { sections: ['25'], block: 'B-5', subdivisions: ['ALL'] },
        rawText: 'test',
        intersection: 'certain',
        scopingReason: 'test',
        instrumentDate: new Date('1950-01-01'),
      },
    ];

    const chain = assembleChain(instruments);

    expect(chain.instruments[0].instrumentType).toBe('PATENT');
    expect(chain.instruments[1].instrumentType).toBe('DEED');
    expect(chain.instruments[1].grantors[0]).toBe('A');
    expect(chain.instruments[2].instrumentType).toBe('DEED');
    expect(chain.instruments[2].grantors[0]).toBe('B');
  });

  it('should classify instrument types correctly', () => {
    const instruments: ScopedInstrument[] = [
      {
        instrumentType: 'OG LEASE',
        grantors: ['SMITH'],
        grantees: ['ACME OIL'],
        legal: { sections: ['25'], block: 'B-5', subdivisions: ['ALL'] },
        rawText: 'test',
        intersection: 'certain',
        scopingReason: 'test',
      },
      {
        instrumentType: 'ASSIGNMENT',
        grantors: ['ACME OIL'],
        grantees: ['XYZ ENERGY'],
        legal: { sections: ['25'], block: 'B-5', subdivisions: ['ALL'] },
        rawText: 'test',
        intersection: 'certain',
        scopingReason: 'test',
      },
    ];

    const chain = assembleChain(instruments);

    expect(chain.instruments[0].typeFamily).toBe('oil-gas-lease');
    expect(chain.instruments[1].typeFamily).toBe('assignment');
  });

  it('should identify gap when no patent exists', () => {
    const instruments: ScopedInstrument[] = [
      {
        instrumentType: 'DEED',
        grantors: ['SMITH'],
        grantees: ['JONES'],
        legal: { sections: ['25'], block: 'B-5', subdivisions: ['ALL'] },
        rawText: 'test',
        intersection: 'certain',
        scopingReason: 'test',
        instrumentDate: new Date('1950-01-01'),
      },
    ];

    const chain = assembleChain(instruments);

    expect(chain.gaps.length).toBeGreaterThan(0);
    expect(chain.gaps.some((g) => g.includes('patent'))).toBe(true);
  });

  it('should compute working interest from lease', () => {
    const instruments: ScopedInstrument[] = [
      {
        instrumentType: 'OG LEASE',
        grantors: ['LANDOWNER'],
        grantees: ['OIL COMPANY'],
        legal: { sections: ['25'], block: 'B-5', subdivisions: ['ALL'] },
        rawText: 'test',
        intersection: 'certain',
        scopingReason: 'test',
        instrumentDate: new Date('2010-01-01'),
      },
    ];

    const chain = assembleChain(instruments);

    expect(chain.workingInterest.length).toBeGreaterThan(0);
    expect(chain.workingInterest[0].ownerName).toBe('OIL COMPANY');
  });
});
