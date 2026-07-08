/**
 * Grade comparator - compare method output against certified report
 */

import type { WorkingInterestEntry, GradeResult } from '../types.js';
import { normalizeOwnerName } from './wi-report-parser.js';

/**
 * Compare method working interest against report
 */
export function compareWorkingInterest(
  methodWI: WorkingInterestEntry[],
  reportWI: WorkingInterestEntry[]
): GradeResult {
  const matched: GradeResult['matched'] = [];
  const missed: GradeResult['missed'] = [];
  const spurious: GradeResult['spurious'] = [];
  const explanation: string[] = [];

  // Normalize all names for comparison
  const normalizedMethod = methodWI.map((entry) => ({
    ...entry,
    normalizedName: normalizeOwnerName(entry.ownerName),
  }));

  const normalizedReport = reportWI.map((entry) => ({
    ...entry,
    normalizedName: normalizeOwnerName(entry.ownerName),
  }));

  // Find matches, misses, and spurious entries
  const matchedReportIndices = new Set<number>();

  for (const methodEntry of normalizedMethod) {
    // Try to find matching report entry
    let bestMatch: { index: number; delta: number } | null = null;

    for (let i = 0; i < normalizedReport.length; i++) {
      if (matchedReportIndices.has(i)) {
        continue;
      }

      const reportEntry = normalizedReport[i];

      // Check name similarity
      const nameSimilarity = calculateNameSimilarity(
        methodEntry.normalizedName,
        reportEntry.normalizedName
      );

      if (nameSimilarity > 0.7) {
        // Consider this a potential match
        const delta = Math.abs(methodEntry.interest - reportEntry.interest);

        if (bestMatch === null || delta < bestMatch.delta) {
          bestMatch = { index: i, delta };
        }
      }
    }

    if (bestMatch !== null) {
      // Found a match
      const reportEntry = normalizedReport[bestMatch.index];
      if (!reportEntry) continue;
      
      matchedReportIndices.add(bestMatch.index);

      matched.push({
        owner: methodEntry.ownerName,
        methodInterest: methodEntry.interest,
        reportInterest: reportEntry.interest,
        delta: bestMatch.delta,
      });

      if (Math.abs(bestMatch.delta) > 0.01) {
        explanation.push(
          `Interest mismatch for ${methodEntry.ownerName}: ` +
            `method=${methodEntry.interest.toFixed(4)}, ` +
            `report=${reportEntry.interest.toFixed(4)}, ` +
            `delta=${bestMatch.delta.toFixed(4)}. ` +
            `Possible cause: assignment fractions not fully parsed`
        );
      }
    } else {
      // No match found - spurious entry
      spurious.push({
        owner: methodEntry.ownerName,
        methodInterest: methodEntry.interest,
      });

      explanation.push(
        `Spurious owner ${methodEntry.ownerName}: ` +
          `present in method (${methodEntry.interest.toFixed(4)}) but not in report. ` +
          `Possible cause: name parsing error or incorrect chain link`
      );
    }
  }

  // Find missed entries (in report but not in method)
  for (let i = 0; i < normalizedReport.length; i++) {
    if (!matchedReportIndices.has(i)) {
      const reportEntry = normalizedReport[i];
      if (!reportEntry) continue;
      
      missed.push({
        owner: reportEntry.ownerName,
        reportInterest: reportEntry.interest,
      });

      explanation.push(
        `Missed owner ${reportEntry.ownerName}: ` +
          `present in report (${reportEntry.interest.toFixed(4)}) but not in method. ` +
          `Possible cause: instrument not parsed, assignment chain incomplete, or name mismatch`
      );
    }
  }

  return {
    matched,
    missed,
    spurious,
    explanation,
  };
}

/**
 * Calculate name similarity (simple Levenshtein-based approach)
 */
function calculateNameSimilarity(name1: string, name2: string): number {
  // Exact match
  if (name1 === name2) {
    return 1.0;
  }

  // Check if one name contains the other (common for abbreviated names)
  if (name1.includes(name2) || name2.includes(name1)) {
    return 0.85;
  }

  // Calculate Levenshtein distance
  const distance = levenshteinDistance(name1, name2);
  const maxLen = Math.max(name1.length, name2.length);

  if (maxLen === 0) {
    return 1.0;
  }

  return 1 - distance / maxLen;
}

/**
 * Levenshtein distance implementation
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len2; j++) {
    const row = matrix[0];
    if (row) {
      row[j] = j;
    }
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      const row = matrix[i];
      const prevRow = matrix[i - 1];
      
      if (row && prevRow) {
        const prevCell = row[j - 1];
        const upCell = prevRow[j];
        const diagCell = prevRow[j - 1];
        
        if (prevCell !== undefined && upCell !== undefined && diagCell !== undefined) {
          row[j] = Math.min(
            upCell + 1,
            prevCell + 1,
            diagCell + cost
          );
        }
      }
    }
  }

  const finalRow = matrix[len1];
  return finalRow ? finalRow[len2] ?? 0 : 0;
}
