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
  // Check section match
  const sectionMatches = legal.sections.includes(target.section);
  if (!sectionMatches) {
    return null;
  }

  // Check block match
  if (!legal.block) {
    return null;
  }
  const blockMatches = legal.block.toUpperCase() === target.block.toUpperCase();
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
  return {
    confidence: 'possible',
    reason: 'Section/block match but subdivision unclear',
  };
}

interface SubdivisionParts {
  quarters: string[]; // e.g., ["SW", "S2"] for S/2 of SW/4
}

/**
 * Parse subdivision string into components
 * Examples: "S2SW4" -> S/2 of SW/4, "SE" -> SE/4, "W2" -> W/2
 */
function parseSubdivision(subdiv: string): SubdivisionParts | null {
  const normalized = subdiv.replace(/[\/\s]/g, '').toUpperCase();

  // Match patterns like S2SW4, NE, W2, etc.
  const quarters: string[] = [];

  // Pattern: [NESW][2]?[NESW]*[2-4]?
  let remaining = normalized;

  // Extract quarters working from right to left (most specific first)
  while (remaining.length > 0) {
    // Try to match quarter with optional number
    const match = remaining.match(/^([NESW]{1,2})([2-4])?(.*)$/);
    if (!match) {
      break;
    }

    const dir = match[1];
    const num = match[2] || '4'; // Default to /4 if not specified
    quarters.push(dir + num);
    remaining = match[3];
  }

  if (quarters.length === 0) {
    return null;
  }

  return { quarters: quarters.reverse() };
}

/**
 * Check if two subdivisions intersect
 */
function checkSubdivisionIntersection(
  inst: SubdivisionParts,
  target: SubdivisionParts
): IntersectionResult | null {
  // For S2SW4 target: we need instruments that cover:
  // - SW4 or SW or SW/4 (covers the whole SW quarter)
  // - S2 or S/2 (covers south half of entire section, includes S2SW4)
  // - S2SW4 or S/2 SW/4 (exact match)
  // - ALL (handled earlier)

  // Simple heuristic: check if instrument quarters could contain target quarters
  const instStr = inst.quarters.join('');
  const targetStr = target.quarters.join('');

  // Exact match
  if (instStr === targetStr) {
    return {
      confidence: 'certain',
      reason: 'Exact subdivision match',
    };
  }

  // Check if instrument is a parent of target
  // For SW covering S2SW4: SW4 is a parent of [SW4, S2]
  // Instrument covering just SW should contain S2SW4
  for (const iq of inst.quarters) {
    const iDir = iq.replace(/[0-9]/g, '');
    // Check if all target quarters have this direction
    const coversTarget = target.quarters.some((tq) => {
      const tDir = tq.replace(/[0-9]/g, '');
      return tDir.includes(iDir);
    });
    
    if (coversTarget) {
      return {
        confidence: 'certain',
        reason: 'Instrument covers broader area including target',
      };
    }
  }

  // Check if there's potential overlap based on direction
  // This is conservative - could have false positives
  const hasCommonDirection = inst.quarters.some((iq) =>
    target.quarters.some((tq) => {
      const iDir = iq.replace(/[0-9]/g, '');
      const tDir = tq.replace(/[0-9]/g, '');
      return iDir === tDir || iDir.includes(tDir) || tDir.includes(iDir);
    })
  );

  if (hasCommonDirection) {
    return {
      confidence: 'possible',
      reason: 'Subdivision may overlap based on direction',
    };
  }

  return null;
}
