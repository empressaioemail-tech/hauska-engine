# Reeves County O&G Mint Report

**Generated:** 2026-07-08T04:37:30.661Z  
**Mint Duration:** 67.64s  
**Data Acquired:** 2026-07-08T04:36:22.965Z

---

## Mission

Mint the Reeves County corpus (wells, production streams, injection streams) through the engine per O&G activation decision step 4. Gate: curated per-domain eval queries with real assertions, cost capture.

---

## Acquisition Status (Honest Reporting)

### W1: ✓ OBTAINED

- **Records:** 5000
- **Status:** obtained
- **Note:** Live fetch from RRC EWA (2022-01-01 to 2026-07-08)


### PDQ-OIL: ⚠ BOUNDED

- **Records:** 9
- **Status:** bounded
- **Note:** FIXTURE SAMPLE (3 leases, Jan-Mar 2024). Not full county coverage. PDQ live client not implemented (EXIT-BOUNDED constraint).


### PDQ-GAS: ⚠ BOUNDED

- **Records:** 9
- **Status:** bounded
- **Note:** FIXTURE SAMPLE (3 wells, Jan-Mar 2024). Not full county coverage. PDQ live client not implemented (EXIT-BOUNDED constraint).


### H10: ⚠ BOUNDED

- **Records:** 9
- **Status:** bounded
- **Note:** FIXTURE SAMPLE (3 wells, Jan-Mar 2024). Not full county coverage. H-10 live client not implemented (EXIT-BOUNDED constraint).



**Total Records Acquired:** 5027

---

## Normalization & Validation

### Well Atoms (from W-1)
- **Attempted:** 5000
- **Validated:** 5000
- **Dropped:** 0


### Production Timeseries Atoms (from PDQ Oil)
- **Attempted:** 9
- **Validated:** 9
- **Dropped:** 0


### Production Timeseries Atoms (from PDQ Gas)
- **Attempted:** 9
- **Validated:** 9
- **Dropped:** 0


### Production Timeseries Atoms (from H-10)
- **Attempted:** 9
- **Validated:** 9
- **Dropped:** 0


---

## Atom Counts (Per Type)

| Atom Type | Count |
|-----------|------:|
| **well** | 5000 |
| **production-timeseries (oil)** | 9 |
| **production-timeseries (gas)** | 9 |
| **production-timeseries (injection)** | 9 |
| **TOTAL** | **5027** |

---

## Cost Capture

- **Wall-Clock Time:** 67.64s
- **Bytes Fetched:** (not tracked for fixture-based sources)
- **Retry Counts:** 0 (no retries required)

---

## Contract Compliance

- **Contract Version:** @empressaio/atom-contract@1.7.0
- **Validation:** Every atom validated against contract zod schemas
- **Access Policy:** platform-internal (per task requirement)
- **Provenance:** sourceCitation, extractedAt, asOf populated on every atom
- **Quality Gate:** Validation failures = mint failure (no silent drops)

---

## Data Boundaries & Limitations

### W-1 Drilling Permits
- **Coverage:** Reeves County (RRC county code 389), 2022-01-01 to 2026-07-08
- **Status:** Live fetch from RRC EWA (full coverage attempted)
- **Grain:** Per-permit (one well atom per permit)

### PDQ Production Data
- **Coverage:** FIXTURE SAMPLE (3 leases for oil, 3 wells for gas, Jan-Mar 2024)
- **Status:** Not full county coverage (live PDQ client not implemented due to EXIT-BOUNDED constraint)
- **Grain:** 
  - Oil: lease-level (anchors to rrc-lease per Texas reporting split)
  - Gas: well-level (anchors to well per Texas reporting split)
- **Limitation:** For full backfill, download bulk EBCDIC extracts from ftp://ftpe.rrc.texas.gov/shfwba/

### H-10 Injection/Disposal Data
- **Coverage:** FIXTURE SAMPLE (3 wells, Jan-Mar 2024)
- **Status:** Not full county coverage (live H-10 client not implemented due to EXIT-BOUNDED constraint)
- **Grain:** Well-level (same as gas production)
- **Limitation:** For full backfill, download bulk H-10 files from RRC public data site

---

## Artifacts

- `reeves-atoms.ndjson` — Full minted atom set (GITIGNORED, local only)
- `reeves-mint-report.md` — This report (COMMITTED)
- `reeves-atom-sample.ndjson` — ~50 atoms spanning all types (COMMITTED, for review)
- `twin-export.json` — Aggregated dataset for og-twin frontend (COMMITTED, <200KB)

---

## Next Steps

1. **Non-Vacuous Eval:** Run `pnpm run eval` to execute curated eval queries with real assertions
2. **Integration:** Planner-gated decision on serving corpus integration (out of scope for this PR)
3. **Full Backfill:** For production deployment, implement bulk EBCDIC/CSV parsers for PDQ and H-10
