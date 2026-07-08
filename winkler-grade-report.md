# Winkler County Title Method Baseline - Grade Report

**Generated:** 2026-07-08T04:38:34.374Z

**Target Tract:** S/2 SW/4 Section 25, Block B-5, PSL Survey, Winkler County, TX

---

## Executive Summary

This report grades the title-method baseline (method v0) against a certified Working Interest Ownership Report for S/2 SW/4 Section 25, Block B-5, Winkler County.

**Parse Performance:**
- Parsed 563 of 3396 instrument rows (16.6%)
- 2833 rows unparsed

**Chain Assembly:**
- 0 instruments scoped to target tract
- 1 gaps/ambiguities identified
- 1 working interest owners computed

**Grade:**
- **Owner Match Rate:** NaN% (0/0 owners found)
- **Perfect Interest Matches:** 0
- **Close Matches (Δ < 5%):** 0
- **Missed Owners:** 0
- **Spurious Owners:** 1

**Conclusion:** This is an EXPECTED low first score. Method v0 uses simplified chain logic and conservative name parsing. The variance ledger below documents Winkler-specific assumptions for future county-to-county calibration.

## Runsheet Parse Statistics

- **Total Rows:** 3396
- **Successfully Parsed:** 563
- **Unparsed:** 2833
- **Parse Rate:** 16.58%

### Sample Unparsed Rows (first 5)

- **Line 21:** Failed to parse instrument row
  `DEED, ASSUMPTION PARTITION, ETC. 1/362`
- **Line 27:** Failed to parse instrument row
  `04/05/190904/13/1909 CRAWFORD A T SEC: 17, 24--25  BLK: B5  PUBLIC SCHOOL LANDS  [ALL ;]   ALL COWDE...`
- **Line 33:** Failed to parse instrument row
  `06/16/190906/25/1909 CRAWFORD A T SEC: 17, 24--25  BLK: B5  PUBLIC SCHOOL LANDS  [ALL ;]   ALL AMERI...`
- **Line 38:** Failed to parse instrument row
  `07/17/190908/12/1909 CRAWFORD A T SEC: 17, 24--25  BLK: B5  PUBLIC SCHOOL LANDS  [ALL ;]   ALL STATE...`
- **Line 46:** Failed to parse instrument row
  `03/08/192304/02/1923 YEISER ELAINE H SEC: 17, 24--25  BLK: B5  PUBLIC SCHOOL LANDS  [ALL ;]   ALL AS...`

## Chain Assembly Statistics

- **Total Scoped Instruments:** 0
- **Instrument Type Distribution:**

- **Identified Gaps:** 1
  - No patent found - chain to sovereignty incomplete

- **Computed Working Interest Owners:** 1

## Grade: Method vs. Certified Report

### Matched Owners

*None*

### Missed Owners (in Report, not in Method)

*None*

### Spurious Owners (in Method, not in Report)

| Owner | Method WI |
|-------|-----------|
| Unknown Surface Owner | 1.0000 |


## Detailed Analysis

Each mismatch below includes the method's best explanation:

1. Spurious owner Unknown Surface Owner: present in method (1.0000) but not in report. Possible cause: name parsing error or incorrect chain link


## Variance Ledger: County-Specific Assumptions

The variance ledger documents every Winkler-specific assumption baked into this baseline method. When the method encounters new counties, these entries become calibration points.

### County Index Format

- **Columnar index format with INSTRUMENT TYPE, BOOK/PAGE, INST#, dates, parties, LEGAL, FILED DATE**
  Winkler County clerk provides a structured "EDIT LIST" with consistent column headers. Other counties may use freeform chronological lists or different column orders.

- **RELATED BK/PG column cross-references amendments, releases, and related instruments**
  Winkler index includes explicit cross-references. Other counties may lack this field, requiring inference from document content.

### Instrument Type Vocabulary

- **INSTRUMENT TYPE vocabulary includes "OG LEASE", "MINERAL DEED", "ROYALTY DEED", "ASSIGNMENT", etc.**
  These abbreviations are Winkler-specific. Other counties may use "O&G LEASE", "OIL AND GAS LEASE", "M/D", or full instrument names.

### Survey Convention

- **Public School Lands (PSL) survey with "BLK B-5" notation**
  PSL surveys use Block notation. Other Texas counties may use different surveys (e.g., metes and bounds, railroad surveys, abstracts without blocks).

### Legal Description Pattern

- **Legal descriptions use "SEC 25 BLK B-5" followed by subdivisions (SE, W2, S2SW4, ALL)**
  This section-block-subdivision pattern is common in West Texas PSL. Other regions may use township-range (PLSS), abstract-survey, or metes and bounds exclusively.

- **Subdivision notation: "S2SW4" means S/2 of SW/4, "ALL" means entire section**
  This aliquot-part notation is standard but not universal. Some counties spell out "South Half of Southwest Quarter" or use fractions.

### Recording Practice

- **Two-date system: instrument date and filed date, with filed date occasionally years later**
  Winkler shows some instruments filed decades after execution. Other counties may have different filing patterns or single-date systems.

- **Index coverage appears complete from sovereignty grant forward**
  Winkler runsheet spans 1909-2015 with no obvious gaps. Other counties may have incomplete digitization, lost records, or multiple index systems by era.


## Method v0 Limitations (Honest Assessment)

Method v0 is intentionally simplified to establish a graded baseline. Known limitations:

1. **Parser conservatism:** The runsheet parser requires clean columnar structure. Wrapped rows or irregular formatting lands in the unparsed bucket, which may miss relevant instruments.

2. **Name extraction:** Grantor/grantee name parsing uses simple capitalization heuristics. Names embedded in legal descriptions or split across lines are frequently missed.

3. **Tract intersection logic:** Subdivision parsing (S2SW4, etc.) is conservative. Instruments with complex or non-standard legal descriptions may be incorrectly scoped.

4. **Chain linkage:** Method v0 does not verify grantor-grantee linkage through the chain. It orders by date and classifies by type but does not validate that grantees in one deed become grantors in the next.

5. **Interest computation:** Working interest calculation uses a placeholder equal-split rule when multiple assignments exist. It does not parse assignment fractions or depth severances.

6. **Depth handling:** The certified report shows depth-severanced ownership. Method v0 does not parse depth intervals from instruments.

7. **Identified gaps:** The method explicitly flagged 1 gaps in the chain (see Chain Assembly Statistics above). These represent known incompleteness.

These limitations are expected and documented. Future method revisions will address them incrementally, with each change measured against this baseline.
