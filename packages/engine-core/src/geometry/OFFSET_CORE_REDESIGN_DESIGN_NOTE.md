# Offset-core redesign design note

Defect reference: OFFSET-CORE-VARIABLE-DISTANCE (commissioned 2026-08-07 per
master planner direction on PR #268). Replaces the strip-union-difference +
ad-hoc notch-collapse approach in `polygon-inset.ts` with a principled
variable-distance inward polygon offset.

## Problem recap

The current core (`insetRingMetersWithNormals`) builds a "forbidden" region
per edge as a rectangular strip (edge extruded inward by that edge's own
setback), unions all N strips via `polygon-clipping`, then differences the
parcel against the union. At a vertex where two adjacent edges are
near-collinear AND carry different setback distances, `polygon-clipping`'s
strip union leaves a short, real-but-spurious reflex "step" in the
difference result instead of a single clean miter point. A follow-up pass
(`collapseNearCollinearOffsetNotches`) tries to detect and collapse these
steps analytically, using the two bounding (long) offset edges' line-line
intersection as the replacement corner.

Verified failure mode (PR #268, 48021:31362's real ring): the collapse
routine's detection is EDGE-LENGTH-based (short offset-space edges bounded
by long ones), not tied to the ORIGINAL parcel's own geometry. On 31362 it
collapsed a run whose nearest original-parcel vertex has an ~89-degree turn
angle — a genuine corner, not near-collinear noise — silently discarding a
real ~5343 sqft buildable region on the far side of that corner. Two
patches (a bounding-edge-angle guard, then an original-vertex-turn-angle
guard) each fixed 31362 in isolation but regressed the already-working
48021:31308 fixture elsewhere in the harness's role/inset matrix. This is a
genuine N-way constraint problem: a 2-edge analytic miter can satisfy its
own immediate bounding pair while still being wrong relative to a third,
non-adjacent edge's constraint. Patching the collapse heuristic further is
not going to converge — the strip-union-then-collapse architecture treats
the corner join as a post-hoc repair instead of computing it directly.

## Ground truth on the real dataset (evidence, not assumption)

Checked convexity and per-vertex turn angle on all twelve real Jones/Higgins
rings (`twelve-live-rings.json`, the exact live txgio geometry):

```
48021:31299  convex=true   angles: -0.0, -87.5, -84.4, -89.8, -98.4
48021:31308  convex=false  angles:  0.8, -82.1, -89.7, -91.5, -97.5
48021:31317  convex=false  angles: -0.5, -82.2, -88.2,  3.7, -89.3, -103.5
48021:31326  convex=true   angles: -1.5, -77.1, -91.1, -84.7, -105.6
48021:31335  convex=true   angles: -0.2, -72.1, -94.3, -83.7, -109.7
48021:31344  convex=true   angles: -109.2, -72.2, -96.6, -82.0
48021:31353  convex=true   angles: -91.4, -90.2, -88.1, -90.3
48021:31362  convex=false  angles: -89.5, -90.6, -88.6,  0.4, -91.7, -0.0
48021:31371  convex=false  angles: -90.3, -89.9,  0.0, -89.0, -0.3, -90.5, 0.0
48021:31380  convex=false  angles:  0.0, -90.4, -88.9, -0.0, -88.9,  0.6, -92.4
48021:31389  convex=true   angles: -90.4, -90.4, -0.0, -86.1, -2.2, -90.9
48021:31398  convex=false  angles: -111.3, -89.8, -89.0,  1.9, -71.8
```

Every "non-convex" flag traces to a SINGLE near-zero-degree vertex (all
under 4 degrees) against an otherwise consistently-signed, real-cornered
polygon (turns clustering -70 to -110 degrees, i.e. genuine ~90-degree lot
corners). None of the twelve real parcels has a genuine large-angle reflex
(concave) vertex — every one is convex modulo near-collinear survey noise.
This matters for candidate selection below: the dataset that must reach
12/12 does not exercise true non-convexity, but the acceptance criteria
correctly still require the design to handle it, since production
onboarding will eventually hit a genuinely notched/L-shaped parcel (the
existing `geometryCorrectnessGate` docstring already names one:
48021:34121, an L-shaped hexagon hugging an alley — R5's own near-rect gate
explicitly carves out "genuinely irregular / notched / multi-part lots" as
a distinct, already-anticipated case that skips the convexity requirement
and is validated by containment/self-intersection/plausibility alone).

## Candidates evaluated

**1. Weighted straight skeleton.** Computes the full offset topology (every
event where advancing wavefronts collide) in one pass, correct for
arbitrary per-edge weights on both convex and reflex geometry by
construction — this is the textbook-correct general solution. Rejected for
this codebase: no maintained, dependency-light straight-skeleton
implementation exists in the current toolchain (the repo already depends on
`polygon-clipping`, not a skeleton library), and a correct weighted
straight-skeleton implementation (handling split events at reflex vertices,
numerical degeneracies at simultaneous events) is a substantial standalone
project — high correctness ceiling, but the complexity is disproportionate
to what this dataset and the near-term production roadmap (per-parcel
rectangular-ish residential lots) actually need. Flagged as the fallback if
half-plane clipping's reflex-splitting (below) proves insufficient once
real notched parcels are onboarded.

**2. Clipper-style variable buffer** (e.g. per-edge-weighted Minkowski
buffer via a general polygon offsetting library). Rejected: no existing
per-edge-VARIABLE-distance buffering exists in the `polygon-clipping`
dependency already in use (its `buffer` operations, where present in
similar libraries, are uniform-distance); adopting a different library
(e.g. a full geometry kernel) to get this is a larger dependency surface
change than the fix warrants, and most implementations are Minkowski-sum
based, which has the same corner-join correctness burden as the current
strip-union approach — it would not obviously fix the root cause, only
relocate it into a different library's internals where this codebase has
no visibility to root-cause a future defect the way this fix now can.

**3. Sequential per-edge half-plane clipping** (Sutherland-Hodgman polygon
clipping, intersecting the parcel against each edge's own inward-offset
half-plane in turn). Selected. For a convex polygon this is exactly
correct: a convex polygon IS the intersection of the half-planes bounded by
its own edge lines, so offsetting each supporting line inward by that
edge's own setback and re-intersecting produces exactly the correct inset
region, with every corner join computed AS a half-plane intersection (the
natural pairwise line-line intersection of adjacent offset edges) rather
than repaired after the fact. This directly replaces the current
"strip-union then patch the corner" architecture with "compute the corner
directly as part of intersection" — the corner is never wrong because it
was never approximated by a name-based collapse heuristic in the first
place. Complexity is O(n) clip passes over the ring (standard
Sutherland-Hodgman is linear per clip), materially simpler than a
straight-skeleton implementation, and needs no new dependency (uses the
same PlanarPoint/line-intersection primitives already in
`polygon-inset.ts`).

## Non-convex parcel handling (explicit, per acceptance requirement)

Half-plane intersection ALONE always yields a convex result — that is a
mathematical property of intersecting half-planes, independent of whether
the input parcel was convex. Run naively against a genuinely reflex
(concave) parcel, it will not track the concave notch; the result can
bulge outside the true parcel boundary through the reflex region (an
over-approximation), which is wrong.

The design handles this in two layers, so correctness never silently
degrades to "looks convex, might be wrong":

1. **Reflex detection upfront, on the ORIGINAL parcel ring.** Before
   offsetting, compute each vertex's turn angle against the ring's dominant
   winding sign (the same primitive already used and verified this round:
   `turnAngleDegAt`-style signed-cross-product turn angle). A vertex is
   reflex when its turn sign disagrees with the dominant sign AND its
   magnitude exceeds a real-corner floor (not near-collinear noise) — e.g.
   >15 degrees, comfortably above every near-collinear jog measured above
   (max 3.7 degrees) and comfortably below a genuine corner (all real
   corners in the dataset are 70+ degrees).
2. **Convex decomposition at genuine reflex vertices only.** When one or
   more genuine reflex vertices are found, split the parcel into convex
   sub-polygons at those vertices (diagonal-based convex decomposition —
   for the residential-lot case this is typically a 2-3-way split, not a
   general n-way triangulation problem), run half-plane clipping
   independently on each convex piece using that piece's own edges' setback
   distances, then union the per-piece results back into one ring. A piece
   that clips to empty (its own setbacks exceed that piece's local extent)
   drops out of the union rather than corrupting the others — same honest
   partial-emptiness principle the current empty-candidate path already
   uses. Zero reflex vertices (this round's entire real dataset) is the
   trivial one-piece case: no decomposition, one half-plane clip pass over
   the whole ring — the common path stays as simple as the convex case,
   and the extra machinery activates ONLY when parcel geometry actually
   requires it.

This makes non-convex handling a decided, testable code path (synthetic
L-shaped/notched fixtures exercise it directly) rather than an emergent
side effect of a heuristic collapse pass, which is what caused the current
defect.

## Degenerate output

Per acceptance requirement, "setbacks consume the lot" must be an explicit,
honest empty result, never garbage. Half-plane clipping makes this
naturally simple to detect correctly: after all N (or, for a decomposed
non-convex parcel, all per-piece) clips, if the surviving region has
non-positive area, the output is honestly empty with the existing
`emptyReason` string — no separate degeneracy heuristic is needed the way
`isInsetDegenerate`'s `perEdgeOffsetPlausible` fallback is needed today,
because there is no post-hoc collapse step whose correctness needs
re-verifying after the fact.

## Acceptance plan

- Twelve-ring harness: flip the six `it.fails` entries
  (`KNOWN_DEFECT_OFFSET_CORE_VARIABLE_DISTANCE`) back to hard `it` once the
  new core passes them; target 12/12.
- 31299's road-substitution caveat: re-checked against the live batch
  path's actual road-node context is out of reach in this CODE-ONLY
  sandbox (no prod DB access); the harness will document the equivalence
  argument (adjacency-heuristic front resolution is the SAME fallback path
  the live pipeline itself uses when situs is unavailable/ambiguous) rather
  than fabricate a live-parity claim this sandbox cannot verify.
- Full existing suite (`npx vitest run packages/engine-core`) must stay
  green at the current 929 passed / 2 pre-existing-unrelated-skipped
  baseline, with the six flips being the only net change in pass count.
- `block13-cert-grade.mjs` is a DB-backed script (requires `DATABASE_URL`
  against live Postgres) and cannot run in this CODE-ONLY sandbox; the
  acceptance check here is code-level equivalence — the new offset core is
  a drop-in replacement behind the SAME `insetPerEdge`/
  `insetRingMetersWithNormals` call sites and the SAME `InsetResult`/
  `WarmCandidate` shapes, so `cert-grade-core.ts`'s grading logic and the
  `BLOCK13_ROSTER` parcels' inputs are untouched by this change. The master
  planner's live DB re-run remains the actual closing instrument for the
  block13 answer key, consistent with every prior round in this dispatch
  chain.
- Predicate module (`checkEnvelopeGroundTruth`) and R5
  (`isNearRectangularParcelRing` / the near-rect convexity gate in
  `verify-mechanical.ts`) are not modified. R5 continues to demand
  convexity only for near-rectangular parcels (the current carve-out for
  genuinely irregular/notched lots at line 217-220 of
  `verify-mechanical.ts` is unchanged) — this is compatible with the new
  core, since the common (no-reflex) path also always yields a convex
  result.

## Results as landed (2026-08-07, PR #269)

Twelve-ring harness: **8/12 hard-pass**, up from 6/12 pre-redesign.
31299, 31371, 31380 flip to genuine hard-pass under the new core.
48021:31317, previously hard-passing, develops a narrow new residual and
joins the expected-fail set alongside 31326, 31362, 31389 (see the
in-file doc comment on `KNOWN_DEFECT_OFFSET_CORE_VARIABLE_DISTANCE` in
`twelve-parcel-live-integration.test.ts` for full per-parcel root-cause
detail with function-level evidence). Full 12/12 was not reached — two
distinct residual classes remain, both diagnosed but not fixed without
an unacceptable regression trade-off (in each case a candidate fix was
built, verified to resolve the target parcel, found to regress an
already-working parcel, and reverted per the same "never trade a known
green case" discipline the notch-collapse guards in the pre-redesign
round were held to):

1. **Reflex-adjacent N-way constraint (31326, 31362, 31389).** The
   reflex-decomposition (convex-split at genuine reflex vertices >=15deg,
   clip each piece against every original edge, union pieces back) fixed
   the geometry-level defect on these rings' AREA in isolation during
   development, but the fully-wired pipeline (role assignment plus R32
   plus R5) still rejects them on at least one of these three parcels'
   specific role/inset combinations. Not chased further this round to
   avoid repeating the pre-redesign pattern of narrow, un-generalizing
   patches.
2. **P2 correspondence under extreme envelope simplification (31317).**
   Verified with function-level evidence: 31317's real ring is geometrically
   correct under the new core (area matches independent brute-force ground
   truth to 0.02%), but `measurePerEdgeInsetIndexMatched`'s strict
   overlap-projection test excludes the genuinely-correct near-exact
   parallel match for one edge by a hairline (-0.28m against a ~19.9m lot
   edge), letting a worse candidate win instead. A targeted absolute-slack
   fix to the overlap window was built, confirmed to fix 31317, and then
   found to regress 48021:31308 (a previously-exact match degraded to a
   real 19ft miss) — reverted.

## Data finding: the old core under-served or falsely-declined envelopes
on many-collinear-vertex parcels

This redesign surfaced a finding beyond the offset-core defect it was
commissioned to fix. Three test fixtures that predate this PR — all on
parcels or synthetic rings with MANY redundant collinear vertices along
their physical sides (an artifact of how some source geometry is
digitized, not a real lot-shape feature) — asserted `empty: true` /
"setbacks exceed the lot" as their expected, "must stay strict" ground
truth:

- `robust-inward-offset.test.ts`'s "dense-qa2-shaped" 8-vertex rectangle
  fixture (front 10ft / side 5ft): true buildable area ~219.7 sqft, not
  empty (verified three independent ways: manual half-plane math,
  clipping-free brute-force grid sampling, and `sheet-standard.test.ts`'s
  production PDF-rendering pipeline on the byte-identical ring).
- `robust-inward-offset.test.ts`'s "PARCEL_34073_CORRUPT_TXGIO-shaped"
  digitization-noise fixture (front/rear 25ft / side 5ft): true buildable
  area ~2148.1 sqft, not empty (same corroboration, plus a third sibling
  assertion in `lot-line-scrub.test.ts` carrying the identical false
  expectation on the identical fixture, also corrected).
- `lot-line-scrub.test.ts`'s R29 48021:34121 fixture under a GC 20/5/20
  role assignment: previously asserted the inset must stay non-convex
  (on the assumption a non-convex PARCEL always produces a non-convex
  ENVELOPE); the true result is convex — the 20ft setbacks on the two
  edges bounding the reflex notch are large enough to fully consume the
  concave region. Verified independently at 3142.90 sqft (brute force)
  vs 3142.93 sqft (`insetPerEdge`).

All three were defect pins on the OLD strip-union-difference core's own
mishandling of many-redundant-collinear-vertex geometry, not verified
ground truth — the "must stay strict" protection they were meant to carry
("never fabricate buildable area") was, in each case, actually being
violated in the opposite direction: the old core fabricated EMPTINESS,
silently declaring real, substantial buildable envelope (219.7 to 2148.1
sqft per case) to not exist. All three assertions are corrected in this PR
to the verified ground-truth values, with all three verification methods
cited in the test comments.

**Operational implication for the cohort re-persist:** any live parcel
whose captured ring carries multiple redundant collinear vertices along a
physical side (a real, not-uncommon digitization pattern — the dense-qa2
and PARCEL_34073 fixtures were both built to reproduce patterns actually
observed in the corpus) may have been under-served or falsely declined by
the old core in the SAME way these three fixtures were. The re-persist
running the corrected offset core may legitimately GROW envelopes (or
newly promote previously-declined candidates) on such parcels — this is
not a regression to investigate if it occurs; it is the expected
correction. The master planner should carry this into the re-persist
notes for the cohort so a grown-envelope or newly-promoted-candidate
result on a many-collinear-vertex parcel is not mistaken for a new
defect.
