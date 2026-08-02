# Phase A foundation — engine build scratchpad (v3, second rebase)

Branch: `feat/phase-a-foundation-v3` off `origin/main` (tip `af2a3bc` at rebase time)
Worktree: `P:/tmp/phase-a-engine-20260802`.

## GROUND-TRUTH: TWO rounds of concurrent-commit collision (2026-08-02)

This dispatch hit the "doc_repo concurrent-commit hazard" pattern TWICE in the same
session — another fleet agent (or parallel dispatch of the identical Phase A task
list) was independently landing the same 5 tasks to `origin/main` while this worktree
was building and re-building.

**Round 1** (original branch `feat/phase-a-foundation` off `a156497`, all 5 tasks
A2-A6 committed, HEAD `76629f2`, full monorepo green, PR #207 opened): `gh pr view`
reported `mergeable: CONFLICTING`. `origin/main` had advanced `a156497..b4d07d6` via
three merged PRs landing WHILE this worktree was mid-build:
- #203 — Block-13 cert script (same source commit as this dispatch's A2, byte-identical)
- #204 — recipe_version on promoted atoms (functionally duplicate to A3, different
  file layout: RECIPE_VERSION lives in `depth-warm/types.ts`, field `recipeVersion`)
- #205 — jurisdiction registry loader (functionally duplicate to A4, different shape:
  single `jurisdiction-registry.ts`, no separate `data/*.json`)

Response: closed #207, cut a fresh branch `feat/phase-a-foundation-v2` off `b4d07d6`,
re-applied ONLY A5+A6 (confirmed via `git log` that nothing on new main touched the R7
resolver or the hash call sites between the two merge-bases — clean re-apply, zero
semantic drift). Pushed, opened PR #208.

**Round 2** (branch `feat/phase-a-foundation-v2`, PR #208 opened): `gh pr view` AGAIN
reported `mergeable: CONFLICTING`. `origin/main` had advanced `b4d07d6..af2a3bc` via
ONE more merged PR landing WHILE #208 was being opened:
- #206 — "close R7 at primitive bake — unmapped-adjacency resolves district setback
  (A5)" — this is A5, landed independently, SAME dispatch target as this worktree's
  A5. Read the diff: #206 takes a BROADER interpretation than this worktree's original
  A5 — it removes the `unmapped-adjacency` decline UNCONDITIONALLY (reasoning:
  "RoadEdgeRole has no unknown member, so role is always known"), rather than this
  worktree's original approach of threading a `roleIsKnown` flag that preserved a
  decline path for the hardcoded `"side"` fallback-default case. #206's reading is
  actually sharper (RoadEdgeRole genuinely has no unknown/undefined member at the type
  level — the "unknown role" case this worktree's A5 carved out for was, on reflection,
  never reachable through a different path than what #206 removed). #206 also updated
  the U2.3 test that this worktree's original A5 preserved verbatim. #206 fully
  supersedes this worktree's A5 — not just duplicates it.

Response: closed #208 (PR body updated to explain), cut a second fresh branch
`feat/phase-a-foundation-v3` off `af2a3bc`, re-applied ONLY A6 (confirmed `compute.ts`'s
hash-computation call site — the OUTER `sha256HexCanonical(JSON.stringify(instance))`
line — is untouched by #206, which only changed `resolveSetbackForEdge`'s internal
logic a few lines above; A6 layers on cleanly with zero semantic drift).

**Net result: A2, A3, A4, A5 are ALL now covered by main via #203/#204/#205/#206. Only
A6 (determinism: timestamp out of content-hash) remains as this dispatch's net-new
contribution**, carried on `feat/phase-a-foundation-v3`.

---

## Task A6 — Determinism: timestamp out of content-hash (final, on `feat/phase-a-foundation-v3`)

Grepped for hash/signature computation and found timestamps ARE currently included in
the content hash across every property/road atom emitter
(`sha256HexCanonical(JSON.stringify(instance))` over the whole atom, including
`fetchedAt`/`extractedAt`/`versionStamp` and nested `readContract.assembledAt`/
`assertedAt`).

Added to `packages/engine-core/src/property-reasoning/confidence.ts`:
- `CONTENT_HASH_EXCLUDED_KEYS` (module-private Set): fetchedAt, extractedAt,
  assembledAt, assertedAt, warmAt, warmVerifiedAt, depthWarmVerifiedAt, promotedAt,
  versionStamp, contentHash.
- `stripTimestampsForHash(value)`: recursive deep-clone dropping any excluded key at
  ANY nesting depth (handles nested `readContract.assembledAt` /
  `readContract.axes.consequence.assertedAt`, not just top-level).
- `contentHashExcludingTimestamps(instance)`: `sha256HexCanonical(JSON.stringify(
  stripTimestampsForHash(instance)))` — drop-in replacement.

Applied in place of the old `sha256HexCanonical(JSON.stringify(instance))` pattern in
the three files on the depth-warm/boundary-primitive promote path:
- `property-reasoning/emit-buildable-envelope.ts`
- `property-reasoning/emit-setback-rule.ts`
- `boundary-primitive/compute.ts` (property-boundary-edge atom; confirmed this file's
  outer hash-computation call site was untouched by #206's R7 change, which only
  edited `resolveSetbackForEdge`'s internals a few lines above)

Test: `packages/engine-core/src/property-reasoning/__tests__/content-hash-determinism.test.ts`
(4 tests, 2 describe blocks): unit tests on `stripTimestampsForHash` (nested-key strip)
and `contentHashExcludingTimestamps` (two objects differing only in timestamps hash
equal; two objects differing in real content hash differently — negative control);
integration test proving two `emitDepthWarmPromotion` calls over the identical
`WarmCandidate` at `extractedAt` "2026-01-01" vs "2026-12-31" produce EQUAL
`contentHash` on both the buildable-envelope and setback-rule atoms (with a sanity
check that the two promotions really did carry different `extractedAt` values).

### OPEN (not fixed here — scope discipline, unchanged from original passes)

`emit-zoning-fact.ts` (2 call sites) and 4 road-node emitters in `road-intake/`
(`emit-road-node.ts`, `emit-county-road-node.ts`, `emit-county-roadway-node.ts`,
`emit-caldwell-cad-road-node.ts`) have the identical timestamp-in-hash bug pattern,
NOT fixed by this task — outside the depth-warm/boundary-primitive promote path this
Phase A dispatch scopes to. The `contentHashExcludingTimestamps` helper is ready to
drop into those 5 remaining call sites with the same 2-line swap pattern used here.

GATE A6: PASS.

---

## Verification (2026-08-02, on `feat/phase-a-foundation-v3`, commit `6aed9e3`)

`packages/engine-core` package-level:
- `pnpm run typecheck`: clean, zero errors.
- `pnpm run build`: clean, zero errors.
- Full engine-core suite (`pnpm run test`): 90 test files, 598 passed, 2 skipped
  (pre-existing LIVE-gated, unrelated), 0 failed.

Full monorepo (root):
- `pnpm run typecheck` (`pnpm -r run typecheck`): all 19 workspace projects "Done",
  zero errors.
- `pnpm run build` (`pnpm -r run build`): all 19 workspace projects "Done", zero
  errors.
- `pnpm run test` (`pnpm -r run test`): exit code 0. Per-package totals:

```
packages/og-sources test:       Test Files  3 passed (3)       Tests  23 passed (23)
packages/og-title test:         Test Files  4 passed (4)       Tests  34 passed (34)
packages/adapters test:         Test Files  28 passed (28)     Tests  400 passed (400)
packages/atoms test:            Test Files  8 passed (8)       Tests  140 passed (140)
packages/storage test:          Test Files  5 passed (5)       Tests  18 passed (18)
packages/workspace test:        Test Files  1 passed (1)       Tests  6 passed (6)
packages/corpus test:           Test Files  14 passed (14)     Tests  111 passed (111)
packages/document-ingest test:  Test Files  2 passed (2)       Tests  15 passed (15)
packages/engine-core test:      Test Files  90 passed (90)     Tests  598 passed | 2 skipped (600)
tools/migrate-legacy-codes test: Test Files 8 passed (8)       Tests  36 passed (36)
packages/retrieval test:        Test Files  3 passed (3)       Tests  17 passed (17)
services/engine-api test:       Test Files  17 passed (17)     Tests  99 passed (99)
services/retrieval-api test:    Test Files  13 passed (13)     Tests  79 passed (79)
```

Totals: 196 test files passed, 1576 tests passed, 2 skipped, 0 failed, exit code 0.

GATE (final): PASS on `feat/phase-a-foundation-v3`.

## Summary of dispatch outcome

A2, A3, A4, A5: superseded by concurrently-merged #203, #204, #205, #206 — verified
each covers the same ground as this dispatch's original implementation (in A4's and
A5's case, with materially different but equally valid or better implementation
choices). Not re-submitted; would be pure duplication or regression if forced in.

A6: this worktree's sole surviving net-new contribution, on `feat/phase-a-foundation-v3`,
PR (to be opened) against `main` @ `af2a3bc`.
