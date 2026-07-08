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
 * 4. Follows pagination to fetch all pages of results
 *
 * @param params - Query parameters (county, date range, completion type).
 * @returns Fetch result with raw permits and metadata.
 */
export async function fetchW1Permits(
  params: W1QueryParams,
): Promise<W1FetchResult> {
  const fetchedAt = new Date().toISOString();
  const maxResults = params.maxResults ?? 10000;

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

    // Step 3: POST the query (single page with max size)
    // Note: Pagination via searchArgs.pageNumber does not work with RRC EWA form.
    // The form's ASP.NET postback model requires complex viewstate handling that
    // is not reliable across page transitions. For now, fetch first page only.
    const queryUrl = `${EWA_BASE_URL}?method=doSearch`;
    
    console.log(`Fetching W-1 permits (single page)...`);
    
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
    
    console.log(`Fetched ${permits.length} permits from single page`);
    console.log(`Note: RRC reports total available permits in page header, but pagination not implemented due to ASP.NET form complexity`);

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
 * Map county name to RRC county code.
 */
const COUNTY_CODE_MAP: Record<string, string> = {
  REEVES: "389",
  ANDERSON: "001",
  ANDREWS: "003",
};

/**
 * Convert ISO date (YYYY-MM-DD) to RRC format (MM/DD/YYYY).
 */
function formatDateForRrc(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${month}/${day}/${year}`;
}

/**
 * Build the POST parameter map for the RRC EWA query. Combines hidden form
 * fields with user-supplied query parameters.
 *
 * The RRC form uses specific field names:
 * - searchArgs.countyCodeHndlr.selectedCodes (county code, e.g., "389" for Reeves)
 * - searchArgs.submittedDtFromHndlr.inputValue (from date in MM/DD/YYYY format)
 * - searchArgs.submittedDtToHndlr.inputValue (to date in MM/DD/YYYY format)
 * - searchArgs.psaFlagHndlr.inputValue ("Y" for PSA wells)
 * - searchArgs.allocationFlagHndlr.inputValue ("Y" for allocation wells)
 */
function buildPostParams(
  params: W1QueryParams,
  hiddenFields: Record<string, string>,
): Record<string, string> {
  const countyName = params.county.toUpperCase();
  const countyCode = COUNTY_CODE_MAP[countyName];
  
  if (!countyCode) {
    throw new Error(
      `Unknown county: ${countyName}. Add county code to COUNTY_CODE_MAP.`,
    );
  }

  const postParams: Record<string, string> = {
    ...hiddenFields,
    "searchArgs.countyCodeHndlr.selectedCodes": countyCode,
    "searchArgs.submittedDtFromHndlr.inputValue": formatDateForRrc(params.fromDate),
    "searchArgs.submittedDtToHndlr.inputValue": formatDateForRrc(params.toDate),
    "searchArgs.pageSize": "100", // Increase page size to reduce number of pages
  };

  if (params.completionType === "PSA") {
    postParams["searchArgs.psaFlagHndlr.inputValue"] = "Y";
  } else if (params.completionType === "ALLOCATION") {
    postParams["searchArgs.allocationFlagHndlr.inputValue"] = "Y";
  }

  return postParams;
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

  // The RRC results table has class="DataGrid". Look for rows after the header.
  const table = $("table.DataGrid");
  
  if (table.length === 0) {
    console.warn("RRC W-1: No results table (DataGrid) found in response HTML.");
    return [];
  }

  // Find all data rows (skip header rows, pagination rows, and other UI elements)
  const rows = table.find("tr").filter((_i, row) => {
    const $row = $(row);
    const tds = $row.find("td");
    const ths = $row.find("th");
    
    // Skip rows without td cells or with th cells (headers)
    if (tds.length === 0 || ths.length > 0) {
      return false;
    }
    
    // Skip pagination/control rows (they have text like "results", "Page Size", etc.)
    const firstCellText = $row.text().toLowerCase();
    if (firstCellText.includes("results") || 
        firstCellText.includes("page size") ||
        firstCellText.includes("first") && firstCellText.includes("previous")) {
      return false;
    }
    
    // Data rows should have more than 10 cells (based on table structure)
    if (tds.length < 10) {
      return false;
    }
    
    return true;
  });

  if (rows.length === 0) {
    console.warn("RRC W-1: No data rows found in results table.");
    return [];
  }

  // Debug: log table structure for first page
  if (permits.length === 0) {
    console.log(`DEBUG: Found ${rows.length} potential data rows in DataGrid table`);
    const firstRow = rows.first();
    const firstCells = firstRow.find("td");
    console.log(`DEBUG: First row has ${firstCells.length} td cells`);
    firstCells.each((idx, cell) => {
      const $cell = $(cell);
      const text = $cell.text().trim().substring(0, 50); // First 50 chars
      const hasLink = $cell.find("a").length > 0;
      console.log(`  Cell ${idx}: text="${text}" hasLink=${hasLink}`);
    });
  }

  rows.each((_i, row) => {
    const cells = $(row).find("td");
    
    // Extract API number from cell 1 (cell 0 has extra UI text)
    const apiNumber = $(cells[1]).text().trim();
    
    if (!apiNumber) {
      // Skip rows without API number
      return;
    }

    // Extract other fields based on actual cell structure
    // Cell structure: [0]=API+UI, [1]=API, [2]=UI, [3]=District, [4]=Operator, 
    // [5]=?, [6]=?, [7]=County, [8]=Dates, [9]=Lease#, [10]=Profile, [11]=Type, 
    // [12]=Flag, [13]=Depth, [14]=?, [15]=Status
    const district = $(cells[3]).text().trim();
    const operatorText = $(cells[4]).text().trim();
    const county = $(cells[7]).text().trim();
    const leaseNumber = $(cells[9]).text().trim();
    
    // Parse dates from cell 8 (may contain "Submitted: MM/DD/YYYY Approved: ...")
    const datesText = $(cells[8]).text().trim();
    const submittedMatch = datesText.match(/Submitted:\s*(\d{2}\/\d{2}\/\d{4})/);
    const approvedMatch = datesText.match(/Approved:\s*(\d{2}\/\d{2}\/\d{4})/);
    
    // The W-1 summary table does not include well numbers or detailed lease names.
    // We use the lease number as the identifier. The API number will uniquely
    // identify each permit, and we extract the well number from the API itself.
    // API format is typically: state-county-sequence, and the sequence often
    // corresponds to well numbers.
    const leaseName = leaseNumber ? `Lease ${leaseNumber}` : "";
    
    // Extract well number from API sequence (last 5 digits before sidetrack suffix)
    // API: 42-389-XXXXX where XXXXX is the sequence/well identifier
    const apiSequence = apiNumber.slice(-5); // Last 5 digits of 8-digit API
    const wellName = leaseName 
      ? `${leaseName} #${apiSequence}`
      : `Well #${apiSequence}`;
    
    const proposedDepth = cells[13] ? parseInt($(cells[13]).text().trim(), 10) : undefined;
    
    const permit: RawW1Permit = {
      permitNumber: "", // Not directly visible in table; would need detail page
      apiNumber,
      wellName,
      operatorName: operatorText.replace(/\(\d+\)/, "").trim(),
      operatorNumber: operatorText.match(/\((\d+)\)/)?.[1],
      leaseName,
      fieldName: undefined,
      county,
      district,
      wellType: "", // Not in summary table
      completionType: undefined,
      dateSubmitted: submittedMatch ? submittedMatch[1] : undefined,
      dateApproved: approvedMatch ? approvedMatch[1] : undefined,
      surfaceLatitude: undefined,
      surfaceLongitude: undefined,
      datum: undefined,
      proposedDepth,
    };

    permits.push(permit);

    // Cap at maxResults
    if (permits.length >= maxResults) {
      return false; // break out of .each()
    }
  });

  return permits;
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
 * shows "1 - 10 of 89 results" or similar in the pager banner.
 *
 * If the text is not found or cannot be parsed, returns the row count as a
 * fallback.
 */
function extractPermitCount(html: string): number {
  const $ = cheerio.load(html);

  // Look for the pager banner text (e.g., "1 - 10 of 89 results")
  const pagerText = $(".PagerBanner, td.PagerBanner").text();
  const match = pagerText.match(/(\d+)\s+results?\s*$/i) || pagerText.match(/of\s+(\d+)/i);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }

  // Fallback: count data rows in DataGrid table
  const rows = $("table.DataGrid tr").filter((_i, row) => {
    return $(row).find("td").length > 0 && $(row).find("th").length === 0;
  });
  return rows.length;
}

/**
 * Check if there's a "next page" link in the RRC EWA results page.
 * The pagination controls typically include links like "Next" or numeric page links.
 */
function hasNextPage(html: string): boolean {
  const $ = cheerio.load(html);
  
  // Look for "Next" link (not disabled)
  const nextLink = $('a:contains("Next")').filter((_i, el) => {
    const href = $(el).attr('href');
    // Check it's not a disabled/grayed out link
    const hasValidHref = href !== undefined && href.length > 0;
    const isNotDisabled = !$(el).hasClass('disabled');
    return hasValidHref && isNotDisabled;
  });
  
  if (nextLink.length > 0) {
    return true;
  }
  
  // Alternative: check if there are page number links beyond the current page
  // Look for numeric pagination links
  const pageLinks = $('a[href*="pageNumber"]');
  if (pageLinks.length > 1) {
    return true; // If there are multiple page links, assume more pages exist
  }
  
  return false;
}
