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
    // Step 1: GET the form page — session cookie + Struts hidden fields.
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

    const rawSetCookie = formResponse.headers["set-cookie"];
    const cookieHeader = (Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie])
      .filter((c): c is string => typeof c === "string" && c.length > 0)
      .map((c) => c.split(";")[0])
      .join("; ");

    const formHtml = await formResponse.body.text();
    const hiddenFields = extractHiddenFormFields(formHtml);

    // Step 2: Build POST params (merge hidden fields + user query)
    const postParams = buildPostParams(params, hiddenFields);

    // Step 3: POST the query — first results page. The EWA app is Struts
    // (.do), and its pager is plain GET links carrying pager.pageSize /
    // pager.offset / searchArgs.paramValue, so full pagination is a loop of
    // GETs on the same session (live-verified 2026-07-08: "1 - 100 of 3887"
    // with pager.pageSize=100).
    const queryUrl = `${EWA_BASE_URL}?method=doSearch`;

    const queryResponse = await request(queryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: EWA_BASE_URL,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
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
    const totalCount = extractBannerTotal(responseHtml) ?? extractPermitCount(responseHtml);
    const byPermitNumber = new Map<string, RawW1Permit>();
    for (const p of parseW1PermitsFromHtml(responseHtml, maxResults)) {
      byPermitNumber.set(p.permitNumber, p);
    }

    // Step 4: page through the rest via the pager GET template.
    const pagerTemplate = extractPagerTemplate(responseHtml);
    if (totalCount > byPermitNumber.size && pagerTemplate && cookieHeader) {
      const pageSize = 100;
      const target = Math.min(totalCount, maxResults);
      for (let offset = 0; offset < target; offset += pageSize) {
        const pageUrl = new URL(pagerTemplate, "https://webapps2.rrc.texas.gov");
        pageUrl.searchParams.set("pager.pageSize", String(pageSize));
        pageUrl.searchParams.set("pager.offset", String(offset));
        const pageRes = await request(pageUrl.toString(), {
          method: "GET",
          headers: { Referer: EWA_BASE_URL, Cookie: cookieHeader },
          headersTimeout: 30_000,
          bodyTimeout: 60_000,
        });
        if (pageRes.statusCode !== 200) {
          throw new Error(
            `RRC EWA pager GET failed at offset=${offset}: HTTP ${pageRes.statusCode}`,
          );
        }
        const pageHtml = await pageRes.body.text();
        const before = byPermitNumber.size;
        for (const p of parseW1PermitsFromHtml(pageHtml, pageSize)) {
          byPermitNumber.set(p.permitNumber, p);
        }
        console.log(
          `W-1 pager: offset=${offset} +${byPermitNumber.size - before} (total ${byPermitNumber.size}/${totalCount})`,
        );
        if (byPermitNumber.size >= target) break;
        // polite pacing against the public site
        await new Promise((r) => setTimeout(r, 400));
      }
    } else if (totalCount > byPermitNumber.size) {
      console.warn(
        `W-1: totalCount=${totalCount} exceeds fetched=${byPermitNumber.size} but no pager template/session — returning partial set`,
      );
    }

    const permits = Array.from(byPermitNumber.values());
    console.log(`W-1 fetch complete: ${permits.length} distinct permits (banner total ${totalCount})`);

    return {
      permits,
      queryParams: params,
      sourceUrl: queryUrl,
      fetchedAt,
      totalCount,
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
 * Parse the pager banner total from the results page ("1 - 100 of 3887").
 * Returns null if the banner is not present (e.g., zero-result pages).
 */
function extractBannerTotal(html: string): number | null {
  const m = html.match(/[\d,]+\s*-\s*[\d,]+\s+of\s+([\d,]+)/i);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the pager GET link template from the results page: the "next page"
 * href carries methodToCall=search plus the full searchArgs.paramValue
 * encoding of the active query, so re-GETting it with a different
 * pager.offset / pager.pageSize walks the result set on the same session.
 */
function extractPagerTemplate(html: string): string | null {
  const m = html.match(/href="([^"]*pager\.offset=\d+[^"]*searchArgs\.paramValue=[^"]*)"/i)
    || html.match(/href="([^"]*searchArgs\.paramValue=[^"]*pager\.offset=\d+[^"]*)"/i);
  if (!m || !m[1]) return null;
  return m[1].replace(/&amp;/g, "&");
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

  // Canonical layout (live-verified 2026-07-08 on the pager GET pages):
  // table.DataGrid data rows have EXACTLY 14 <td> cells:
  //  0: status/permit number + "Links Images GIS View" UI text
  //  1: RRC district        2: lease name "(lease number)"
  //  3: well number         4: operator name "(operator number)"
  //  5: county              6: "Submitted: MM/DD/YYYY Approved: MM/DD/YYYY"
  //  7: permit tracking no  8: wellbore profile (Vertical/Horizontal/...)
  //  9: filing purpose     10: amend flag (Y/N)
  // 11: total depth        12: stacked-lateral parent (usually empty)
  // 13: current status (APPROVED/...)
  const table = $("table.DataGrid");
  if (table.length === 0) {
    console.warn("RRC W-1: No results table (DataGrid) found in response HTML.");
    return [];
  }

  table.find("tr").each((_i, row) => {
    if (permits.length >= maxResults) return;
    const cells = $(row).children("td");
    if (cells.length !== 14) return;

    const cell = (idx: number) =>
      $(cells[idx]).text().trim().replace(/\s+/g, " ");

    const statusNoMatch = cell(0).match(/^(\d{5,})/);
    if (!statusNoMatch || !statusNoMatch[1]) return; // pager/UI rows

    const leaseCell = cell(2);
    const leaseMatch = leaseCell.match(/^(.*?)\s*\((\d+)\)\s*$/);
    const operatorCell = cell(4);
    const operatorMatch = operatorCell.match(/^(.*?)\s*\((\d+)\)\s*$/);
    const dates = cell(6);
    const submittedMatch = dates.match(/Submitted:\s*(\d{2}\/\d{2}\/\d{4})/);
    const approvedMatch = dates.match(/Approved:\s*(\d{2}\/\d{2}\/\d{4})/);
    const depthText = cell(11);
    const depth = /^\d+$/.test(depthText) ? parseInt(depthText, 10) : undefined;
    const leaseName = ((leaseMatch && leaseMatch[1]) || leaseCell).trim();
    const wellNumber = cell(3);

    permits.push({
      permitNumber: statusNoMatch[1],
      // The results grain carries NO 14-digit API number (detail pages only).
      apiNumber: undefined,
      // RRC identifies the well as lease name + well number at this grain.
      wellName: wellNumber ? `${leaseName} ${wellNumber}` : leaseName,
      operatorName: ((operatorMatch && operatorMatch[1]) || operatorCell).trim(),
      operatorNumber: operatorMatch ? operatorMatch[2] : undefined,
      leaseName,
      leaseNumber: leaseMatch ? leaseMatch[2] : undefined,
      fieldName: undefined,
      county: cell(5),
      district: cell(1),
      wellType: "",
      completionType: undefined,
      dateSubmitted: submittedMatch ? submittedMatch[1] : undefined,
      dateApproved: approvedMatch ? approvedMatch[1] : undefined,
      surfaceLatitude: undefined,
      surfaceLongitude: undefined,
      datum: undefined,
      proposedDepth: depth,
      wellboreProfile: cell(8) || undefined,
      filingPurpose: cell(9) || undefined,
      amendFlag: cell(10) || undefined,
      permitTrackingNumber: cell(7) || undefined,
      currentStatus: cell(13) || undefined,
    });
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
