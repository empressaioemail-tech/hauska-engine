# C6b FIX ROUND — the mint's coverage and validation are broken; the twin export is empty

Continue on branch `feat/c6-reeves-mint` (PR #90 already open). Planner review verdict: HOLD. The report was honest, which is good — but the mission failed on three counts. Fix all three, regenerate every artifact from a real run, push.

## Defect 1: W-1 acquisition fetched 20 records; ground truth is ~3,887

The C3b work in `packages/og-sources` ALREADY solved live W-1 acquisition: the committed ratio report (search the repo for `reeves_w1_ratio_report`) was independently reproduced with **3,887 Reeves W-1 permits since 2022-01-01** (county code 389, MM/DD/YYYY dates, correct form-field discovery, PAGING through the result set). Your acquire path got 20 — you are missing paging and/or the proven query params. Reuse the og-sources client/generator approach EXACTLY. HARD FLOOR: if your total W-1 count is under 3,000, the acquisition is broken — fix and re-run; do not proceed to normalization, do not hand-adjust the floor.

## Defect 2: normalization dropped 20/20 wells (0 validated)

Real W-1 records break your mapping: `totalDepth` mapped to NaN (omit the field when the source value is absent/non-numeric — check what the contract schema allows as optional) and `wellNumber` empty (handle absent well numbers per the schema — optional or a documented fallback, never a fabricated value). Target: >95% of acquired records validate; every drop itemized with reason counts (aggregate, not one JSON blob per record). If the contract schema genuinely requires a field the source cannot supply, SAY SO in the report and pick the honest representation (omit atom vs optional field) — do not weaken the contract.

## Defect 3: twin-export.json is empty (0 wells, 0 clusters, 0 timelineEvents)

The og-twin frontend needs real Reeves content. From the validated W-1 atoms build: wells (real API numbers, operator, lease name, status from permit data), clusters (group by operator or field — pick the grouping the mockup's cluster semantics fit best and say which), timelineEvents (recent permit filings, real dates/operators). Production/injection overlays: fixture-grade only — either omit with an explicit `"dataStatus": "unavailable"` per the original task, or include ONLY with a per-panel `"dataStatus": "fixture-sample"` label; never blend fixture numbers into real-well displays unlabeled. Keep it under ~200KB (cap wells to a representative recent subset if needed — say the cap in provenance).

## Hygiene

- Remove CURSOR_TASK.md from the branch (committed by mistake).
- Dedupe the eval file: it exists at BOTH `eval/reeves-eval.test.ts` (repo root) and `packages/og-mint/eval/reeves-eval.test.ts` — keep only the packages/og-mint one and make sure the repo test runner picks it up.
- Regenerate report + sample + twin-export from the actual fixed run; eval assertions updated to the real counts (W-1 total asserts >= 3000, allocation+PSA ratio in a sane band around the 53% baseline with drift noted).

## Verification (EXIT-BOUNDED ONLY)

- Full og-mint suite + og-sources suites green; typecheck green.
- One real end-to-end mint run producing the committed artifacts (never hand-edit artifact numbers).
- Update the PR body with the new honest numbers.

Push all commits when done.
