# Phase A foundation — engine build scratchpad

Branch: `feat/phase-a-foundation` off `origin/main`
Worktree: `P:/tmp/phase-a-engine-20260802` (fresh clone, isolated)

## Task A2 — Cert script to main

GROUND-TRUTH (2026-08-02): `packages/engine-core/scripts/block13-cert-grade.mjs` did NOT exist on
`main` prior to this branch. Confirmed by directory listing of `packages/engine-core/scripts/`
on main-tip clone before cherry-pick — file absent.

Source: `origin/chore/block13-cert-grade-script` @ commit `4f3891e08f65d4313d56bb450e1567d80a3840f8`
("chore(engine-core): durable Block-13 cert-grade script (R32 engine-frame + road-node orientation)").
`git show 4f3891e --stat` confirmed single-file commit: 359 insertions, 1 file
(`packages/engine-core/scripts/block13-cert-grade.mjs`), no other files touched.

Action: `git cherry-pick 4f3891e` onto `feat/phase-a-foundation`. Clean, zero conflicts.
Resulting commit: `fec86e0` (message preserved verbatim from source).

Brought across AS-IS, no rewrite, no weakening.

### Read-verification of the 4 gates (read-only, no execution)

Read the full 359-line script. Confirmed:

1. **Measurer**: imports `measurePerEdgeInsetForRings` from
   `../src/depth-warm/measure-inset.ts` (line 53) and uses it at line 290 for Gate 3
   (per-edge inset). This IS the R32 index-matched inward-normal measurer per the
   header comment (lines 11-16) and the `report.measurer` field (line 124):
   "R32 index-matched inward-normal (measurePerEdgeInsetForRings)". Confirmed NOT the
   perpendicular-to-nearest-edge method (explicitly called out as the prior broken
   approach in the file's own doc comment).

2. **7 Block-13 parcels**: `BLOCK13` const at lines 64-72 lists exactly
   `48021:34145, 48021:34121, 48021:34153, 48021:34137, 48021:34169, 48021:34177, 48021:34161`
   — matches the 7 ids in the dispatch exactly. `ANSWER_KEY` (lines 75-83) has one entry
   per parcel with situs, district, F/S/C/R setback numbers, and frontStreet.

3. **4 gates, all fail-closed**, per parcel (lines 312-338, combined at 340-346):
   - **district** (lines 193-195, 313-318): served zoning-fact.district / setback-rule.districtCode
     vs answer key.
   - **setbacks** (lines 198-211, 253-266, 319-326): served setback-rule per-role numbers (front/
     rear/side/sideCorner) vs answer key, AND the engine's own `verifyWarmCandidateMechanically`
     setbackEdgeDistance gate.
   - **per-edge inset / R32** (lines 289-310, 327): `measurePerEdgeInsetForRings` per-edge vs
     expected-ft-for-role, tolerance 1.0 ft.
   - **front orientation** (lines 268-287, 328-337): fresh `labelEdgesFromRoads` front edge's
     backing road (by osmWayId) token-matches answer key's front street via
     `normalizeStreetNameForMatch`, AND the engine's own `verifyFrontEdgeOrientation` gate.
   - Final `parcelResult.pass` (line 340-346) requires ALL FOUR TRUE (district && setbackServedOk
     && setbackGate.pass && insetGatePass && frontFacesAnswer && engineOrient.pass) — genuinely
     fail-closed AND-of-all-gates, not an OR or partial-credit scheme.

   This is the FULL 4-gate cert, not an R31 partial/regrade variant — the script's own header
   comment (lines 1-33) explicitly frames it as the fix over a prior "untracked R31 regrade
   scratch."

### Env/DB requirements if run live (documented, NOT executed)

Per script header (lines 29-33) and code (lines 95-107):
- `DATABASE_URL` (or whatever `resolveSubstrateDatabaseUrl()` resolves) — REQUIRED, atoms Neon.
  Script exits 2 immediately if absent (lines 100-103).
- `TXGIO_DATABASE_URL` or `CORTEX_DATABASE_URL` — optional, falls back to `DATABASE_URL` if unset
  (lines 96-99); used for `txgio_parcel` situs_address lookup.
- Live network access to BCAD ArcGIS (`fetchBcadParcelRings`) for authoritative parcel rings —
  read-only external fetch, not a local fixture.
- Run command per header: `pnpm --filter @hauska-engine/engine-core exec tsx scripts/block13-cert-grade.mjs`

Did NOT run this — no live/prod grade attempted per instructions. Read-only source verification only.

GATE A2: PASS. Script present at
`packages/engine-core/scripts/block13-cert-grade.mjs` on branch `feat/phase-a-foundation`,
commit `fec86e0`. Full 4-gate cert confirmed by reading, not weakened/rewritten.

---

## Task A3 — recipe_version field (the rewarm trigger)

New source-of-truth: `packages/engine-core/src/recipe-version.ts` exports
`RECIPE_VERSION = "1.0.0"` (const, single string literal in the whole repo — verified
by grep no other file hardcodes the "1.0.0" string as a recipe version).

Stamped in TWO layers so the field is present both on the working `WarmCandidate`
(pre-promotion, in case anything reads it before promote) and on the DURABLE promoted
atoms (which is what the dispatch gate cares about):

1. `packages/engine-core/src/depth-warm/types.ts` — added `recipeVersion: string` to
   the `WarmCandidate` interface.
2. `packages/engine-core/src/depth-warm/warm-compute.ts` — `computeWarmCandidateWithLabels`
   (the road-labeling warm path) now stamps `recipeVersion: RECIPE_VERSION` on construction.
3. `packages/engine-core/src/boundary-primitive/consume.ts` — `computeWarmCandidateFromBoundary`
   (the boundary-primitive warm path, used by the cert script and S2-U3 offset-consume) also
   stamps `recipeVersion: RECIPE_VERSION`. This is the SECOND WarmCandidate construction site
   in the repo (grepped for `warmAgentId:` object-literal sites to confirm there are exactly
   two — warm-compute.ts and consume.ts — both now covered).
4. `injectBadWarmCandidate` in warm-compute.ts spreads `...good`, so it inherits recipeVersion
   automatically — no separate stamp needed there (it's a demo/test-only bad-inject helper, not
   a legitimate warm path).
5. `packages/engine-core/src/depth-warm/promote.ts` — `emitDepthWarmPromotion` now imports
   `RECIPE_VERSION` and stamps `recipe_version` (snake_case, matching the dispatch's requested
   field name and the existing `depthWarmPromotion`/`depthWarmVerifiedAt` atom-metadata
   convention) on BOTH promoted atoms: the `buildableEnvelopeAtom` (envAtom.recipe_version) and
   the `setbackRuleAtom` (setbackAtomWithRecipe.recipe_version). Stamped from the imported
   constant directly (not from candidate.recipeVersion) to guarantee promote-time truth even if
   a stale candidate object were passed in — single import path, no re-hardcode.

Test added: `packages/engine-core/src/depth-warm/__tests__/recipe-version.test.ts`
(2 tests): (1) `computeWarmCandidate stamps recipeVersion equal to RECIPE_VERSION constant`
— asserts the WarmCandidate carries it. (2) `promoted atoms (setback-rule + buildable-envelope)
carry recipe_version equal to the constant` — asserts BOTH promoted atom shapes carry
`recipe_version === RECIPE_VERSION` via `emitDepthWarmPromotion`.

### Verification (2026-08-02)

`pnpm run typecheck` (tsc --noEmit) in `packages/engine-core`: clean, zero errors.
`pnpm run build` (tsc -b) in `packages/engine-core`: clean, zero errors.
`pnpm vitest run src/depth-warm` in `packages/engine-core`: 7 test files, 38 tests, ALL PASS
(including the 2 new recipe-version tests). Full raw output:

```
 Test Files  7 passed (7)
      Tests  38 passed (38)
```

GATE A3: PASS. Build + tsc + new test all green. Promoted atom shape (both
setback-rule and buildable-envelope) includes `recipe_version` stamped from the single
`RECIPE_VERSION` constant.

---

## Task A4 — Registry-as-engine-input loader (Bastrop Rail C row)

### Source files used (doc_repo)

Exact filenames from the dispatch existed as-is — no fallback search needed:
- `P:/doc_repo/_land_records/txgio_stratmap_county_matrix_2026-08-02.json` (254 county rows,
  confirmed Bastrop at line 181: fips 48021, in_stratmap true, download_url
  `.../stratmap25-landparcels_48021_lp.zip`, flags [STALE], vintage_yyyymm 202503,
  vintage_date 2025-03-01, feature_count 63357, prop_id_bad_count 138, prop_id_bad_rate 0.0022).
- `P:/doc_repo/_land_records/txgio_stratmap_rail_c_adapter_registry.yaml` (Rail C
  adapter_routing_rules + coverage_summary + a Bastrop `county_examples` entry confirming
  adapter_path stratmap_bulk_zip, flags [STALE]).

GROUND-TRUTH (2026-08-02): Bastrop's `prop_id_bad_rate` (0.0022) is far under the
HIGH_PROP_ID_BAD_RATE threshold (0.25) and Bastrop does NOT appear in the YAML's
`high_prop_id_bad_counties` list (Dimmit/Floyd/Lipscomb/Motley/Oldham/Roberts/
Robertson/Travis only). Per `adapter_routing_rules` rule 2
(`when: in_stratmap && STALE` -> `path: stratmap_bulk_zip, join_key: prop_id`, no
owner-match gate — that gate is rule 3, only for HIGH_PROP_ID_BAD_RATE), Bastrop routes
stratmap_bulk_zip / prop_id join with `ownerMatchRequired: false`. This is what the
frozen fixture row encodes.

### Files created (hauska-engine, all NEW, additive only — no existing adapter touched)

- `packages/engine-core/src/registry/types.ts` — `JurisdictionRegistryRow` interface:
  fips, countyName, inStratmap, geometrySource (stratmap_bulk_zip |
  cad_direct_arcgis_rest | cad_direct_arcgis_rest_or_cad_bulk), joinKey (prop_id |
  geo_id_or_address_crosswalk), ownerMatchRequired, downloadUrl, vintageYyyymm,
  vintageDate, flags, featureCount, propIdBadRate.
- `packages/engine-core/src/registry/data/bastrop-48021.json` — frozen Bastrop row,
  fields copied verbatim from the matrix JSON + YAML routing-rule derivation above.
- `packages/engine-core/src/registry/loader.ts` — `loadRegistryRowByFips` (returns
  null if not onboarded), `requireRegistryRowByFips` (throws
  `RegistryRowNotFoundError`), `listRegistryFipsCodes`. Reads only the committed frozen
  JSON under `./data` — no network, no live DB, fully deterministic.
- `packages/engine-core/src/registry/index.ts` — barrel export, matching the
  `depth-warm`/`boundary-primitive` subpackage convention.
- `packages/engine-core/package.json` — added `"./registry"` export entry (types +
  import) alongside the existing `./depth-warm`, `./boundary-primitive` entries.

Did NOT touch `packages/adapters/src/local/setbacks/bastrop-per-parcel-record.ts` — the
hardcoded layer-23 adapter is untouched, exactly as instructed (additive-only, rip-out
is a future task).

Test added: `packages/engine-core/src/registry/__tests__/loader.test.ts` (5 tests):
loader returns Bastrop's full row correctly by FIPS "48021" (all fields asserted); returns
null for an un-onboarded FIPS (48453 / Travis, deliberately picked because it IS a
HIGH_PROP_ID_BAD_RATE county in the source data, to make clear that absence ≠ a routing
decision, it's simply not yet onboarded); requireRegistryRowByFips throws
RegistryRowNotFoundError on a bogus FIPS; requireRegistryRowByFips returns the row for
48021; listRegistryFipsCodes includes 48021.

### Verification (2026-08-02)

`pnpm run typecheck` (tsc --noEmit) in `packages/engine-core`: clean, zero errors.
`pnpm run build` (tsc -b) in `packages/engine-core`: clean, zero errors.
`pnpm vitest run src/registry`: 1 file, 5 tests, ALL PASS.
Full engine-core suite (`pnpm run test`): 89 test files, 598 passed, 2 skipped
(pre-existing skips, unrelated to this change), 0 failed.

GATE A4: PASS. Build + tsc + test green. Loader returns Bastrop's frozen row
correctly by FIPS lookup.

---

## Task A5 — Close R7 at primitive bake

File: `packages/engine-core/src/boundary-primitive/compute.ts`.

Found `resolveSetbackForEdge` (originally lines 97-122) — the function the dispatch
pointed at (~line 104 was exactly the unconditional `unmapped-adjacency` decline on any
`adjacencyKind === "unmapped"` edge, regardless of whether the edge's ROLE was known).

### Key finding before implementing: how "role known" is actually represented

`computeBoundaryEdgeAtoms` calls `labelEdgesFromRoads` ONCE for the whole parcel ring
(not per-edge). Read `edgeLabeling.ts`: it is all-or-nothing — either EVERY edge in the
ring gets a resolved role (front/side/rear/side_corner) via `{ ok: true, edgeLabels }`,
or the WHOLE thing declines via `{ ok: false, decline: <reason> }` (reasons:
invalid-parcel-ring, no-roads-available, no-road-adjacency,
front-orientation-unresolved). When it declines, `edgeLabels = []` at the call site, and
EVERY edge's `role` falls back to the hardcoded default `"side"` — that fallback is NOT
a resolved fact, it is a punt. So "genuinely role-unknowable" (per dispatch language)
= `labelResult.ok === false` for the parcel = `labelByIndex.get(i)` returns `undefined`
for edge i. "Known role" = `labelByIndex.get(i)` returns a real label. This is the
correct signal to thread into R7, NOT a per-role check on the (already-defaulted) role
string itself.

### Implementation

1. `resolveSetbackForEdge` gained a `roleIsKnown: boolean` parameter. The unconditional
   `if (adjacencyKind === "unmapped")` decline became
   `if (adjacencyKind === "unmapped" && !roleIsKnown)` — i.e., decline ONLY when BOTH
   adjacency is unmapped AND the role is genuinely unresolved. When adjacency is
   unmapped but role IS known, falls through to the existing
   `resolveDistrictEdgeSetback(descriptor, district, role)` call (the same flat
   district-table-by-role resolver already used for the mapped-adjacency path — no new
   resolution logic needed, R7 just widens WHEN it's reached).
2. Call site: `const roleIsKnown = label != null;` (where `label =
   labelByIndex.get(i)`), passed through to `resolveSetbackForEdge`.

No other files touched for A5.

### Ripple check — existing test preserved

`boundary-primitive.test.ts` "U2.3 unmapped edges do not invent setback feet" uses
`roads: []` (zero roads) -> `labelEdgesFromRoads` declines with `no-roads-available` ->
`edgeLabels = []` -> every edge has `roleIsKnown = false` -> R7's new condition still
declines exactly as before. Verified this test PASSES unchanged (see full suite run
below) — confirms R7 did not weaken the genuinely-unknown-role case.

### Tests added

`packages/engine-core/src/boundary-primitive/__tests__/r7-known-role-unmapped-adjacency.test.ts`
(2 tests, "R7 — known role + unmapped adjacency resolves to district default (A5)"):

1. "known role (front, via situs-street-match) + no neighbor/ROW adjacency -> district
   default setback, not decline" — isolated single-parcel fixture (no neighbor parcels
   registered at all in the adjacency index), one road matched to the parcel via situs
   address so `labelEdgesFromRoads` succeeds for the whole ring. Debug-verified
   (temporary throwaway test, removed) the actual per-edge shape: front edge lands on
   `adjacencyKind: "ROW"` (matched to the supplied road — already-mapped, unaffected by
   R7, asserted here only to confirm labeling worked). Rear/side edges (3 of 4 edges)
   land on `adjacencyKind: "unmapped"` (isolated parcel, no neighbor, no road touches
   those edges) with a GENUINELY KNOWN role (rear/side, resolved by
   `labelEdgesFromRoads` for the whole ring) — asserts these now resolve to the SF-1
   district defaults (30ft rear / 10ft side) via `district-setback-table` provenance,
   NOT `unmapped-adjacency` decline. This is gate case (1) from the dispatch.
2. "genuinely-unknown role (no roads at all, labeling declines) -> still declines
   unmapped-adjacency, unchanged" — same ring, `roads: []`. Asserts EVERY edge still
   declines with `{ kind: "unmapped-adjacency", reason: <string> }` and no `feet` key —
   preserving R7's carve-out for genuinely role-unknowable edges. This is gate case (2)
   from the dispatch.

### Verification (2026-08-02)

`pnpm run typecheck` (tsc --noEmit) in `packages/engine-core`: clean, zero errors.
`pnpm run build` (tsc -b) in `packages/engine-core`: clean, zero errors.
`pnpm vitest run src/boundary-primitive/__tests__/r7-known-role-unmapped-adjacency.test.ts`:
1 file, 2 tests, ALL PASS.
Full engine-core suite (`pnpm run test`): 90 test files, 600 passed, 2 skipped
(pre-existing, unrelated), 0 failed — includes U2.3 unmapped-edges-honest-decline
UNCHANGED and PASSING.

GATE A5: PASS. Build + tsc + test green. Both new R7 test cases pass. No other
tests broke — did NOT need to stop/revert/punt this task.

---

## Task A6 — Determinism: timestamp out of content-hash

### Grep findings (2026-08-02)

Searched engine-core for hash/signature computation
(`sha256HexCanonical|contentHash|inputSignature|idempotency`). Found the pattern is
NOT confined to promote.ts/warm-compute.ts — it is a repo-wide convention across
EVERY property/road atom emitter. Every one of these emitter files does the identical
thing: build `instance` with `contentHash: ""` as a placeholder field, THEN compute
`instance.contentHash = sha256HexCanonical(JSON.stringify(instance))` — hashing the
WHOLE atom object, timestamps included:

- `property-reasoning/emit-buildable-envelope.ts` (buildable-envelope atom — feeds
  depth-warm promote.ts, IN SCOPE)
- `property-reasoning/emit-setback-rule.ts` (setback-rule atom — feeds depth-warm
  promote.ts, IN SCOPE)
- `boundary-primitive/compute.ts` (property-boundary-edge atom — the A5-touched file,
  part of the warm/inset/cert path, IN SCOPE)
- `property-reasoning/emit-zoning-fact.ts` (zoning-fact atom, x2 call sites — OUT OF
  SCOPE for this dispatch, not on the depth-warm promote path; NOT changed)
- `road-intake/emit-road-node.ts`, `emit-county-road-node.ts`,
  `emit-county-roadway-node.ts`, `emit-caldwell-cad-road-node.ts` (road-node atoms —
  OUT OF SCOPE, not on the depth-warm promote path; NOT changed)

GROUND-TRUTH (2026-08-02, confirmed by reading `emit-buildable-envelope.ts` line 64-107
and `emit-setback-rule.ts` line 144-259): timestamps ARE currently included in the
hash. `instance.fetchedAt = extractedAt`, `instance.extractedAt = extractedAt`,
`instance.versionStamp` embeds the raw timestamp string
(`${entityId}:${kind}:${version}:${extractedAt}`), and nested
`instance.readContract.assembledAt` / `instance.readContract.axes.consequence.assertedAt`
are also timestamp fields, all inside the object that gets `JSON.stringify`'d and
hashed. This directly violates rewarm-determinism: two rewarms of identical inputs
at different wall-clock times would produce different atoms.

### Scope decision

Fixed the 3 files that are actually on this dispatch's warm/inset/cert path
(buildable-envelope, setback-rule, property-boundary-edge). Did NOT touch
zoning-fact or the 4 road-node emitters — same bug pattern, but genuinely out of
scope for "Phase A foundation" (dispatch names promote.ts/warm-compute.ts as the
locus; property-boundary-edge is in-scope because A5 already touched compute.ts and
it's explicitly named in the standing invariants as part of the warm/inset/cert
path). Flagging as OPEN below rather than silently expanding the diff.

### Implementation

`packages/engine-core/src/property-reasoning/confidence.ts` — added three new
exports, no existing export removed or changed in signature:
1. `CONTENT_HASH_EXCLUDED_KEYS` (module-private Set): fetchedAt, extractedAt,
   assembledAt, assertedAt, warmAt, warmVerifiedAt, depthWarmVerifiedAt, promotedAt,
   versionStamp, contentHash.
2. `stripTimestampsForHash(value)`: recursive deep-clone that drops any object key
   in the excluded set AT ANY NESTING DEPTH (handles the nested
   `readContract.assembledAt` / `readContract.axes.consequence.assertedAt` case, not
   just top-level fields — a flat top-level omit would have missed those).
3. `contentHashExcludingTimestamps(instance)`: `sha256HexCanonical(JSON.stringify(
   stripTimestampsForHash(instance)))` — drop-in replacement for the old
   `sha256HexCanonical(JSON.stringify(instance))` call pattern.

Applied `contentHashExcludingTimestamps` in place of the old pattern in:
- `property-reasoning/emit-buildable-envelope.ts` (import swapped, 1 call site).
- `property-reasoning/emit-setback-rule.ts` (import swapped, 1 call site).
- `boundary-primitive/compute.ts` (import swapped, 1 call site — this is the SAME
  file A5 touched; A5's `roleIsKnown` change and A6's hash change are independent
  edits to the same file, both verified together).

`contentHash: ""` placeholder pattern is UNCHANGED in all three files (still needed —
the field must exist before stripTimestampsForHash normalizes the object shape;
`contentHash` itself is in the excluded-keys set so the placeholder empty string
never pollutes the hash of a re-hash / doesn't matter either way).

### Tests added

`packages/engine-core/src/property-reasoning/__tests__/content-hash-determinism.test.ts`
(4 tests, 2 describe blocks):

"stripTimestampsForHash / contentHashExcludingTimestamps (A6 unit)":
1. "strips timestamp keys at any nesting depth" — a synthetic object with
   fetchedAt/extractedAt/assembledAt/assertedAt/versionStamp/contentHash at top level
   AND nested 2 levels deep; asserts the stripped result keeps only non-timestamp
   keys at every depth.
2. "two objects identical except timestamp values hash equal" — two objects sharing
   geometry/district content but different fetchedAt/extractedAt/nested
   readContract.assembledAt; asserts `contentHashExcludingTimestamps` returns the
   SAME hash for both.
3. "two objects differing in real content hash differently" — negative control:
   same timestamp, different `district` field; asserts hashes DIFFER (proves the
   function isn't just returning a constant).

"promoted atom content hash is rewarm-deterministic (A6 integration)":
4. "two promotions of identical warm content at different extractedAt hash equal" —
   builds a real `WarmCandidate` via `computeWarmCandidate` (same fixture as the
   existing warm-verify-loop tests: PARCEL_714_SPRING_33512 + edgeLabels714SpringHonest),
   then calls `emitDepthWarmPromotion` TWICE with the same candidate but
   `extractedAt: "2026-01-01T00:00:00.000Z"` vs `extractedAt: "2026-12-31T23:59:59.000Z"`.
   Asserts: both buildable-envelope atoms' `contentHash` are equal and non-empty; both
   setback-rule atoms' `contentHash` are equal and non-empty; sanity-checks the two
   promotions really DID carry different `extractedAt` values (proving the test isn't
   accidentally comparing identical inputs).

### Verification (2026-08-02)

`pnpm run typecheck` (tsc --noEmit) in `packages/engine-core`: clean, zero errors.
`pnpm run build` (tsc -b) in `packages/engine-core`: clean, zero errors.
`pnpm vitest run src/property-reasoning/__tests__/content-hash-determinism.test.ts`:
1 file, 4 tests, ALL PASS.
Full engine-core suite (`pnpm run test`): 91 test files, 604 passed, 2 skipped
(pre-existing, unrelated), 0 failed. No test anywhere in the suite asserts a literal
contentHash string value (grepped `contentHash.*toBe\(['"]` — zero matches), so no
existing test could have broken from a hash-value change; confirmed none did.

GATE A6: PASS (code-change branch — timestamps WERE included in the hash prior to
this change; fixed, not a no-op). Build + tsc + test green. Content-hash is
timestamp-independent, verified both by direct unit test (stripTimestampsForHash /
contentHashExcludingTimestamps) and by integration test proving two real promoted
atoms built from identical warm content at different extractedAt values hash equal.

### OPEN (for the planner / a future task, not fixed here — scope discipline)

`property-reasoning/emit-zoning-fact.ts` (2 call sites) and all 4 road-node emitters
in `road-intake/` (`emit-road-node.ts`, `emit-county-road-node.ts`,
`emit-county-roadway-node.ts`, `emit-caldwell-cad-road-node.ts`) have the IDENTICAL
timestamp-in-hash bug pattern and were NOT fixed by this task — they are outside the
depth-warm/boundary-primitive promote path this Phase A dispatch scopes to. If
rewarm-determinism matters for zoning-fact or road-node atoms too (plausible — they're
also part of the frozen-input rewarm state), the same `contentHashExcludingTimestamps`
helper in `confidence.ts` is ready to drop into those 5 remaining call sites with the
same 2-line swap pattern used here.

---

## FINAL STEPS — full monorepo build/tsc/test on branch HEAD

Branch HEAD after all 5 tasks: `76629f2e7626ad439156fe44b34029a8e07d1381`
(`feat/phase-a-foundation`, 6 commits ahead of the `a156497` origin/main tip at clone
time: fec86e0 A2, eb7e5ef A2-notes, ecf0c4d A3, 1fa1c9d A4, 309edd6 A5, 76629f2 A6).

Ran from repo root (`P:/tmp/phase-a-engine-20260802`), not just engine-core, so this
covers all 19 typecheck/build-scripted workspace projects (adapters, atoms, storage,
corpus, document-ingest, engine-core, workspace, retrieval, services/engine-api,
services/pipeline-runner, services/retrieval-api, identity, og-sources, og-title,
atom-contract-pin, tools/permit-outcome-cli, tools/rrc-ratio-report, tools/ingest-cli,
tools/migrate-legacy-codes).

`pnpm run typecheck` (root, `pnpm -r run typecheck`): every project reported "Done",
zero tsc errors anywhere.

`pnpm run build` (root, `pnpm -r run build`): every project reported "Done", zero tsc
errors anywhere.

`pnpm run test` (root, `pnpm -r run test`): exit code 0. Per-package summary (raw
Vitest "Test Files" / "Tests" lines, grepped from the full run, saved at
`_scratch/full-test-output.txt` in this worktree — NOT committed, too large/noisy for
the repo; reproducible by re-running `pnpm run test` from repo root on this commit):

```
packages/og-sources test:       Test Files  3 passed (3)       Tests  23 passed (23)
packages/og-title test:         Test Files  4 passed (4)       Tests  34 passed (34)
packages/adapters test:         Test Files  28 passed (28)     Tests  400 passed (400)
packages/atoms test:            Test Files  8 passed (8)       Tests  140 passed (140)
packages/storage test:          Test Files  5 passed (5)       Tests  18 passed (18)
packages/workspace test:        Test Files  1 passed (1)       Tests  6 passed (6)
packages/document-ingest test:  Test Files  2 passed (2)       Tests  15 passed (15)
packages/corpus test:           Test Files  14 passed (14)     Tests  111 passed (111)
packages/engine-core test:      Test Files  91 passed (91)     Tests  604 passed | 2 skipped (606)
tools/migrate-legacy-codes test: Test Files 8 passed (8)       Tests  36 passed (36)
packages/retrieval test:        Test Files  3 passed (3)       Tests  17 passed (17)
services/engine-api test:       Test Files  17 passed (17)     Tests  99 passed (99)
services/retrieval-api test:    Test Files  13 passed (13)     Tests  79 passed (79)
```

Totals: 197 test files passed, 1582 tests passed, 2 skipped (both pre-existing,
in `packages/engine-core` — the LIVE-gated Block-13-network boundary-primitive tests
that `.skipIf(!LIVE)` when `BOUNDARY_LIVE_TEST` env is unset; unrelated to any Phase A
change), 0 failed. Root command exit code: 0.

GATE (final): PASS. Full monorepo build + typecheck + test all green on branch HEAD.
Ready for PR.

---

