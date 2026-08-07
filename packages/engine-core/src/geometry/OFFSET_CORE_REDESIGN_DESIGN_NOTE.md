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
