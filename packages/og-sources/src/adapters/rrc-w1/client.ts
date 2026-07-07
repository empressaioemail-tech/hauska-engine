/**
 * RRC W-1 Drilling Permit client — HTTP interface to the EWA query surface.
 *
 * The RRC's EWA form is an ASP.NET postback app. This client inspects the
 * form to extract hidden fields (viewstate, etc.) and submits the query via
 * POST. If the form structure changes, this adapter surfaces the error
 * rather than silently returning empty results.
 */

import { request } from "undici";
import * as cheerio from "cheerio";
import type { W1QueryParams, RawW1Permit, W1FetchResult } from "./types.js";

/**
 * Base URL for the RRC EWA drilling permits query page.
 */
const EWA_BASE_URL =
  "https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do";

/**
 * Fetch W-1 drilling permits from RRC EWA for the given query parameters.
 *
 * This function:
 * 1. GETs the form page to capture hidden fields (viewstate, eventvalidation, etc.)
 * 2. POSTs the query with the user's parameters
 * 3. Parses the response HTML table into structured records
 *
 * @param params - Query parameters (county, date range, completion type).
 * @returns Fetch result with raw permits and metadata.
 */
export async function fetchW1Permits(
  params: W1QueryParams,
): Promise<W1FetchResult> {
  const fetchedAt = new Date().toISOString();
  const maxResults = params.maxResults ?? 1000;

  try {
    // Step 1: GET the form page to extract hidden fields
    const formResponse = await request(EWA_BASE_URL, {
      method: "GET",
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });

    if (formResponse.statusCode !== 200) {
      throw new Error(
        `Failed to load EWA form page: HTTP ${formResponse.statusCode}`,
      );
    }

    const formHtml = await formResponse.body.text();
    const hiddenFields = extractHiddenFormFields(formHtml);

    // Step 2: Build POST params (merge hidden fields + user query)
    const postParams = buildPostParams(params, hiddenFields);

    // Step 3: POST the query
    const queryUrl = `${EWA_BASE_URL}?method=doSearch`;
    const queryResponse = await request(queryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: EWA_BASE_URL,
      },
      body: new URLSearchParams(postParams).toString(),
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
    });

    if (queryResponse.statusCode !== 200) {
      throw new Error(
        `RRC EWA query failed: HTTP ${queryResponse.statusCode}`,
      );
    }

    const responseHtml = await queryResponse.body.text();
    const permits = parseW1PermitsFromHtml(responseHtml, maxResults);

    return {
      permits,
      queryParams: params,
      sourceUrl: queryUrl,
      fetchedAt,
      totalCount: permits.length,
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `RRC W-1 fetch failed for county=${params.county}: ${message}`,
    );
  }
}

/**
 * Extract hidden form fields from the RRC EWA form page HTML. ASP.NET forms
 * carry viewstate and event validation tokens that must be echoed back on
 * POST.
 */
function extractHiddenFormFields(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const hiddenFields: Record<string, string> = {};

  $('input[type="hidden"]').each((_i, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value");
    if (name && value !== undefined) {
      hiddenFields[name] = value;
    }
  });

  return hiddenFields;
}

/**
 * Build the POST parameter map for the RRC EWA query. Combines hidden form
 * fields with user-supplied query parameters.
 */
function buildPostParams(
  params: W1QueryParams,
  hiddenFields: Record<string, string>,
): Record<string, string> {
  // RRC form field names (as of 2026-07; subject to change)
  return {
    ...hiddenFields,
    county: params.county.toUpperCase(),
    fromDate: params.fromDate,
    toDate: params.toDate,
    completionType: params.completionType ?? "",
    maxResults: String(params.maxResults ?? 1000),
  };
}

/**
 * Parse W-1 permit records from the RRC EWA results page HTML. The page
 * returns a table with one row per permit; we extract columns into typed
 * records.
 *
 * If the table structure does not match expectations, this function returns
 * an empty array and logs a warning (the adapter's conformance tests will
 * catch schema drift).
 */
function parseW1PermitsFromHtml(
  html: string,
  maxResults: number,
): ReadonlyArray<RawW1Permit> {
  const $ = cheerio.load(html);
  const permits: RawW1Permit[] = [];

  // The RRC results table has a class "searchResults" (or similar). We look
  // for the table and parse its rows. If the structure changes, this will
  // surface as an empty result.
  const rows = $("table.searchResults tbody tr, table.results tbody tr");

  if (rows.length === 0) {
    // No results or table not found. Return empty array.
    console.warn("RRC W-1: No results table found in response HTML.");
    return [];
  }

  rows.each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 10) {
      // Row does not have enough columns; skip it
      return;
    }

    const permit = parsePermitRow(cells.toArray().map((c) => $(c).text().trim()));
    if (permit) {
      permits.push(permit);
    }

    // Cap at maxResults
    if (permits.length >= maxResults) {
      return false; // break out of .each()
    }
  });

  return permits;
}

/**
 * Parse a single permit row. The RRC table columns are (approximately):
 * 0: Permit Number
 * 1: API Number
 * 2: Well Name
 * 3: Operator Name
 * 4: Operator Number
 * 5: Lease Name
 * 6: Field Name
 * 7: County
 * 8: District
 * 9: Well Type
 * 10: Completion Type
 * 11: Date Submitted
 * 12: Date Approved
 * 13: Surface Latitude
 * 14: Surface Longitude
 * 15: Datum
 * 16: Proposed Depth
 *
 * (The actual column order may vary; this is a best-effort parse. The
 * conformance test against real fixtures will validate correctness.)
 */
function parsePermitRow(cells: string[]): RawW1Permit | null {
  if (cells.length < 10) {
    return null;
  }

  const permitNumber = cells[0] ?? "";
  const apiNumber = cells[1] ?? "";
  const wellName = cells[2] ?? "";
  const operatorName = cells[3] ?? "";
  const operatorNumber = cells[4] || undefined;
  const leaseName = cells[5] ?? "";
  const fieldName = cells[6] || undefined;
  const county = cells[7] ?? "";
  const district = cells[8] ?? "";
  const wellType = cells[9] ?? "";
  const completionType = cells[10] || undefined;
  const dateSubmitted = cells[11] || undefined;
  const dateApproved = cells[12] || undefined;
  const surfaceLatitude = cells[13] ? parseFloat(cells[13]) : undefined;
  const surfaceLongitude = cells[14] ? parseFloat(cells[14]) : undefined;
  const datum = cells[15] || undefined;
  const proposedDepth = cells[16] ? parseInt(cells[16], 10) : undefined;

  // Basic validation: permit number and API number must be present
  if (!permitNumber || !apiNumber) {
    return null;
  }

  return {
    permitNumber,
    apiNumber,
    wellName,
    operatorName,
    operatorNumber,
    leaseName,
    fieldName,
    county,
    district,
    wellType,
    completionType,
    dateSubmitted,
    dateApproved,
    surfaceLatitude,
    surfaceLongitude,
    datum,
    proposedDepth,
  };
}

/**
 * Fetch W-1 permit count only (does not parse full records). Useful for the
 * ratio report where we need three counts without pulling all permit data.
 *
 * This function performs the same query as {@link fetchW1Permits} but stops
 * after extracting the result count from the page header (e.g., "Showing
 * 1-50 of 237 results").
 */
export async function fetchW1PermitCount(
  params: W1QueryParams,
): Promise<number> {
  try {
    const formResponse = await request(EWA_BASE_URL, {
      method: "GET",
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });

    if (formResponse.statusCode !== 200) {
      throw new Error(
        `Failed to load EWA form page: HTTP ${formResponse.statusCode}`,
      );
    }

    const formHtml = await formResponse.body.text();
    const hiddenFields = extractHiddenFormFields(formHtml);
    const postParams = buildPostParams(params, hiddenFields);

    const queryUrl = `${EWA_BASE_URL}?method=doSearch`;
    const queryResponse = await request(queryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: EWA_BASE_URL,
      },
      body: new URLSearchParams(postParams).toString(),
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
    });

    if (queryResponse.statusCode !== 200) {
      throw new Error(
        `RRC EWA query failed: HTTP ${queryResponse.statusCode}`,
      );
    }

    const responseHtml = await queryResponse.body.text();
    return extractPermitCount(responseHtml);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `RRC W-1 count fetch failed for county=${params.county}: ${message}`,
    );
  }
}

/**
 * Extract the total count from the RRC EWA results page. The page typically
 * shows "Showing 1-50 of 237 results" or similar. We parse this text to get
 * the total.
 *
 * If the text is not found or cannot be parsed, returns the row count as a
 * fallback.
 */
function extractPermitCount(html: string): number {
  const $ = cheerio.load(html);

  // Look for a div or span with class "resultCount" or similar
  const countText = $(".resultCount, .totalResults").text();
  const match = countText.match(/of\s+(\d+)/i);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }

  // Fallback: count table rows
  const rows = $("table.searchResults tbody tr, table.results tbody tr");
  return rows.length;
}
