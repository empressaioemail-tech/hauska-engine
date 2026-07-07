/**
 * RRC H-10 normalization logic: raw injection/disposal records → production-timeseries atoms.
 *
 * Injection and disposal volumes are reported at the well level (per ADR-025).
 * Each atom:
 * - `anchorKind`: "well"
 * - `anchorDid`: well_<hash(apiNumber)>
 * - `product`: "injection" (or "water" for disposal, depending on use case)
 * - `streamKind`: "reported" (direct from source)
 *
 * This follows the same grain as gas production (well-level reporting).
 */

import { createHash } from "node:crypto";
import type { ProductionTimeseriesAtomInstance } from "@empressaio/atom-contract/og";
import type { RawH10InjectionRecord } from "./types.js";

/**
 * Adapter identifier for H-10 source.
 */
const H10_ADAPTER = "rrc-h10";

/**
 * Normalize H-10 injection/disposal records to production-timeseries atoms.
 *
 * Injection volumes are reported at the well level. Each atom:
 * - `anchorKind`: "well"
 * - `anchorDid`: well_<hash(apiNumber)>
 * - `product`: "injection" (or "water" for SWD, depending on reporting)
 * - `streamKind`: "reported" (direct from source)
 *
 * @param records - Raw H-10 injection/disposal records.
 * @param fetchedAt - ISO timestamp when the data was extracted.
 * @returns Array of production-timeseries atoms.
 */
export function normalizeH10Injection(
  records: ReadonlyArray<RawH10InjectionRecord>,
  fetchedAt: string,
): ReadonlyArray<ProductionTimeseriesAtomInstance> {
  return records.map((record) => {
    const anchorDid = createWellDid(record.apiNumber);
    const product = mapInjectionTypeToProduct(record.injectionType);
    const streamDid = createStreamDid({
      anchorDid,
      product,
      month: record.month,
      source: H10_ADAPTER,
    });

    return {
      entityType: "production-timeseries",
      streamDid,
      streamKind: "reported",
      anchorKind: "well",
      anchorDid,
      product,
      granularity: "monthly",
      sourceAdapter: H10_ADAPTER,
      sourceCitation: `RRC H-10 (${record.district}/${record.apiNumber}, ${record.month})`,
      extractedAt: fetchedAt,
      accessPolicy: "public-free",
    } satisfies ProductionTimeseriesAtomInstance;
  });
}

/**
 * Map H-10 injection type to product type.
 *
 * - SWD (saltwater disposal) → "water"
 * - EOR-GAS (enhanced recovery gas injection) → "injection"
 * - EOR-WATER (enhanced recovery water injection) → "injection"
 * - Other → "injection" (generic)
 */
function mapInjectionTypeToProduct(injectionType: string): "injection" | "water" {
  const normalized = injectionType.toUpperCase();
  if (normalized.includes("SWD") || normalized.includes("DISPOSAL")) {
    return "water";
  }
  return "injection";
}

/**
 * Create well DID from API number.
 *
 * Format: well_<hash(apiNumber)>
 *
 * Per ADR-025, injection volumes are reported at the well level (same grain
 * as gas production). The DID is stable across time for a given API number.
 */
function createWellDid(apiNumber: string): string {
  const input = `api:${apiNumber}`;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `well_${hash}`;
}

/**
 * Create production stream DID from anchor, product, month, and source.
 *
 * Format: prodts_<hash(anchorDid, product, month, source)>
 *
 * Per ADR-025, a production stream is uniquely identified by (anchor, product,
 * source). The month is included to ensure a unique DID per time period.
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
