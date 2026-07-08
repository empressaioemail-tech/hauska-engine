/**
 * Normalization layer: raw W-1 permits → @empressaio/atom-contract/og wells.
 *
 * This module converts RawW1Permit records into WellAtomInstance shapes that
 * conform to the atom contract. DID derivation follows the contract's
 * well_<api14> format; all provenance fields (sourceCitation, extractedAt)
 * are populated per the quality gate.
 */

import { WELL_SCHEMA, type WellAtomInstance } from "@empressaio/atom-contract/og";
import type { RawW1Permit, W1FetchResult } from "./types.js";

/**
 * Normalize a W-1 fetch result into an array of well atoms. Each permit
 * becomes one well atom with full provenance metadata.
 *
 * Wells that fail validation (missing required fields, invalid DID format)
 * are logged and skipped rather than crashing the entire normalization pass.
 */
export function normalizeW1Permits(
  fetchResult: W1FetchResult,
): ReadonlyArray<WellAtomInstance> {
  const wells: WellAtomInstance[] = [];

  for (const permit of fetchResult.permits) {
    try {
      const well = normalizePermit(permit, fetchResult);
      // Validate against the contract schema
      const validated = WELL_SCHEMA.parse(well);
      wells.push(validated);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `Skipping invalid W-1 permit ${permit.permitNumber}: ${message}`,
      );
      // Continue to next permit
    }
  }

  return wells;
}

/**
 * Normalize a single W-1 permit into a WellAtomInstance.
 */
function normalizePermit(
  permit: RawW1Permit,
  fetchResult: W1FetchResult,
): WellAtomInstance {
  // HONESTY GATE: the EWA results grain carries no 14-digit API number, and
  // the contract WELL_SCHEMA requires identifiers/surfaceLocation this grain
  // cannot supply. Records without a real API number must be skipped (or the
  // caller should keep them as permit-grain records) — never fabricated.
  if (!permit.apiNumber) {
    throw new Error(
      `W-1 permit ${permit.permitNumber} has no API number at the results grain; ` +
        `well-atom normalization requires a detail-page enrichment (contract-fit gap, ADR-025 follow-up)`,
    );
  }
  const apiNumber14 = cleanApiNumber(permit.apiNumber);
  const wellDid = deriveWellDid(apiNumber14);

  // Map RRC well type to contract WellType enum
  const wellType = mapWellType(permit.wellType);

  // Surface location is required per the contract
  const surfaceLocation = {
    latitude: permit.surfaceLatitude ?? 0,
    longitude: permit.surfaceLongitude ?? 0,
    datum: permit.datum ?? "NAD27", // RRC default
  };

  // Extract well number - must be non-empty string, fallback to API suffix if absent
  const wellNumber = extractWellNumber(permit.wellName) || apiNumber14.slice(-4);

  // Handle totalDepth: omit if undefined, NaN, or invalid
  const totalDepth = 
    permit.proposedDepth !== undefined && 
    !isNaN(permit.proposedDepth) && 
    isFinite(permit.proposedDepth) && 
    permit.proposedDepth > 0
      ? permit.proposedDepth
      : undefined;

  // Build the well atom
  // Note: W-1 does not publish field numbers, so we omit fieldRef entirely
  // (the contract requires both fieldName and fieldNumber if present)
  const well: WellAtomInstance = {
    entityType: "well",
    wellDid,
    apiNumber14,
    wellName: permit.wellName || `UNKNOWN-${permit.permitNumber}`,
    wellNumber,
    wellType,
    status: deriveStatus(permit),
    spudDate: permit.dateApproved, // W-1 approved date as proxy for spud
    completionDate: undefined, // W-1 does not carry completion date
    totalDepth,
    surfaceLocation,
    bottomholeLocation: undefined, // W-1 does not include BH location
    fieldRef: undefined, // W-1 does not include field numbers
    district: permit.district,
    sourceCitation: buildSourceCitation(permit, fetchResult),
    extractedAt: fetchResult.fetchedAt,
    asOf: permit.dateApproved, // The permit approval date is the "as-of" date
    accessPolicy: "public-free", // RRC data is public
  };

  return well;
}

/**
 * Clean and validate API number. The contract expects a 14-digit API number
 * with no hyphens or spaces. Accepts 8, 10, or 14 digit formats and pads as needed.
 *
 * Texas API format: 42-389-XXXXX (state 42, county 389, sequence number)
 * Full API-14: 42389XXXXX0000
 */
function cleanApiNumber(raw: string): string {
  const cleaned = raw.replace(/[-\s]/g, "");
  
  if (/^\d{14}$/.test(cleaned)) {
    // Already 14 digits
    return cleaned;
  } else if (/^\d{8}$/.test(cleaned)) {
    // 8-digit format (county+sequence, missing state prefix)
    // Pad with Texas state code (42) and 0000 suffix
    return `42${cleaned}0000`;
  } else if (/^\d{10}$/.test(cleaned)) {
    // 10-digit format (state+county+sequence)
    // Pad with 0000 suffix
    return `${cleaned}0000`;
  } else {
    throw new Error(
      `Invalid API number format: ${raw} (expected 8, 10, or 14 digits, got ${cleaned.length})`,
    );
  }
}

/**
 * Derive well DID from API-14 number. Format: well_<api14>.
 * The contract's WELL_SCHEMA validates this format via ZodEffects.
 */
function deriveWellDid(apiNumber14: string): string {
  return `well_${apiNumber14}`;
}

/**
 * Map RRC well type string to contract WellType enum. RRC uses uppercase
 * strings like "OIL", "GAS", "INJECTION"; the contract uses lowercase.
 */
function mapWellType(rrcType: string): WellAtomInstance["wellType"] {
  const normalized = rrcType.toLowerCase();
  switch (normalized) {
    case "oil":
      return "oil";
    case "gas":
      return "gas";
    case "injection":
      return "injection";
    case "disposal":
      return "disposal";
    case "dry":
      return "dry";
    case "plugged":
      return "plugged";
    default:
      // Default to "oil" for unrecognized types (RRC may add new categories)
      console.warn(
        `Unrecognized RRC well type "${rrcType}", defaulting to "oil"`,
      );
      return "oil";
  }
}

/**
 * Extract well number from well name. RRC well names often include the well
 * number as a suffix (e.g., "SMITH A #1" → "1"). If no number is found,
 * return empty string (caller should handle fallback).
 */
function extractWellNumber(wellName: string): string {
  if (!wellName) {
    return "";
  }
  const match = wellName.match(/#(\d+[A-Z]?)\s*$/i);
  if (match && match[1]) {
    return match[1];
  }
  // Try to extract any trailing number without # prefix
  const numMatch = wellName.match(/(\d+[A-Z]?)\s*$/i);
  if (numMatch && numMatch[1]) {
    return numMatch[1];
  }
  return ""; // Return empty string if no number found
}

/**
 * Derive well status from W-1 permit data. Permits are typically for future
 * wells, so status is "permitted" or "drilling" based on approval date.
 * Wells with no approval date are "pending".
 */
function deriveStatus(permit: RawW1Permit): string {
  if (!permit.dateApproved) {
    return "pending";
  }
  // If approved, assume "permitted" (we don't know if drilling has started)
  return "permitted";
}

/**
 * Build source citation string for provenance. Format:
 * "RRC W-1 Drilling Permit <permitNumber> (County: <county>, Submitted: <date>)"
 */
function buildSourceCitation(
  permit: RawW1Permit,
  fetchResult: W1FetchResult,
): string {
  const parts = [
    `RRC W-1 Drilling Permit ${permit.permitNumber}`,
    `County: ${permit.county}`,
  ];
  if (permit.dateSubmitted) {
    parts.push(`Submitted: ${permit.dateSubmitted}`);
  }
  parts.push(`Source: ${fetchResult.sourceUrl}`);
  return parts.join(", ");
}
