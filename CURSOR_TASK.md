# C6: Reeves County O&G corpus mint (real RRC data) + twin export

You are building in a fresh clone of hauska-engine on branch `feat/c6-reeves-mint`. Commit early and PUSH THE BRANCH AFTER YOUR FIRST COMMIT (`git push -u origin feat/c6-reeves-mint`), then keep pushing as you go. This clone may be recycled; pushed commits are the only durable output.

## Mission

Turn the three merged RRC adapters in `packages/og-sources` (rrc-w1, rrc-pdq, rrc-h10) into a real, validated Reeves County atom dataset per the O&G activation decision step 4: "Mint the Reeves County corpus (wells, RRC leases, operators, production and injection streams, permits) through the engine. Gate: curated per-domain eval queries with real assertions, cost capture."

## Read first (in this order)

1. `packages/og-sources/src/` — all three adapters (client, normalize, types). The W-1 live client WORKS (county code 389, MM/DD/YYYY dates; the ratio report generator independently reproduced 3,887 Reeves W-1 permits since 2022-01-01: 1,724 allocation / 344 PSA). Note what normalize already emits.
2. The published contract: `@empressaio/atom-contract@1.7.0` — install it and read the `./og` module d.ts + zod schemas (og atom types, prefixes, INSTRUMENT_TYPES, revenue-allocation-unit, production stream shapes with streamKind/anchorKind/anchorDid).
3. `packages/atoms/src/` — how the engine represents atom instances (accessPolicy enum etc.).
4. How existing mints report: look at `reeves_w1_ratio_report` output committed by the C3 work (search the repo) for the honest-reporting style.

## Build

A new script/package `packages/og-mint` (or extend og-sources with a `mint/` module — your call, keep it coherent with repo conventions):

1. **Acquire live** (bounded, resumable, throttled politely):
   - W-1 drilling permits, Reeves (county 389), 2022-01-01 → today. Expect ~3,887. Full set.
   - PDQ production for Reeves: most recent 24 months, honoring the lease-oil vs well-gas grain split the adapter already models. If the live PDQ query surface makes full-county 24-month pulls impractical, take the largest honest bounded slice (e.g. top operators by permit count), and REPORT THE BOUND EXPLICITLY. Never present a partial pull as full coverage.
   - H-10 injection/disposal for Reeves: same 24-month window, same honesty rule.
2. **Normalize to 1.7.0 ./og atoms**: wells, permits/regulatory events, operators (actor atoms), production timeseries streams, injection streams, and revenue-allocation-unit atoms where the W-1 allocation/PSA flags support them. EVERY atom must validate against the contract zod schemas — validation failures fail the mint, no silent drops (a dropped-record count with reasons is fine; silently skipping is not).
3. **accessPolicy**: `platform-internal` for all minted atoms (tier placement is a product decision that hasn't been made; do not mark anything public-free). Every atom carries provenance (source system, query, fetch timestamp) per the quality-gate rule.
4. **Emit artifacts** to `packages/og-mint/artifacts/` (gitignored EXCEPT the small ones):
   - `reeves-atoms.ndjson` — full minted set (GITIGNORED, stays local; report its counts + byte size).
   - `reeves-mint-report.md` — COMMITTED: per-source acquisition status (obtained vs bounded vs failed — honest), atom counts per type, validation stats, wall-clock + bytes fetched + retry counts as the commitment-3 cost capture.
   - `reeves-atom-sample.ndjson` — COMMITTED: ~50 atoms spanning every type, for review.
   - `twin-export.json` — COMMITTED (must stay under ~200KB): an aggregated dataset purpose-built for the og-twin frontend. Clone https://github.com/empressaioemail-tech/og-twin READ-ONLY somewhere under P:\tmp (NOT in this repo) and read `fixtures/` + `src/data/` + `scripts/emit-twin-data.mts` to learn the exact shape the twin's mapping layer consumes (clusters, wells, horizons, timeline events, region label). Produce the same shape FROM THE REAL MINTED ATOMS: real well names/statuses from W-1+PDQ, real production aggregates, real injection volumes, timeline events from real permit filings. Fields the real data cannot support stay ABSENT or carry an explicit `"dataStatus": "unavailable"` marker — never invent values to fill the mockup's slots. Include a `provenance` block: source=RRC public record, minted timestamp, atom counts backing each aggregate.
5. **Non-vacuous eval**: `packages/og-mint/eval/reeves-eval.ts` — at least 10 curated queries with REAL asserted answers checked against the minted set (e.g. total W-1 count since 2022 == the report's count; allocation count == 1,724 (assert against your own fresh pull, noting drift vs the 07-07 baseline); a named operator's well count; a specific well's production stream exists; injection volume total for a month is nonzero and matches source). Eval runs as a vitest suite. An eval that passes with zero queries executed is a FAILURE (non-vacuousness floor).

## Verification (EXIT-BOUNDED ONLY)

- `pnpm` (or repo-standard) test run for the new suites + existing og-sources suites — all green.
- Typecheck green.
- Run the mint end-to-end once for real; the committed report must be generated by that actual run (never hand-write numbers).
- NEVER run dev servers, watch modes, or any non-exiting command. Every verification step must terminate on its own.

## Constraints

- Do not touch the corpus serving snapshot, retrieval-api, or any deploy config — this PR is the mint pipeline + artifacts only. Integration into the serving corpus is a separate planner-gated step.
- Do not modify existing adapters except where a real bug blocks the mint (document any such fix in the PR body).
- Follow repo lint/style; no new hard deps beyond what the repo already uses unless truly necessary.
- Throttle RRC requests politely (the existing clients' patterns); if RRC blocks or the form flow breaks, record the failure honestly in the report and continue with what is obtainable — never fabricate.
- Commit messages: conventional, and the PR stays a single coherent branch.

## Done =

Branch pushed with: og-mint package, committed mint report with real numbers + cost capture, committed sample + twin-export.json, non-vacuous eval suite green, all tests/typecheck green, and a PR opened titled "feat(c6): Reeves County O&G mint — real RRC atoms, non-vacuous eval, twin export" with an honest body (what was obtained, what was bounded, what failed).
