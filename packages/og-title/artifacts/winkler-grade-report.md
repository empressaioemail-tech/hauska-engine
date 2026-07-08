# Winkler County Title Method Baseline - Grade Report

**Generated:** 2026-07-08T04:56:11.346Z

**Target Tract:** S/2 SW/4 Section 25, Block B-5, PSL Survey, Winkler County, TX

---

## Executive Summary

This report grades the title-method baseline (method v0) against a certified Working Interest Ownership Report for S/2 SW/4 Section 25, Block B-5, Winkler County.

**Parse Performance:**
- Parsed 643 of 646 instrument rows (99.5%)
- 3 rows unparsed

**Chain Assembly:**
- 476 instruments scoped to target tract
- 3 gaps/ambiguities identified
- 1 working interest owners computed

**Grade: UNGRADEABLE-YET (answer key unreadable, not a method score).**
- The certified WI report's ownership exhibit (pages 2-4) is an image scan whose embedded OCR text layer is garbage (planner-verified 2026-07-08: extraction yields non-language character noise). The deterministic parser cannot extract the owner table, so there is NO answer key to grade against yet — "0/0 owners" reflects a blocked input, not a method result.
- **Unblock path (operator ask filed):** a cleaner copy of the exhibit, Herbert's confirmation of the owner/interest table values, or a vision-OCR pass. Grading re-runs the moment the answer key exists; the harness is built and tested against synthetic known-answer cases.
- Method-side caveat: WI computation v0 currently emits a single placeholder aggregate ("Unknown Surface Owner", 1.0000) — it is a stub pending real chain math, and would grade poorly even with an answer key. That is the expected honest state of method v0.

**What IS gradeable today (Herbert's method-grading surface):** parse performance (99.5% of 646 instrument rows), tract scoping (476 instruments, quarter-call intersection with certain/possible flags), chain assembly structure (type distribution, 3 explicit gaps incl. no-patent-to-sovereignty and a 14-year gap), and the variance ledger below.

## Runsheet Parse Statistics

- **Total Rows:** 646
- **Successfully Parsed:** 643
- **Unparsed:** 3
- **Parse Rate:** 99.54%

### Sample Unparsed Rows (first 5)

- **Line 15003:** Failed to parse multi-line record
  `PARTIAL RELEASE OF LIEN VARIOUS COUNTIES`
- **Line 15046:** Failed to parse multi-line record
  `RELEASE OF LIEN 3 DIFFERENT AMOUNT VARIOUS COUNTIES`
- **Line 19249:** Failed to parse multi-line record
  `ASSIGNMENT & CONVEYANCE REF B77438, B77445, B79163`

## Chain Assembly Statistics

- **Total Scoped Instruments:** 476
- **Instrument Type Distribution:**
  - assignment: 267
  - deed: 82
  - mineral-deed: 47
  - release: 42
  - other: 23
  - probate: 9
  - royalty-deed: 6

- **Identified Gaps:** 3
  - No patent found - chain to sovereignty incomplete
  - 8 instruments with uncertain tract intersection
  - Large time gap (14 years) between 1909-04-05 and 1923-03-08

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

7. **Identified gaps:** The method explicitly flagged 3 gaps in the chain (see Chain Assembly Statistics above). These represent known incompleteness.

These limitations are expected and documented. Future method revisions will address them incrementally, with each change measured against this baseline.
