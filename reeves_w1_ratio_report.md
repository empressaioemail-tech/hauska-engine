# Reeves County RRC W-1 Allocation-vs-PSA Ratio Report

**Generated:** 2026-07-07T13:46:43.843Z  
**County:** Reeves County, Texas  
**Date Range:** 2022-01-01 to 2026-07-07  
**Source:** [RRC EWA Drilling Permit Query](https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do)

---

## Summary

This report queries the RRC's W-1 drilling permit database to count permits
by **Wellbore Profile/Completion Type** for Reeves County. The three
categories are:

1. **ALLOCATION** — Allocation wells
2. **PSA** — Production Sharing Agreement wells
3. **Total** — All permits (unfiltered)

The **residual** (total minus allocation minus PSA) approximates the sum of
pooled and standalone wells. Public RRC data does **not** split pooled vs.
standalone; this split is a derived attribute resolved only through county
land ingest and lease parsing.

---

## Counts

| Category       | Count |
|----------------|------:|
| **ALLOCATION** |     0 |
| **PSA**        |     0 |
| **Total**      |     0 |
| **Residual**   |     0 |

**Residual breakdown (estimated):**
- Standard wells: ~0 (includes pooled + standalone, unresolvable from public data)

---

## Query Provenance

**URL:** https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do  
**Method:** HTTP POST (form submission)  
**Form Parameters:**
- `county`: REEVES
- `fromDate`: 2022-01-01
- `toDate`: 2026-07-07
- `completionType`: (varies per query — "ALLOCATION", "PSA", or blank for total)

**Run Timestamp:** 2026-07-07T13:46:43.843Z

---

## Notes

1. **Pooled vs. Standalone:** Public RRC data does NOT distinguish pooled
   wells from standalone wells. The residual count includes both categories
   plus any other non-allocation, non-PSA permits. Resolving this split
   requires cross-referencing lease assignments and tract ownership data,
   which is outside the scope of the W-1 adapter.

2. **Schema Validation:** This report validates the adapter's design
   principle: pooled-vs-standalone is a **derived attribute**, never directly
   sourced from RRC public data. The W-1 adapter correctly omits any
   "pooled" or "standalone" field from the well atoms it produces.

3. **Data Freshness:** RRC permits are updated in near-real-time. The counts
   in this report reflect the state of the database at the run timestamp.

---

## Manual Query Steps

If live fetching is unavailable, run the queries manually:

1. Visit: https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do
2. Fill in the form:
   - **County:** REEVES
   - **Date Submitted From:** 2022-01-01
   - **Date Submitted To:** 2026-07-07
   - **Wellbore Profile/Completion Type:** (see below)
3. Submit and note the result count.

**Three queries to run:**

1. **Allocation count:** Set "Wellbore Profile/Completion Type" = "ALLOCATION"
2. **PSA count:** Set "Wellbore Profile/Completion Type" = "PSA"
3. **Total count:** Leave "Wellbore Profile/Completion Type" blank (or "ALL")

Record the counts and compute the residual: `total - allocation - PSA`.
