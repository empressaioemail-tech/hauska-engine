/**
 * Chain assembly - order, classify, and assemble working interest chain
 */

import type {
  ScopedInstrument,
  ClassifiedInstrument,
  InstrumentTypeFamily,
  ChainAssembly,
  WorkingInterestEntry,
} from '../types.js';

/**
 * Assemble the working interest chain from scoped instruments
 */
export function assembleChain(instruments: ScopedInstrument[]): ChainAssembly {
  // Step 1: Classify instruments by type family
  const classified = instruments.map(classifyInstrument);

  // Step 2: Order by date (instrument date, then filed date)
  const ordered = orderByDate(classified);

  // Step 3: Filter to WI-relevant instruments
  const wiRelevant = filterWIRelevant(ordered);

  // Step 4: Analyze chain for gaps
  const gaps = identifyGaps(wiRelevant);

  // Step 5: Compute working interest picture (method v0)
  const workingInterest = computeWorkingInterest(wiRelevant);

  return {
    instruments: ordered,
    gaps,
    workingInterest,
  };
}

/**
 * Classify instrument by type family
 */
function classifyInstrument(inst: ScopedInstrument): ClassifiedInstrument {
  const typeFamily = determineTypeFamily(inst.instrumentType);

  return {
    ...inst,
    typeFamily,
  };
}

/**
 * Determine type family from instrument type string
 */
function determineTypeFamily(instrumentType: string): InstrumentTypeFamily {
  const normalized = instrumentType.toUpperCase().trim();

  if (normalized.includes('PATENT')) {
    return 'patent';
  }
  if (normalized.includes('MINERAL') && normalized.includes('DEED')) {
    return 'mineral-deed';
  }
  if (normalized.includes('ROYALTY') && normalized.includes('DEED')) {
    return 'royalty-deed';
  }
  if (
    normalized.includes('OG') ||
    normalized.includes('O&G') ||
    normalized.includes('OIL') ||
    (normalized.includes('GAS') && normalized.includes('LEASE'))
  ) {
    return 'oil-gas-lease';
  }
  if (normalized.includes('ASSIGNMENT') || normalized.includes('ASGN')) {
    return 'assignment';
  }
  if (normalized.includes('RELEASE') || normalized.includes('REL')) {
    return 'release';
  }
  if (normalized.includes('PROBATE') || normalized.includes('WILL') || normalized.includes('ESTATE')) {
    return 'probate';
  }
  if (normalized.includes('D/T') || normalized.includes('DEED OF TRUST') || normalized.includes('DOT')) {
    return 'deed-of-trust';
  }
  if (normalized.includes('UNIT') && normalized.includes('DESIGNATION')) {
    return 'unit-designation';
  }
  if (normalized.includes('POOLING')) {
    return 'pooling';
  }
  if (normalized.includes('DEED') && !normalized.includes('MINERAL') && !normalized.includes('ROYALTY')) {
    return 'deed';
  }

  return 'other';
}

/**
 * Order instruments by date
 */
function orderByDate(instruments: ClassifiedInstrument[]): ClassifiedInstrument[] {
  return [...instruments].sort((a, b) => {
    // Primary sort: instrument date
    const aDate = a.instrumentDate?.getTime() ?? a.filedDate?.getTime() ?? 0;
    const bDate = b.instrumentDate?.getTime() ?? b.filedDate?.getTime() ?? 0;

    if (aDate !== bDate) {
      return aDate - bDate;
    }

    // Secondary sort: filed date
    const aFiled = a.filedDate?.getTime() ?? 0;
    const bFiled = b.filedDate?.getTime() ?? 0;

    return aFiled - bFiled;
  });
}

/**
 * Filter to working-interest relevant instruments
 */
function filterWIRelevant(instruments: ClassifiedInstrument[]): ClassifiedInstrument[] {
  const relevantFamilies: InstrumentTypeFamily[] = [
    'patent',
    'deed',
    'mineral-deed',
    'oil-gas-lease',
    'assignment',
    'release',
    'unit-designation',
    'pooling',
  ];

  return instruments.filter((inst) => relevantFamilies.includes(inst.typeFamily));
}

/**
 * Identify gaps and ambiguities in the chain
 */
function identifyGaps(instruments: ClassifiedInstrument[]): string[] {
  const gaps: string[] = [];

  // Check for patent (sovereignty grant)
  const hasPatent = instruments.some((inst) => inst.typeFamily === 'patent');
  if (!hasPatent) {
    gaps.push('No patent found - chain to sovereignty incomplete');
  }

  // Check for instruments with 'possible' intersection confidence
  const ambiguousCount = instruments.filter((inst) => inst.intersection === 'possible').length;
  if (ambiguousCount > 0) {
    gaps.push(`${ambiguousCount} instruments with uncertain tract intersection`);
  }

  // Check for date gaps > 10 years
  for (let i = 1; i < instruments.length; i++) {
    const prev = instruments[i - 1];
    const curr = instruments[i];

    if (!prev || !curr) continue;

    const prevDate = prev.instrumentDate ?? prev.filedDate;
    const currDate = curr.instrumentDate ?? curr.filedDate;

    if (prevDate && currDate) {
      const yearsDiff = (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24 * 365);
      if (yearsDiff > 10) {
        gaps.push(
          `Large time gap (${yearsDiff.toFixed(0)} years) between ${formatDate(prevDate)} and ${formatDate(currDate)}`
        );
      }
    }
  }

  // Check for missing grantor-grantee linkage
  // (Simplified - real implementation would track parties through chain)
  const missingParties = instruments.filter(
    (inst) => inst.grantors.length === 0 || inst.grantees.length === 0
  ).length;

  if (missingParties > 0) {
    gaps.push(`${missingParties} instruments with missing grantor/grantee information`);
  }

  return gaps;
}

/**
 * Compute working interest picture (method v0 - simplified)
 */
function computeWorkingInterest(instruments: ClassifiedInstrument[]): WorkingInterestEntry[] {
  const interests: WorkingInterestEntry[] = [];

  // Method v0: Track most recent oil & gas lease and assignments
  // This is a simplified initial method that will need refinement

  // Find the most recent active lease
  const leases = instruments
    .filter((inst) => inst.typeFamily === 'oil-gas-lease')
    .sort((a, b) => {
      const aDate = a.instrumentDate?.getTime() ?? 0;
      const bDate = b.instrumentDate?.getTime() ?? 0;
      return bDate - aDate;
    });

  if (leases.length === 0) {
    // No lease found - surface owner may hold WI
    interests.push({
      ownerName: 'Unknown Surface Owner',
      interest: 1.0,
      depthFrom: 'surface',
      depthTo: 'base',
    });
    return interests;
  }

  // Find assignments after the lease
  const primaryLease = leases[0];
  if (!primaryLease) {
    interests.push({
      ownerName: 'Unknown - No Lease Found',
      interest: 1.0,
    });
    return interests;
  }
  
  const leaseDate = primaryLease.instrumentDate ?? primaryLease.filedDate ?? new Date(0);

  const assignments = instruments.filter(
    (inst) =>
      inst.typeFamily === 'assignment' &&
      (inst.instrumentDate ?? inst.filedDate ?? new Date(0)) >= leaseDate
  );

  // Check for releases that might terminate the lease
  const releases = instruments.filter(
    (inst) =>
      inst.typeFamily === 'release' &&
      (inst.instrumentDate ?? inst.filedDate ?? new Date(0)) >= leaseDate
  );

  if (releases.length > 0) {
    // Lease may be released
    interests.push({
      ownerName: 'Unknown - Lease Released',
      interest: 1.0,
      depthFrom: 'surface',
      depthTo: 'base',
    });
    return interests;
  }

  // Simple case: lessee and any assignees
  const lessee = primaryLease.grantees[0] ?? 'Unknown Lessee';

  if (assignments.length === 0) {
    // No assignments - lessee holds 100%
    interests.push({
      ownerName: lessee,
      interest: 1.0,
    });
  } else {
    // With assignments - this needs more sophisticated parsing
    // For v0, split equally (placeholder logic)
    const assignees = assignments.flatMap((a) => a.grantees);
    const uniqueAssignees = Array.from(new Set([lessee, ...assignees]));

    const share = 1.0 / uniqueAssignees.length;
    for (const assignee of uniqueAssignees) {
      if (assignee) {
        interests.push({
          ownerName: assignee,
          interest: share,
        });
      }
    }
  }

  return interests;
}

/**
 * Format date for display
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}
