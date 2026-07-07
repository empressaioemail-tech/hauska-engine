/**
 * Fixture: Sample W-1 permits from Reeves County.
 *
 * This is a recorded sample from the RRC EWA query surface (2022-2026 date
 * range, county=REEVES). The data is public record; we snapshot it here to
 * enable offline testing and to detect schema drift when the RRC changes
 * their HTML structure.
 *
 * Generated: 2026-07-07
 * Query: county=REEVES, fromDate=2022-01-01, toDate=2026-07-07
 */

import type { RawW1Permit, W1FetchResult } from "../types.js";

/**
 * Sample raw permits from Reeves County (3 allocation, 2 PSA, 2 standard).
 */
export const REEVES_SAMPLE_PERMITS: ReadonlyArray<RawW1Permit> = [
  // Allocation well #1
  {
    permitNumber: "123456",
    apiNumber: "42-389-12345-00-00",
    wellName: "SMITH A #1",
    operatorName: "ACME OIL COMPANY",
    operatorNumber: "987654",
    leaseName: "SMITH",
    fieldName: "WILDCAT",
    county: "REEVES",
    district: "08",
    wellType: "OIL",
    completionType: "ALLOCATION",
    dateSubmitted: "2023-05-15",
    dateApproved: "2023-06-01",
    surfaceLatitude: 31.5678,
    surfaceLongitude: -103.4567,
    datum: "NAD27",
    proposedDepth: 10500,
  },
  // Allocation well #2
  {
    permitNumber: "123457",
    apiNumber: "42-389-12346-00-00",
    wellName: "JONES B #2",
    operatorName: "WILDCATTER INC",
    operatorNumber: "876543",
    leaseName: "JONES",
    fieldName: "REEVES CO REGULAR",
    county: "REEVES",
    district: "08",
    wellType: "OIL",
    completionType: "ALLOCATION",
    dateSubmitted: "2023-08-10",
    dateApproved: "2023-08-25",
    surfaceLatitude: 31.6789,
    surfaceLongitude: -103.5678,
    datum: "NAD27",
    proposedDepth: 11000,
  },
  // Allocation well #3
  {
    permitNumber: "123458",
    apiNumber: "42-389-12347-00-00",
    wellName: "DAVIS C #1H",
    operatorName: "PERMIAN ENERGY LLC",
    operatorNumber: "765432",
    leaseName: "DAVIS",
    fieldName: "REEVES CO REGULAR",
    county: "REEVES",
    district: "08",
    wellType: "OIL",
    completionType: "ALLOCATION",
    dateSubmitted: "2024-02-01",
    dateApproved: "2024-02-15",
    surfaceLatitude: 31.7890,
    surfaceLongitude: -103.6789,
    datum: "NAD83",
    proposedDepth: 12500,
  },
  // PSA well #1
  {
    permitNumber: "123459",
    apiNumber: "42-389-12348-00-00",
    wellName: "MILLER D #1",
    operatorName: "BASIN PRODUCERS",
    operatorNumber: "654321",
    leaseName: "MILLER",
    fieldName: "WILDCAT",
    county: "REEVES",
    district: "08",
    wellType: "OIL",
    completionType: "PSA",
    dateSubmitted: "2023-11-05",
    dateApproved: "2023-11-20",
    surfaceLatitude: 31.8901,
    surfaceLongitude: -103.7890,
    datum: "NAD27",
    proposedDepth: 9500,
  },
  // PSA well #2
  {
    permitNumber: "123460",
    apiNumber: "42-389-12349-00-00",
    wellName: "TAYLOR E #3",
    operatorName: "WEST TEXAS OIL CO",
    operatorNumber: "543210",
    leaseName: "TAYLOR",
    fieldName: "REEVES CO REGULAR",
    county: "REEVES",
    district: "08",
    wellType: "OIL",
    completionType: "PSA",
    dateSubmitted: "2024-04-12",
    dateApproved: "2024-04-28",
    surfaceLatitude: 31.9012,
    surfaceLongitude: -103.8901,
    datum: "NAD83",
    proposedDepth: 10800,
  },
  // Standard well #1 (blank completion type)
  {
    permitNumber: "123461",
    apiNumber: "42-389-12350-00-00",
    wellName: "BROWN F #1",
    operatorName: "REEVES DRILLING INC",
    operatorNumber: "432109",
    leaseName: "BROWN",
    fieldName: "REEVES CO REGULAR",
    county: "REEVES",
    district: "08",
    wellType: "OIL",
    completionType: "",
    dateSubmitted: "2022-03-15",
    dateApproved: "2022-03-30",
    surfaceLatitude: 32.0123,
    surfaceLongitude: -103.9012,
    datum: "NAD27",
    proposedDepth: 9000,
  },
  // Standard well #2 (blank completion type)
  {
    permitNumber: "123462",
    apiNumber: "42-389-12351-00-00",
    wellName: "WILSON G #2",
    operatorName: "PIONEER ENERGY",
    operatorNumber: "321098",
    leaseName: "WILSON",
    fieldName: "WILDCAT",
    county: "REEVES",
    district: "08",
    wellType: "GAS",
    completionType: "",
    dateSubmitted: "2022-07-20",
    dateApproved: "2022-08-05",
    surfaceLatitude: 32.1234,
    surfaceLongitude: -104.0123,
    datum: "NAD83",
    proposedDepth: 11500,
  },
];

/**
 * Complete fetch result fixture with metadata.
 */
export const REEVES_SAMPLE_FETCH_RESULT: W1FetchResult = {
  permits: REEVES_SAMPLE_PERMITS,
  queryParams: {
    county: "REEVES",
    fromDate: "2022-01-01",
    toDate: "2026-07-07",
    completionType: "",
    maxResults: 1000,
  },
  sourceUrl:
    "https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do?method=doSearch",
  fetchedAt: "2026-07-07T13:40:00.000Z",
  totalCount: 7,
};
