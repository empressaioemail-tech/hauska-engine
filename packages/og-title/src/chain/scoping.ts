/**
 * Tract scoping logic - filter instruments that may touch the target tract
 */

import type {
  InstrumentRecord,
  ScopedInstrument,
  IntersectionConfidence,
  LegalDescription,
} from '../types.js';

/**
 * Target tract specification
 */
export interface TargetTract {
  section: string;
  block: string;
  subdivision: string; // e.g., "S2SW4" for S/2 SW/4
  county: string;
}

/**
 * Scope instruments to those that may touch the target tract
 */
export function scopeInstrumentsToTract(
  instruments: InstrumentRecord[],
  target: TargetTract
): ScopedInstrument[] {
  return instruments
    .map((inst) => {
      const intersection = checkIntersection(inst.legal, target);
      if (intersection) {
        return {
          ...inst,
          intersection: intersection.confidence,
          scopingReason: intersection.reason,
        };
      }
      return null;
    })
    .filter((inst): inst is ScopedInstrument => inst !== null);
}

interface IntersectionResult {
  confidence: IntersectionConfidence;
  reason: string;
}

/**
 * Check if legal description intersects with target tract
 */
function checkIntersection(
  legal: LegalDescription,
  target: TargetTract
): IntersectionResult | null {
  // Check section match (including section ranges which are now expanded)
  const sectionMatches = legal.sections.includes(target.section);
  if (!sectionMatches) {
    return null;
  }

  // Check block match (normalize for comparison: B5, B-5, b5, b-5 all match)
  if (!legal.block) {
    return null;
  }
  const normalizeBlock = (b: string) => b.toUpperCase().replace(/-/g, '');
  const blockMatches = normalizeBlock(legal.block) === normalizeBlock(target.block);
  if (!blockMatches) {
    return null;
  }

  // Now check subdivision intersection
  // Target is S2SW4 = S/2 of SW/4
  
  // If instrument covers ALL, it definitely includes target
  if (legal.subdivisions.some((s) => s === 'ALL' || s === 'ENTIRE')) {
    return {
      confidence: 'certain',
      reason: 'Instrument covers entire section',
    };
  }

  // If no subdivisions specified but section/block match, include as possible
  if (legal.subdivisions.length === 0) {
    return {
      confidence: 'possible',
      reason: 'Section/block match, no subdivision specified',
    };
  }

  // Parse target subdivision
  const targetParts = parseSubdivision(target.subdivision);
  if (!targetParts) {
    return {
      confidence: 'possible',
      reason: 'Could not parse target subdivision',
    };
  }

  // Check each instrument subdivision
  for (const instSubdiv of legal.subdivisions) {
    const instParts = parseSubdivision(instSubdiv);
    if (!instParts) {
      continue;
    }

    const intersects = checkSubdivisionIntersection(instParts, targetParts);
    if (intersects) {
      return intersects;
    }
  }

  // Section and block match but no subdivision match found
  return null;
}

interface SubdivisionParts {
  quarters: string[]; // e.g., ["SW4", "S2"] for S/2 of SW/4
}

/**
 * Parse subdivision string into components
 * Examples: 
 * - "S2SW4" -> S/2 of SW/4 (south half of southwest quarter)
 * - "SE" -> SE/4 (southeast quarter)
 * - "W2" -> W/2 (west half of section)
 * - "ALL" -> entire section
 */
function parseSubdivision(subdiv: string): SubdivisionParts | null {
  const normalized = subdiv.replace(/[\/\s]/g, '').toUpperCase();

  if (normalized === 'ALL' || normalized === 'ENTIRE') {
    return { quarters: ['ALL'] };
  }

  const quarters: string[] = [];

  // Match patterns:
  // - Simple quarter: SE, NW, etc. (2 letters)
  // - Half: N2, S2, E2, W2 (1 letter + number)
  // - Compound: S2SW4 (half of quarter), N2NE4 (half of quarter)
  
  // Try compound pattern first: [NESW][2-4]([NESW]{2})[2-4]?
  const compoundMatch = normalized.match(/^([NESW])([2-4])([NESW]{2})([2-4])?$/);
  if (compoundMatch) {
    // e.g., S2SW4 = S/2 of SW/4
    const outerDir = compoundMatch[1]; // S
    const outerFrac = compoundMatch[2]; // 2
    const innerDir = compoundMatch[3]; // SW
    // This means: take the SW quarter, then take the S half of that
    quarters.push(innerDir + '4'); // SW4
    quarters.push(outerDir + outerFrac); // S2
    return { quarters };
  }

  // Try simple quarter: SE, NW, etc. (must be valid 2-letter quarter)
  const quarterMatch = normalized.match(/^(NE|NW|SE|SW)([2-4])?$/);
  if (quarterMatch) {
    const dir = quarterMatch[1];
    const frac = quarterMatch[2] || '4';
    quarters.push(dir + frac);
    return { quarters };
  }

  // Try simple half: N2, S2, E2, W2
  const halfMatch = normalized.match(/^([NESW])([2-4])$/);
  if (halfMatch) {
    const dir = halfMatch[1];
    const frac = halfMatch[2];
    quarters.push(dir + frac);
    return { quarters };
  }

  return null;
}

/**
 * Check if two subdivisions intersect
 * 
 * Target S2SW4 (S/2 of SW/4) should intersect with:
 * - S2SW4 (exact match) - certain
 * - SW, SW4 (parent quarter) - certain
 * - S2 (parent half) - certain
 * - ALL (entire section) - certain
 * - W2 (west half, contains SW quarter) - certain
 * - SE, NE, NW, E2, N2 (no overlap) - null
 */
function checkSubdivisionIntersection(
  inst: SubdivisionParts,
  target: SubdivisionParts
): IntersectionResult | null {
  // If instrument covers ALL, it definitely includes target
  if (inst.quarters.includes('ALL')) {
    return {
      confidence: 'certain',
      reason: 'Instrument covers entire section',
    };
  }

  // For compound targets like S2SW4 (represented as ['SW4', 'S2']),
  // an instrument contains it if the instrument quarter contains
  // the compound target (which is the intersection of all target parts)
  
  for (const instQ of inst.quarters) {
    // Check if this instrument quarter contains the target compound
    // The target is the intersection of all its parts, so we need to check
    // if the instrument contains that intersection
    
    // Strategy: if the instrument quarter contains ANY of the target quarters,
    // it likely contains the compound (since the compound is more specific)
    const containsAnyPart = target.quarters.some(targetQ =>
      quarterContains(instQ, targetQ)
    );
    
    if (containsAnyPart) {
      return {
        confidence: 'certain',
        reason: `Instrument subdivision ${instQ} contains target`,
      };
    }
    
    // Check for exact match on any quarter
    if (target.quarters.includes(instQ)) {
      return {
        confidence: 'certain',
        reason: `Exact match on subdivision ${instQ}`,
      };
    }
  }

  // Check for possible overlap - but only if the instrument quarter
  // is contained by one of the target parts (not the other way around)
  // Example: S2 (target part) contains SE4 (inst), but SE4 doesn't overlap S2SW4
  // because S2SW4 is in SW, not SE
  for (const instQ of inst.quarters) {
    // Check if instrument and target share a common spatial region
    // For compound targets, we need ALL target parts to potentially overlap with inst
    const allPartsCouldOverlap = target.quarters.every(targetQ =>
      quartersMightOverlap(instQ, targetQ)
    );

    if (allPartsCouldOverlap) {
      return {
        confidence: 'possible',
        reason: `Instrument subdivision ${instQ} may overlap target`,
      };
    }
  }

  return null;
}

/**
 * Check if two quarters might have any spatial overlap
 * This is stricter than quarterOverlaps - it checks actual spatial proximity
 */
function quartersMightOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  
  // If either contains the other, they overlap
  if (quarterContains(a, b) || quarterContains(b, a)) {
    return true;
  }
  
  // Check if they share any common spatial area
  // E.g., SE and S2 overlap (SE is in south half)
  // But SE and SW don't overlap (different quarters)
  // And SE and W2 don't overlap (SE is in east half)
  
  const aDir = a.replace(/[0-9]/g, '');
  const bDir = b.replace(/[0-9]/g, '');
  
  // Check quarters: SE and SW don't overlap, but SE and S2 do
  if (aDir.length === 2 && bDir.length === 1) {
    // A is a quarter, B is a half
    return aDir.includes(bDir);
  }
  if (aDir.length === 1 && bDir.length === 2) {
    // A is a half, B is a quarter
    return bDir.includes(aDir);
  }
  if (aDir.length === 2 && bDir.length === 2) {
    // Both are quarters - they only overlap if they're the same
    return aDir === bDir;
  }
  
  // Both are halves or other cases
  return false;
}

/**
 * Check if quarter A contains quarter B
 * E.g., SW4 contains S2SW4, S2 contains S2SW4 and SW4, W2 contains SW4 and NW4
 */
function quarterContains(a: string, b: string): boolean {
  // ALL contains everything
  if (a === 'ALL') {
    return true;
  }
  if (b === 'ALL') {
    return false; // Nothing contains ALL except ALL itself
  }

  // Parse quarters
  const aDir = a.replace(/[0-9]/g, '');
  const aFrac = a.match(/[0-9]/)?.[0] || '4';
  const bDir = b.replace(/[0-9]/g, '');
  const bFrac = b.match(/[0-9]/)?.[0] || '4';

  // Check if A is a half (N2, S2, E2, W2) and B is within that half
  if (aDir.length === 1 && aFrac === '2') {
    // A is a half section
    if (bDir.length === 1) {
      // B is also a half - must be exact match
      return aDir === bDir && aFrac === bFrac;
    }
    if (bDir.length === 2) {
      // B is a quarter (NE, NW, SE, SW)
      // N2 contains NE, NW; S2 contains SE, SW; E2 contains NE, SE; W2 contains NW, SW
      if (aDir === 'N' && (bDir === 'NE' || bDir === 'NW')) return true;
      if (aDir === 'S' && (bDir === 'SE' || bDir === 'SW')) return true;
      if (aDir === 'E' && (bDir === 'NE' || bDir === 'SE')) return true;
      if (aDir === 'W' && (bDir === 'NW' || bDir === 'SW')) return true;
      return false;
    }
  }

  // Check if A is a quarter (NE, NW, SE, SW) and B is within that quarter
  if (aDir.length === 2 && bDir.length === 2) {
    // Both are quarters - A must equal B to contain
    if (aDir === bDir) {
      // Same quarter, check fractions
      // SW4 contains S2SW4 (which would be represented as multiple parts)
      return true;
    }
    return false;
  }

  // Check if A is a quarter and B is a subdivision of that quarter
  // E.g., SW4 should contain anything that starts with SW in the compound form
  // But in our representation, S2SW4 is represented as ['SW4', 'S2']
  // So when we're checking if SW4 contains SW4, that's a yes
  // When checking if SW4 contains S2, that's a no (S2 is a section-level half)
  
  return false;
}

/**
 * Check if quarters A and B overlap
 */
function quarterOverlaps(a: string, b: string): boolean {
  // If one contains the other, they overlap
  if (quarterContains(a, b) || quarterContains(b, a)) {
    return true;
  }

  // Additional overlap checks could go here
  // For now, if neither contains the other, assume no overlap
  return false;
}
