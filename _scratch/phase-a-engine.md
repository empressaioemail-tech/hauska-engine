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
