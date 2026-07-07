/**
 * RRC PDQ (Production Data Query) adapter types.
 *
 * The PDQ surface (https://webapps2.rrc.texas.gov/PDQ) exposes monthly
 * production volumes with the Texas reporting split:
 * - Oil production: reported at LEASE level
 * - Gas production: reported at WELL level
 *
 * Per ADR-025, this grain difference MUST be modeled explicitly in the atoms:
 * oil streams anchor to rrc-lease, gas streams anchor to well.
 */

/**
 * PDQ query parameters. Supports filtering by district, lease, or well.
 */
export interface PdqQueryParams {
  /** RRC district code (e.g., "08" for Reeves). */
  district?: string;
  /** RRC lease number (for oil/lease-level queries). */
  leaseNumber?: string;
  /** API number (for gas/well-level queries). */
  apiNumber?: string;
  /** Start month for production data (YYYY-MM format). */
  fromMonth: string;
  /** End month for production data (YYYY-MM format). */
  toMonth: string;
  /** Maximum results to fetch. Defaults to 1000. */
  maxResults?: number;
}

/**
 * Raw oil production record (lease-level) from PDQ.
 */
export interface RawOilProductionRecord {
  /** RRC district code. */
  district: string;
  /** RRC lease number. */
  leaseNumber: string;
  /** Lease name. */
  leaseName: string;
  /** Operator name. */
  operatorName: string;
  /** Operator number. */
  operatorNumber?: string;
  /** Production month (YYYY-MM format). */
  month: string;
  /** Oil volume (barrels). */
  oilVolume: number;
  /** Condensate volume (barrels), if reported separately. */
  condensateVolume?: number;
}

/**
 * Raw gas production record (well-level) from PDQ.
 */
export interface RawGasProductionRecord {
  /** RRC district code. */
  district: string;
  /** API number (10-digit well identifier). */
  apiNumber: string;
  /** Well name. */
  wellName: string;
  /** Operator name. */
  operatorName: string;
  /** Operator number. */
  operatorNumber?: string;
  /** Production month (YYYY-MM format). */
  month: string;
  /** Gas volume (MCF). */
  gasVolume: number;
  /** Casinghead gas volume (MCF), if reported separately. */
  casingheadVolume?: number;
}

/**
 * PDQ fetch result for oil production (lease-level).
 */
export interface PdqOilFetchResult {
  records: ReadonlyArray<RawOilProductionRecord>;
  queryParams: PdqQueryParams;
  sourceUrl: string;
  fetchedAt: string;
  totalCount: number;
}

/**
 * PDQ fetch result for gas production (well-level).
 */
export interface PdqGasFetchResult {
  records: ReadonlyArray<RawGasProductionRecord>;
  queryParams: PdqQueryParams;
  sourceUrl: string;
  fetchedAt: string;
  totalCount: number;
}
