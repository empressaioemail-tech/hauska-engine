# Phase A foundation — engine build scratchpad (v2, post-concurrent-merge rebase)

Branch: `feat/phase-a-foundation-v2` off `origin/main` (tip `b4d07d6` at rebase time)
Worktree: `P:/tmp/phase-a-engine-20260802` (same fresh clone used throughout this
dispatch; branch switched in place, no re-clone).

## GROUND-TRUTH: concurrent-commit collision discovered (2026-08-02)

Original work was done on branch `feat/phase-a-foundation` off `origin/main` @ `a156497`
(5 task commits, A2->A6, HEAD `76629f2`, full monorepo build/tsc/test green — see the
original run's detail preserved in git history at that branch/PR if still open). On
opening the PR (`gh pr create` -> #207), `gh pr view 207 --json mergeable` reported
`CONFLICTING`. Investigation (`git fetch origin main`) found `origin/main` had moved
`a156497..b4d07d6` — three NEW merged PRs landed while this dispatch was in flight:

- #203 `chore(engine-core): durable Block-13 cert-grade script` — same file/commit as
  this dispatch's A2 (`block13-cert-grade.mjs`), cherry-picked from the SAME source
  commit `555e312` on main matches `4f3891e` content 1:1.
- #204 `feat(engine): recipe_version on promoted atoms (OPS-4 A3)` — functionally
  duplicate to this dispatch's A3 (different file layout: RECIPE_VERSION constant
  lives in `depth-warm/types.ts` on main instead of a dedicated
  `recipe-version.ts`; field name `recipeVersion` camelCase on envAtom vs this
  dispatch's `recipe_version` snake_case — main's version is now authoritative).
- #205 `feat(engine): jurisdiction registry loader (OPS-1 A4)` — functionally
  duplicate to this dispatch's A4 (different shape: main uses a single
  `registry/jurisdiction-registry.ts` file with an inline Bastrop row constant,
  no separate `data/*.json`; this dispatch's split types.ts/loader.ts/data/ layout
  is superseded).

This is the documented "doc_repo concurrent-commit hazard" pattern — another
agent/session ran the SAME OPS-1/OPS-4/cert-restore tasks in parallel (see commit
authorship: `empressaioemail-tech` + `Claude Opus 4.8` co-author, landed same day
2026-08-02 08:23-08:38, i.e. WHILE this dispatch's worktree was mid-build). A2/A3/A4
from this dispatch are now REDUNDANT with what's on main. A5 and A6 are NOT covered —
grepped `origin/main`'s log for `boundary-primitive/compute.ts` and
`property-reasoning/confidence.ts` /`emit-buildable-envelope.ts`/`emit-setback-rule.ts`;
most recent touches were `dd9fc1d` (R22/R25/R26/R27 setback work, predates the
merge-base) and earlier — nothing on the new main touches the `resolveSetbackForEdge`
R7 logic or the `sha256HexCanonical(JSON.stringify(instance))` hash-computation
call sites. Confirmed clean.

### Resolution

Created a FRESH branch `feat/phase-a-foundation-v2` directly off `origin/main` @
`b4d07d6` (which already carries A2/A3/A4 via #203/#204/#205) and re-applied ONLY the
A5 and A6 diffs on top — same file targets (`boundary-primitive/compute.ts` for A5;
`property-reasoning/confidence.ts` + `emit-buildable-envelope.ts` +
`emit-setback-rule.ts` + `boundary-primitive/compute.ts` for A6), byte-identical logic
to the original branch's A5/A6 commits (confirmed the target functions were untouched
between the two main tips before re-applying, so no semantic drift). Did NOT force-push
over #207's branch content with a rewrite of the redundant A2/A3/A4 — instead this is a
clean new branch/PR targeting exactly the incremental work still needed. The original
`feat/phase-a-foundation` branch / PR #207 should be CLOSED by the planner in favor of
this one (documented in the final report, not auto-closed by this agent — PR
close/merge is planner-owned per dispatch discipline).

---

## Task A5 — Close R7 at primitive bake (re-applied on new main)

Identical implementation to the original pass: `resolveSetbackForEdge` in
`packages/engine-core/src/boundary-primitive/compute.ts` gained a `roleIsKnown: boolean`
parameter; the unconditional `if (adjacencyKind === "unmapped")` decline became
`if (adjacencyKind === "unmapped" && !roleIsKnown)`. Call site passes
`const roleIsKnown = label != null` (label from `labelByIndex.get(i)`, which is
populated only when `labelEdgesFromRoads` succeeds for the WHOLE parcel ring — an
all-or-nothing labeler; when it declines, `edgeLabels = []` and every edge's `role`
falls back to the hardcoded default `"side"`, which is NOT a resolved fact).

Test: `packages/engine-core/src/boundary-primitive/__tests__/r7-known-role-unmapped-adjacency.test.ts`
(2 tests, re-created identically to the original pass): (1) known role (situs-matched
front + genuinely-known rear/side on an isolated single-parcel fixture) resolves to
district defaults instead of declining; (2) genuinely-unknown role (`roads: []`,
labeling declines entirely) still declines unmapped-adjacency, unchanged. Verified the
existing `boundary-primitive.test.ts` U2.3 "unmapped edges do not invent setback feet"
test (uses `roads: []`) still passes unchanged on the new main.

GATE A5: PASS (re-verified on new main). See Verification section below.

## Task A6 — Determinism: timestamp out of content-hash (re-applied on new main)

Identical implementation to the original pass: added `stripTimestampsForHash` +
`contentHashExcludingTimestamps` to `packages/engine-core/src/property-reasoning/confidence.ts`
(deep-strip of fetchedAt/extractedAt/assembledAt/assertedAt/warmAt/warmVerifiedAt/
depthWarmVerifiedAt/promotedAt/versionStamp/contentHash at any nesting depth). Applied
in place of the old `sha256HexCanonical(JSON.stringify(instance))` pattern in
`emit-buildable-envelope.ts`, `emit-setback-rule.ts`, and `boundary-primitive/compute.ts`
(same three files as before; confirmed byte-identical `sha256HexCanonical(JSON.stringify(
instance))` call sites existed on the new main before editing, so the fix logic
transferred unchanged).

Test: `packages/engine-core/src/property-reasoning/__tests__/content-hash-determinism.test.ts`
(4 tests, re-created identically): unit-level strip-function tests (2) plus a negative
control (1), plus an integration test (1) proving two `emitDepthWarmPromotion` calls
over the same `WarmCandidate` at different `extractedAt` values produce equal
`contentHash` on both the buildable-envelope and setback-rule atoms.

OPEN (unchanged from original pass, still not fixed): `emit-zoning-fact.ts` and the 4
road-node emitters in `road-intake/` have the identical timestamp-in-hash pattern,
out of scope for this dispatch.

GATE A6: PASS (re-verified on new main). See Verification section below.

---

## Verification (2026-08-02, on `feat/phase-a-foundation-v2`)

`packages/engine-core` package-level:
- `pnpm run typecheck` (tsc --noEmit): clean, zero errors.
- `pnpm run build` (tsc -b): clean, zero errors.
- `pnpm vitest run src/boundary-primitive/__tests__/r7-known-role-unmapped-adjacency.test.ts src/property-reasoning/__tests__/content-hash-determinism.test.ts`:
  2 files, 6 tests, ALL PASS.
- Full engine-core suite (`pnpm run test`): 91 test files, 600 passed, 2 skipped
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
packages/engine-core test:      Test Files  91 passed (91)     Tests  600 passed | 2 skipped (602)
tools/migrate-legacy-codes test: Test Files 8 passed (8)       Tests  36 passed (36)
packages/retrieval test:        Test Files  3 passed (3)       Tests  17 passed (17)
services/engine-api test:       Test Files  17 passed (17)     Tests  99 passed (99)
services/retrieval-api test:    Test Files  13 passed (13)     Tests  79 passed (79)
```

Totals: 197 test files passed, 1578 tests passed, 2 skipped, 0 failed, exit code 0.

GATE (final): PASS on `feat/phase-a-foundation-v2`.
