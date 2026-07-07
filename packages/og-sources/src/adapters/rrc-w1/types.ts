/**
 * RRC W-1 Drilling Permit adapter types.
 *
 * The W-1 is the drilling permit application form in Texas. This adapter
 * fetches drilling permits from the RRC's public EWA query surface
 * (https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do) and
 * normalizes them into well atoms per @empressaio/atom-contract/og.
 *
 * County-parameterized; defaults to Reeves County (the C3a deliverable).
 */

/**
 * W-1 query parameters for the RRC EWA form. Maps to the ASP.NET form fields
 * the EWA endpoint expects.
 */
export interface W1QueryParams {
  /** County name (e.g., "REEVES"). */
  county: string;
  /** Start date for submitted/approved permits (ISO-8601 format YYYY-MM-DD). */
  fromDate: string;
  /** End date for submitted/approved permits (ISO-8601 format YYYY-MM-DD). */
  toDate: string;
  /**
   * Wellbore Profile/Completion Type filter. Values include:
   * - "ALLOCATION" (allocation wells)
   * - "PSA" (Production Sharing Agreement)
   * - "" (blank = all permits, unfiltered)
   */
  completionType?: string;
  /** Maximum results to fetch. Defaults to 1000. */
  maxResults?: number;
}

/**
 * Raw W-1 permit record as extracted from RRC EWA response. Field names
 * mirror the RRC's own column labels (to ease debugging against the live
 * site).
 */
export interface RawW1Permit {
  /** RRC-assigned permit number (unique identifier). */
  permitNumber: string;
  /** API number (14-digit well identifier). */
  apiNumber: string;
  /** Well name. */
  wellName: string;
  /** Operator name. */
  operatorName: string;
  /** Operator number (RRC identifier). */
  operatorNumber?: string;
  /** Lease name. */
  leaseName: string;
  /** Field name. */
  fieldName?: string;
  /** County. */
  county: string;
  /** RRC district. */
  district: string;
  /** Well type (e.g., "OIL", "GAS", "INJECTION"). */
  wellType: string;
  /** Completion type (e.g., "ALLOCATION", "PSA", "STANDARD", or blank). */
  completionType?: string;
  /** Date permit was submitted (ISO-8601 string). */
  dateSubmitted?: string;
  /** Date permit was approved (ISO-8601 string). */
  dateApproved?: string;
  /** Surface latitude (decimal degrees). */
  surfaceLatitude?: number;
  /** Surface longitude (decimal degrees). */
  surfaceLongitude?: number;
  /** Datum (e.g., "NAD27", "NAD83", "WGS84"). */
  datum?: string;
  /** Total proposed depth (feet). */
  proposedDepth?: number;
}

/**
 * Fetch result from RRC W-1 query. Carries the raw permits plus metadata
 * for provenance tracking.
 */
export interface W1FetchResult {
  /** Array of raw permit records. */
  permits: ReadonlyArray<RawW1Permit>;
  /** Query parameters used (for reproducibility). */
  queryParams: W1QueryParams;
  /** Source URL that was queried. */
  sourceUrl: string;
  /** ISO-8601 timestamp when the fetch completed. */
  fetchedAt: string;
  /** Total count returned by RRC (may exceed permits.length if capped). */
  totalCount: number;
}

/**
 * Adapter capability descriptor.
 */
export interface RrcW1AdapterCapabilities {
  name: string;
  displayName: string;
  sourceFamilies: ReadonlyArray<string>;
  supportsCountyFilter: boolean;
  supportsCompletionTypeFilter: boolean;
}
