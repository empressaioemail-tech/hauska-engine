/**
 * Working Interest Report parser
 * 
 * Parse the certified landman WI report to extract ownership table
 */

import pdf from 'pdf-parse';
import type { WorkingInterestEntry } from '../types.js';

/**
 * Parse WI report PDF to extract ownership entries
 */
export async function parseWIReportPdf(pdfBuffer: Buffer): Promise<WorkingInterestEntry[]> {
  const data = await pdf(pdfBuffer);
  const text = data.text;

  return parseWIReportText(text);
}

/**
 * Parse extracted text from WI report
 */
export function parseWIReportText(text: string): WorkingInterestEntry[] {
  const entries: WorkingInterestEntry[] = [];
  const lines = text.split('\n');

  let inOwnershipSection = false;
  let currentDepthFrom: string | undefined;
  let currentDepthTo: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineRaw = lines[i];
    if (!lineRaw) continue;
    const line = lineRaw.trim();

    // Look for depth section headers
    const depthMatch = line.match(/(?:SURFACE|DEPTH|INTERVAL).*?(\d+(?:,\d+)?)\s*(?:FT|FEET)?.*?(\d+(?:,\d+)?)\s*(?:FT|FEET)?/i);
    if (depthMatch && depthMatch[1] && depthMatch[2]) {
      currentDepthFrom = depthMatch[1].replace(/,/g, '');
      currentDepthTo = depthMatch[2].replace(/,/g, '');
      inOwnershipSection = true;
      continue;
    }

    // Look for single depth notation (e.g., "5,000 ft+")
    const singleDepthMatch = line.match(/(\d+(?:,\d+)?)\s*(?:FT|FEET)?\s*\+/i);
    if (singleDepthMatch && singleDepthMatch[1]) {
      currentDepthFrom = singleDepthMatch[1].replace(/,/g, '');
      currentDepthTo = undefined;
      inOwnershipSection = true;
      continue;
    }

    // Look for ownership table rows
    // Expected format variations:
    // OWNER_NAME    0.25    25%
    // OWNER_NAME    0.5000  50.00%
    const ownerMatch = line.match(/^([A-Z][A-Za-z\s\.,&]+?)\s+(0?\.\d+|1\.0+|\d+\.\d+)\s*(?:%)?/);
    if (ownerMatch && ownerMatch[1] && ownerMatch[2] && inOwnershipSection) {
      const ownerName = ownerMatch[1].trim();
      let interest = parseFloat(ownerMatch[2]);

      // Handle percentage format (convert to decimal)
      if (interest > 1) {
        interest = interest / 100;
      }

      entries.push({
        ownerName,
        interest,
        depthFrom: currentDepthFrom,
        depthTo: currentDepthTo,
      });
    }

    // Reset section if we hit a clear break
    if (line === '' || line.match(/^(COMMENTS|NOTES|CERTIFICATION)/i)) {
      inOwnershipSection = false;
    }
  }

  return entries;
}

/**
 * Normalize owner name for comparison
 */
export function normalizeOwnerName(name: string): string {
  return name
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[,\.]/g, '')
    .replace(/\s+(JR|SR|III|IV|II)$/i, '')
    .replace(/\s+(LLC|LP|LTD|INC|CORP)$/i, '');
}
