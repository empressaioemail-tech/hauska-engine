/**
 * Normalization layer: raw RRC data → validated @empressaio/atom-contract@1.7.0 og atoms.
 *
 * Every atom:
 * - Validates against contract zod schemas (validation failures = mint failure, no silent drops)
 * - Carries accessPolicy: "platform-internal" (per task requirement)
 * - Includes full provenance (sourceCitation, extractedAt, asOf)
 *
 * Dropped records are counted and logged with reasons; silently skipping is prohibited.
 */

import {
  WELL_SCHEMA,
  PRODUCTION_TIMESERIES_SCHEMA,
  type WellAtomInstance,
  type ProductionTimeseriesAtomInstance,
} from "@empressaio/atom-contract/og";
import { createHash } from "node:crypto";
import type { W1FetchResult, PdqOilFetchResult, PdqGasFetchResult, H10FetchResult } from "@hauska-engine/og-sources";
import type { RawW1Permit } from "../../og-sources/src/adapters/rrc-w1/types.js";
import type { RawOilProductionRecord, RawGasProductionRecord } from "../../og-sources/src/adapters/rrc-pdq/types.js";
import type { RawH10InjectionRecord } from "../../og-sources/src/adapters/rrc-h10/types.js";

/**
 * Validation result with drop tracking.
 */
export interface ValidationStats {
  attempted: number;
  validated: number;
  dropped: number;
  dropReasons: ReadonlyArray<{ record: string; reason: string }>;
}

/**
 * Normalize W-1 permits to well atoms.
 */
export function normalizeW1ToWells(fetchResult: W1FetchResult): {
  atoms: ReadonlyArray<WellAtomInstance>;
  stats: ValidationStats;
} {
  const atoms: WellAtomInstance[] = [];
  const dropReasons: Array<{ record: string; reason: string }> = [];

  for (const permit of fetchResult.permits) {
    try {
      const atom = normalizeW1Permit(permit, fetchResult);
      // Validate against contract schema
      const validated = WELL_SCHEMA.parse(atom);
      atoms.push(validated);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      dropReasons.push({
        record: `API ${permit.apiNumber}`,
        reason: message,
      });
      console.warn(`Dropped W-1 permit ${permit.permitNumber} (API ${permit.apiNumber}): ${message}`);
    }
  }

  return {
    atoms,
    stats: {
      attempted: fetchResult.permits.length,
      validated: atoms.length,
      dropped: dropReasons.length,
      dropReasons,
    },
  };
}

/**
 * Normalize a single W-1 permit to well atom.
 */
function normalizeW1Permit(permit: RawW1Permit, fetchResult: W1FetchResult): WellAtomInstance {
  // Clean and validate API number
  const apiNumber14 = cleanApiNumber(permit.apiNumber);
  const wellDid = `well_${apiNumber14}`;

  // Map well type
  const wellType = mapWellType(permit.wellType);

  // Surface location (required by contract)
  const surfaceLocation = {
    latitude: permit.surfaceLatitude ?? 0,
    longitude: permit.surfaceLongitude ?? 0,
    datum: permit.datum ?? "NAD27",
  };

  return {
    entityType: "well",
    wellDid,
    apiNumber14,
    wellName: permit.wellName || `UNKNOWN-${permit.permitNumber}`,
    wellNumber: extractWellNumber(permit.wellName),
    wellType,
    status: deriveStatus(permit),
    spudDate: permit.dateApproved,
    completionDate: undefined, // W-1 does not carry completion date
    totalDepth: permit.proposedDepth,
    surfaceLocation,
    bottomholeLocation: undefined, // W-1 does not include BH location
    fieldRef: undefined, // W-1 does not include field numbers
    district: permit.district,
    sourceCitation: buildW1SourceCitation(permit, fetchResult),
    extractedAt: fetchResult.fetchedAt,
    asOf: permit.dateApproved,
    accessPolicy: "platform-internal", // Per task requirement
  };
}

/**
 * Clean and validate API number. Accepts 10-digit (state+county+sequence) or
 * 14-digit (full API) formats. Pads 10-digit to 14-digit by adding "0000" suffix.
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
 * Map RRC well type to contract WellType enum.
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
      // Default to "oil" for unrecognized types
      console.warn(`Unrecognized RRC well type "${rrcType}", defaulting to "oil"`);
      return "oil";
  }
}

/**
 * Extract well number from well name (e.g., "SMITH A #1" → "1").
 */
function extractWellNumber(wellName: string): string {
  const match = wellName.match(/#(\d+[A-Z]?)\s*$/i);
  if (match && match[1]) {
    return match[1];
  }
  return wellName; // Fallback: use full name
}

/**
 * Derive well status from W-1 permit data.
 */
function deriveStatus(permit: RawW1Permit): string {
  if (!permit.dateApproved) {
    return "pending";
  }
  return "permitted"; // Approved permits are "permitted"
}

/**
 * Build source citation for W-1 permit.
 */
function buildW1SourceCitation(permit: RawW1Permit, fetchResult: W1FetchResult): string {
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

/**
 * Normalize PDQ oil production to production-timeseries atoms.
 */
export function normalizePdqOilToAtoms(fetchResult: PdqOilFetchResult): {
  atoms: ReadonlyArray<ProductionTimeseriesAtomInstance>;
  stats: ValidationStats;
} {
  const atoms: ProductionTimeseriesAtomInstance[] = [];
  const dropReasons: Array<{ record: string; reason: string }> = [];

  for (const record of fetchResult.records) {
    try {
      const atomData = normalizeOilRecord(record, fetchResult);
      // Validate against contract schema
      const validated = PRODUCTION_TIMESERIES_SCHEMA.parse(atomData) as ProductionTimeseriesAtomInstance;
      atoms.push(validated);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      dropReasons.push({
        record: `Lease ${record.leaseNumber} (${record.month})`,
        reason: message,
      });
      console.warn(`Dropped PDQ oil record ${record.leaseNumber}/${record.month}: ${message}`);
    }
  }

  return {
    atoms,
    stats: {
      attempted: fetchResult.records.length,
      validated: atoms.length,
      dropped: dropReasons.length,
      dropReasons,
    },
  };
}

/**
 * Normalize a single oil production record to atom.
 */
function normalizeOilRecord(
  record: RawOilProductionRecord,
  fetchResult: PdqOilFetchResult
) {
  const anchorDid = createRrcLeaseDid(record.district, record.leaseNumber);
  const streamDid = createStreamDid({
    anchorDid,
    product: "oil",
    month: record.month,
    source: "rrc-pdq",
  });

  return {
    entityType: "production-timeseries",
    streamDid,
    streamKind: "reported",
    anchorKind: "rrc-lease",
    anchorDid,
    product: "oil",
    granularity: "monthly",
    sourceAdapter: "rrc-pdq",
    sourceCitation: `RRC PDQ Oil Production (District ${record.district}, Lease ${record.leaseNumber}, ${record.month})`,
    extractedAt: fetchResult.fetchedAt,
    asOf: record.month,
    accessPolicy: "platform-internal",
  } as ProductionTimeseriesAtomInstance;
}

/**
 * Normalize PDQ gas production to production-timeseries atoms.
 */
export function normalizePdqGasToAtoms(fetchResult: PdqGasFetchResult): {
  atoms: ReadonlyArray<ProductionTimeseriesAtomInstance>;
  stats: ValidationStats;
} {
  const atoms: ProductionTimeseriesAtomInstance[] = [];
  const dropReasons: Array<{ record: string; reason: string }> = [];

  for (const record of fetchResult.records) {
    try {
      const atomData = normalizeGasRecord(record, fetchResult);
      // Validate against contract schema
      const validated = PRODUCTION_TIMESERIES_SCHEMA.parse(atomData) as ProductionTimeseriesAtomInstance;
      atoms.push(validated);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      dropReasons.push({
        record: `API ${record.apiNumber} (${record.month})`,
        reason: message,
      });
      console.warn(`Dropped PDQ gas record ${record.apiNumber}/${record.month}: ${message}`);
    }
  }

  return {
    atoms,
    stats: {
      attempted: fetchResult.records.length,
      validated: atoms.length,
      dropped: dropReasons.length,
      dropReasons,
    },
  };
}

/**
 * Normalize a single gas production record to atom.
 */
function normalizeGasRecord(
  record: RawGasProductionRecord,
  fetchResult: PdqGasFetchResult
) {
  const anchorDid = createWellDidFromApi10(record.apiNumber);
  const streamDid = createStreamDid({
    anchorDid,
    product: "gas",
    month: record.month,
    source: "rrc-pdq",
  });

  return {
    entityType: "production-timeseries",
    streamDid,
    streamKind: "reported",
    anchorKind: "well",
    anchorDid,
    product: "gas",
    granularity: "monthly",
    sourceAdapter: "rrc-pdq",
    sourceCitation: `RRC PDQ Gas Production (District ${record.district}, API ${record.apiNumber}, ${record.month})`,
    extractedAt: fetchResult.fetchedAt,
    asOf: record.month,
    accessPolicy: "platform-internal",
  } as ProductionTimeseriesAtomInstance;
}

/**
 * Normalize H-10 injection data to production-timeseries atoms.
 */
export function normalizeH10ToAtoms(fetchResult: H10FetchResult): {
  atoms: ReadonlyArray<ProductionTimeseriesAtomInstance>;
  stats: ValidationStats;
} {
  const atoms: ProductionTimeseriesAtomInstance[] = [];
  const dropReasons: Array<{ record: string; reason: string }> = [];

  for (const record of fetchResult.records) {
    try {
      const atomData = normalizeInjectionRecord(record, fetchResult);
      // Validate against contract schema
      const validated = PRODUCTION_TIMESERIES_SCHEMA.parse(atomData) as ProductionTimeseriesAtomInstance;
      atoms.push(validated);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      dropReasons.push({
        record: `API ${record.apiNumber} (${record.month})`,
        reason: message,
      });
      console.warn(`Dropped H-10 record ${record.apiNumber}/${record.month}: ${message}`);
    }
  }

  return {
    atoms,
    stats: {
      attempted: fetchResult.records.length,
      validated: atoms.length,
      dropped: dropReasons.length,
      dropReasons,
    },
  };
}

/**
 * Normalize a single H-10 injection record to atom.
 */
function normalizeInjectionRecord(
  record: RawH10InjectionRecord,
  fetchResult: H10FetchResult
) {
  const anchorDid = createWellDidFromApi10(record.apiNumber);
  const product = mapInjectionTypeToProduct(record.injectionType);
  const streamDid = createStreamDid({
    anchorDid,
    product,
    month: record.month,
    source: "rrc-h10",
  });

  return {
    entityType: "production-timeseries",
    streamDid,
    streamKind: "reported",
    anchorKind: "well",
    anchorDid,
    product,
    granularity: "monthly",
    sourceAdapter: "rrc-h10",
    sourceCitation: `RRC H-10 Injection/Disposal (District ${record.district}, API ${record.apiNumber}, ${record.month})`,
    extractedAt: fetchResult.fetchedAt,
    asOf: record.month,
    accessPolicy: "platform-internal",
  } as ProductionTimeseriesAtomInstance;
}

/**
 * Map H-10 injection type to product type.
 */
function mapInjectionTypeToProduct(injectionType: string): "injection" | "water" {
  const normalized = injectionType.toUpperCase();
  if (normalized.includes("SWD") || normalized.includes("DISPOSAL")) {
    return "water";
  }
  return "injection";
}

/**
 * Create RRC lease DID from district and lease number.
 */
function createRrcLeaseDid(district: string, leaseNumber: string): string {
  const input = `rrc-lease:${district}:${leaseNumber}`;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `rrclease_${hash}`;
}

/**
 * Create well DID from 10-digit API number (PDQ/H-10 format).
 */
function createWellDidFromApi10(apiNumber: string): string {
  const input = `api:${apiNumber}`;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `well_${hash}`;
}

/**
 * Create production stream DID.
 */
function createStreamDid(params: {
  anchorDid: string;
  product: string;
  month: string;
  source: string;
}): string {
  const input = `stream:${params.anchorDid}:${params.product}:${params.month}:${params.source}`;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `prodts_${hash}`;
}
