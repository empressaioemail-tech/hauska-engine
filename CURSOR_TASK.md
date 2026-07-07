# Task: C3a — RRC W-1 drilling-permit adapter, Reeves-first, with the allocation-vs-PSA ratio report as its smoke test

Branch: `feat/c3a-rrc-w1-adapter`. Push the branch immediately after your FIRST commit and keep pushing after every commit. Delete this CURSOR_TASK.md before your final commit. Open a PR titled `feat(c3a): RRC W-1 drilling-permit adapter (Reeves-first) + allocation/PSA ratio report`.

## Context you cannot discover yourself

1. **This is the first Lane-C engine deliverable for the Reeves County O&G vertical.** The atom shapes are PUBLISHED: `@empressaio/atom-contract@1.7.0` on npm carries the `./og` module (well, rrc-lease, mineral-lease, production-timeseries, revenue-allocation-unit, and friends), a core `obligation` type, INSTRUMENT_TYPES, registered prefixes, and DID derivation/validation helpers. Install it and consume the real types — do NOT hand-roll shapes. Read the package's `.d.ts` and its `og` module exports first.
2. **The FIRST deliverable is a report, not just code**: the Reeves allocation-vs-PSA ratio. RRC's W-1 drilling-permit query surface is `https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do` (the EWA "Drilling Permit Query"). Three counts, County=Reeves, submitted/approved since 2022-01-01: (a) Wellbore Profile/Completion Type = **Allocation**, (b) = **PSA** (Production Sharing Agreement), (c) blank = total. The residual (total minus allocation minus PSA minus standard) approximates pooled+standalone, which public data CANNOT split — report it as a residual, never as a resolved number (this validates the schema's negative-case rule: pooled-vs-standalone is a DERIVED attribute only our county ingest resolves).
3. **RRC surfaces are public records; no credentials needed.** The EWA query app is an ASP.NET form flow — you may need to inspect the form fields (GET the page, find the POST params). If the web form proves unscriptable in this environment, the adapter still ships against recorded fixtures AND you write the exact manual query steps + param names into the report file so the planner can run the three counts by hand.
4. This repo has ONE merge queue and other work lands behind you — keep the diff scoped.

## Work

1. **Survey the engine's adapter conventions** (`packages/corpus/src/adapters/` is the code-corpus family — O&G source adapters are a NEW family; place them sensibly, e.g. `packages/og-sources/` or alongside existing data-adapter patterns if you find one; note your placement rationale in the PR body).
2. **W-1 adapter**: fetch + normalize Reeves County W-1 drilling permits into `@empressaio/atom-contract` `./og` shapes (wells/permits with DIDs derived per the contract helpers, provenance fields: sourceUrl, fetchedAt, contentHash per BaseAtomInstance convention). County-parameterized, Reeves as the default fixture case.
3. **Ratio report generator**: a script (`tools/` or the adapter package's `scripts/`) that runs the three W-1 counts and emits `reeves_w1_ratio_report.md` — allocation count, PSA count, total, residual, query provenance (URL, params, run timestamp), and the explicit note that pooled-vs-standalone is unresolvable from public data. If live fetch works in this environment, COMMIT the generated report with real numbers; otherwise commit the generator + fixtures + the manual-steps section.
4. **Tests**: fixture-driven normalization tests (record a small real response as fixture); DID validity assertions using the contract's validators (no `wellDid:"banana"` — the contract review killed that class); a negative test that the residual is never emitted as a resolved pooled count.

## Constraints

- EXIT-BOUNDED commands only (build/test/one-shot fetch scripts with timeouts). NEVER a dev server or watcher. Live HTTP fetches must have explicit timeouts and bounded retries (max 2).
- Be polite to RRC: sequential requests, no crawling beyond the three counts + a small sample page for fixtures.
- Do not touch the corpus mint, snapshots, or other adapters.
