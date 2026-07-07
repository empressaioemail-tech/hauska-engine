/**
 * RRC PDQ normalization logic: raw production records → production-timeseries atoms.
 *
 * Models the Texas reporting split per ADR-025:
 * - Oil production → anchors to rrc-lease (anchorKind: "rrc-lease")
 * - Gas production → anchors to well (anchorKind: "well")
 *
 * This grain discriminator is EXPLICIT in the atom schema and must never be
 * elided or inferred. The production-timeseries contract enforces this via
 * the anchorKind + anchorDid fields.
 */

import { createHash } from "node:crypto";
import type { ProductionTimeseriesAtomInstance } from "@empressaio/atom-contract/og";
import type {
  RawOilProductionRecord,
  RawGasProductionRecord,
} from "./types.js";

/**
 * Adapter identifier for PDQ source.
 */
const PDQ_ADAPTER = "rrc-pdq";

/**
 * Normalize oil production records (lease-level) to production-timeseries atoms.
 *
 * Oil production in Texas is reported at the RRC lease level. Each atom:
 * - `anchorKind`: "rrc-lease"
 * - `anchorDid`: rrclease_<hash(district, leaseNumber)>
 * - `product`: "oil"
 * - `streamKind`: "reported" (direct from source)
 *
 * @param records - Raw oil production records from PDQ.
 * @param fetchedAt - ISO timestamp when the data was extracted.
 * @returns Array of production-timeseries atoms.
 */
export function normalizeOilProduction(
  records: ReadonlyArray<RawOilProductionRecord>,
  fetchedAt: string,
): ReadonlyArray<ProductionTimeseriesAtomInstance> {
  return records.map((record) => {
    const anchorDid = createRrcLeaseDid(record.district, record.leaseNumber);
    const streamDid = createStreamDid({
      anchorDid,
      product: "oil",
      month: record.month,
      source: PDQ_ADAPTER,
    });

    return {
      entityType: "production-timeseries",
      streamDid,
      streamKind: "reported",
      anchorKind: "rrc-lease",
      anchorDid,
      product: "oil",
      granularity: "monthly",
      sourceAdapter: PDQ_ADAPTER,
      sourceCitation: `RRC PDQ (${record.district}/${record.leaseNumber}, ${record.month})`,
      extractedAt: fetchedAt,
      accessPolicy: "public-free",
    } satisfies ProductionTimeseriesAtomInstance;
  });
}

/**
 * Normalize gas production records (well-level) to production-timeseries atoms.
 *
 * Gas production in Texas is reported at the well level. Each atom:
 * - `anchorKind`: "well"
 * - `anchorDid`: well_<hash(apiNumber)>
 * - `product`: "gas"
 * - `streamKind`: "reported" (direct from source)
 *
 * @param records - Raw gas production records from PDQ.
 * @param fetchedAt - ISO timestamp when the data was extracted.
 * @returns Array of production-timeseries atoms.
 */
export function normalizeGasProduction(
  records: ReadonlyArray<RawGasProductionRecord>,
  fetchedAt: string,
): ReadonlyArray<ProductionTimeseriesAtomInstance> {
  return records.map((record) => {
    const anchorDid = createWellDid(record.apiNumber);
    const streamDid = createStreamDid({
      anchorDid,
      product: "gas",
      month: record.month,
      source: PDQ_ADAPTER,
    });

    return {
      entityType: "production-timeseries",
      streamDid,
      streamKind: "reported",
      anchorKind: "well",
      anchorDid,
      product: "gas",
      granularity: "monthly",
      sourceAdapter: PDQ_ADAPTER,
      sourceCitation: `RRC PDQ (${record.district}/${record.apiNumber}, ${record.month})`,
      extractedAt: fetchedAt,
      accessPolicy: "public-free",
    } satisfies ProductionTimeseriesAtomInstance;
  });
}

/**
 * Create RRC lease DID from district and lease number.
 *
 * Format: rrclease_<hash(district, leaseNumber)>
 *
 * Per ADR-025, the RRC lease is the regulatory reporting unit for oil
 * production. The DID is stable across time for a given lease.
 */
function createRrcLeaseDid(district: string, leaseNumber: string): string {
  const input = `rrc-lease:${district}:${leaseNumber}`;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `rrclease_${hash}`;
}

/**
 * Create well DID from API number.
 *
 * Format: well_<hash(apiNumber)>
 *
 * Per ADR-025, the well is the regulatory reporting unit for gas production.
 * The DID is stable across time for a given API number.
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
