/**
 * RRC H-10 (Annual Disposal/Injection Well Monitoring) adapter types.
 *
 * The H-10 form tracks injection and disposal volumes for saltwater disposal
 * (SWD) wells and enhanced recovery injection wells. Per ADR-025, injection
 * volumes are reported at the well level (similar to gas production).
 */

/**
 * H-10 query parameters. Supports filtering by district, operator, or well.
 */
export interface H10QueryParams {
  /** RRC district code (e.g., "08" for Reeves). */
  district?: string;
  /** API number (10-digit well identifier). */
  apiNumber?: string;
  /** Operator number. */
  operatorNumber?: string;
  /** Start month for injection data (YYYY-MM format). */
  fromMonth: string;
  /** End month for injection data (YYYY-MM format). */
  toMonth: string;
  /** Maximum results to fetch. Defaults to 1000. */
  maxResults?: number;
}

/**
 * Raw injection/disposal record (well-level) from H-10.
 */
export interface RawH10InjectionRecord {
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
  /** Injection well type (e.g., "SWD", "EOR-GAS", "EOR-WATER"). */
  injectionType: string;
  /** Reporting month (YYYY-MM format). */
  month: string;
  /** Injected volume (barrels for water/SWD, MCF for gas). */
  volume: number;
  /** Unit of measure ("BBL" or "MCF"). */
  unit: string;
}

/**
 * H-10 fetch result for injection/disposal data.
 */
export interface H10FetchResult {
  records: ReadonlyArray<RawH10InjectionRecord>;
  queryParams: H10QueryParams;
  sourceUrl: string;
  fetchedAt: string;
  totalCount: number;
}
