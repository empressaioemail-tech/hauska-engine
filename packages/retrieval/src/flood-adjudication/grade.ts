/**
 * The grader. Pure, so it is identical for a fixture and for a live county and
 * cannot quietly behave differently for the one that runs in CI.
 */

import {
  classifySamplePointContainment,
  countTestableRings,
} from "@hauska-engine/engine-core/flood-hazard-fact";

import {
  DECLARED_BANDS,
  type FloodAdjudicationBands,
  type FloodAdjudicationCase,
  type FloodAdjudicationFinding,
  type FloodAdjudicationLeg,
  type FloodAdjudicationReport,
  type FloodAdjudicationScope,
  type LegTally,
  type SamplePointSource,
} from "./types.js";

/** FEMA zone codes compare case-insensitively and never by whitespace. */
export function normalizeZone(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = String(value).trim().toUpperCase();
  return v === "" ? null : v;
}

function tally(): LegTally {
  return { checked: 0, failed: 0, unmeasurable: 0 };
}

export function gradeFloodAdjudication(
  cases: ReadonlyArray<FloodAdjudicationCase>,
  scope: FloodAdjudicationScope,
  bands: FloodAdjudicationBands = DECLARED_BANDS,
  opts?: { maxFindingsPerLeg?: number },
): FloodAdjudicationReport {
  // Examples PER LEG, not the first N overall. A head-of-list sample shows only
  // whichever leg happens to fire first, and on the first live run of this
  // instrument that was the stamp leg firing 2,000 times and burying every
  // divergence example behind it.
  const maxPerLeg = opts?.maxFindingsPerLeg ?? 12;
  const findings: FloodAdjudicationFinding[] = [];
  const perLeg = new Map<FloodAdjudicationLeg, number>();
  const enabled = new Set<FloodAdjudicationLeg>(scope.legs);
  const push = (f: FloodAdjudicationFinding) => {
    const n = perLeg.get(f.leg) ?? 0;
    if (n >= maxPerLeg) return;
    perLeg.set(f.leg, n + 1);
    findings.push(f);
  };

  let withAtomSamplePoint = 0;
  let withTestableRing = 0;
  let withPostgisGeom = 0;
  let withNfhlAnswer = 0;
  const bySamplePointSource: Record<SamplePointSource, number> = {
    "atom-stamp": 0,
    "re-derived": 0,
    none: 0,
  };

  const stampPresent = tally();
  const stampEmittable = tally();
  const containmentDivergence = tally();
  const zoneAdjudication = tally();
  const zoneOnStandIn = tally();

  let contained = 0;
  let notContained = 0;
  let unmeasurable = 0;

  for (const c of cases) {
    bySamplePointSource[c.samplePointSource] += 1;
    if (c.atomSamplePoint != null) withAtomSamplePoint += 1;

    const rings = countTestableRings(c.parcelGeometry);
    if (rings > 0) withTestableRing += 1;

    // ---- leg 1: is there a stamp at all?
    if (enabled.has("stamp-present")) {
      stampPresent.checked += 1;
      if (c.atomContainment == null || c.atomSamplePoint == null) {
        stampPresent.failed += 1;
        push({
          leg: "stamp-present",
          parcelNodeId: c.parcelNodeId,
          detail:
            "atom carries no sample point or no containment stamp: written by a writer with no containment gate, so it is UNCHECKED, which is a different state from checked-and-passing",
        });
      }
    }

    // ---- leg 2: does the stamp claim something we refuse to publish?
    if (enabled.has("stamp-emittable")) {
      if (c.atomContainment == null) {
        stampEmittable.unmeasurable += 1;
      } else {
        stampEmittable.checked += 1;
        if (c.atomContainment === "not-contained") {
          stampEmittable.failed += 1;
          push({
            leg: "stamp-emittable",
            parcelNodeId: c.parcelNodeId,
            detail:
              "a determination stamped not-contained reached the store: the gate was bypassed",
          });
        }
      }
    }

    // ---- containment states, over the point actually adjudicated.
    //
    // The JS side is the SHIPPING predicate from engine-core, imported rather
    // than re-implemented. A re-implementation here would be a third opinion
    // agreeing with itself.
    const js = classifySamplePointContainment(
      c.samplePointUsed,
      c.parcelGeometry,
    );
    if (js.state === "contained") contained += 1;
    else if (js.state === "not-contained") notContained += 1;
    else unmeasurable += 1;

    // ---- leg 3: two implementations of containment must agree.
    if (enabled.has("containment-divergence")) {
      if (c.postgisContains == null) {
        // No PostGIS geometry for this parcel. UNMEASURABLE, never a pass and
        // never a fail: SS-W15 measured geom on zero features in 189 of 253
        // counties holding parcels, so this is the common case statewide and
        // scoring it either way would be a fabricated number.
        containmentDivergence.unmeasurable += 1;
      } else if (c.samplePointUsed == null) {
        // Nothing was adjudicated, so there is nothing to diverge about.
        containmentDivergence.unmeasurable += 1;
      } else {
        withPostgisGeom += 1;
        if (js.state === "unmeasurable") {
          // PostGIS has a ring and the JS side does not. A divergence in the
          // INPUTS rather than in the predicate, and a real finding: the two
          // geometry columns of one table disagree about whether this parcel
          // has a shape.
          containmentDivergence.checked += 1;
          containmentDivergence.failed += 1;
          push({
            leg: "containment-divergence",
            parcelNodeId: c.parcelNodeId,
            detail: `PostGIS geom exists and answers ${c.postgisContains} while the geometry jsonb offers no testable ring (${js.basis})`,
          });
        } else {
          containmentDivergence.checked += 1;
          const jsContains = js.state === "contained";
          if (jsContains !== c.postgisContains) {
            containmentDivergence.failed += 1;
            push({
              leg: "containment-divergence",
              parcelNodeId: c.parcelNodeId,
              detail: `JS ray cast says ${jsContains} and PostGIS ST_Contains says ${c.postgisContains} for the same point and the same parcel`,
            });
          }
        }
      }
    } else if (c.postgisContains != null) {
      withPostgisGeom += 1;
    }

    // ---- leg 4: the atom's zone against the external authority.
    if (c.nfhlZoneAtSamplePoint != null) withNfhlAnswer += 1;
    if (enabled.has("zone-adjudication")) {
      const bucket =
        c.samplePointSource === "atom-stamp" ? zoneAdjudication : zoneOnStandIn;

      if (c.atomIsAbsence) {
        // An absence claims no zone. Adjudicating it against NFHL asks a
        // different question (is the absence honest) and is deliberately not
        // this leg's job; counted unmeasurable so it never inflates a pass.
        bucket.unmeasurable += 1;
      } else if (c.atomFloodZone == null) {
        bucket.unmeasurable += 1;
      } else if (c.samplePointUsed == null) {
        bucket.unmeasurable += 1;
      } else if (c.nfhlZoneAtSamplePoint == null) {
        // The point is in no loaded NFHL polygon. Not evidence the atom is
        // wrong; evidence the authority had nothing to say here.
        bucket.unmeasurable += 1;
      } else {
        bucket.checked += 1;
        const want = normalizeZone(c.nfhlZoneAtSamplePoint);
        const got = normalizeZone(c.atomFloodZone);
        if (want !== got) {
          bucket.failed += 1;
          push({
            leg: "zone-adjudication",
            parcelNodeId: c.parcelNodeId,
            detail: `atom says ${got ?? "null"} and NFHL ${c.nfhlEdition ?? "(edition unstated)"} says ${want} at ${
              c.samplePointSource === "atom-stamp"
                ? "the atom's own recorded sample point"
                : "a RE-DERIVED stand-in point (weaker evidence: the atom records no point)"
            }`,
          });
        }
      }
    }
  }

  const breaches: string[] = [];
  if (enabled.has("stamp-present") && stampPresent.failed > bands.maxUnstamped) {
    breaches.push(
      `unstamped determinations ${stampPresent.failed} of ${stampPresent.checked} exceeds the declared band ${bands.maxUnstamped}`,
    );
  }
  if (
    enabled.has("stamp-emittable") &&
    stampEmittable.failed > bands.maxNotContainedStamped
  ) {
    breaches.push(
      `determinations stamped not-contained ${stampEmittable.failed} of ${stampEmittable.checked} exceeds the declared band ${bands.maxNotContainedStamped}`,
    );
  }
  if (
    enabled.has("containment-divergence") &&
    containmentDivergence.failed > bands.maxContainmentDivergences
  ) {
    breaches.push(
      `containment implementation divergences ${containmentDivergence.failed} of ${containmentDivergence.checked} exceeds the declared band ${bands.maxContainmentDivergences}`,
    );
  }
  if (
    enabled.has("zone-adjudication") &&
    zoneAdjudication.failed > bands.maxZoneDisagreements
  ) {
    breaches.push(
      `zone disagreements against NFHL at the atom's own stamped point ${zoneAdjudication.failed} of ${zoneAdjudication.checked} exceeds the declared band ${bands.maxZoneDisagreements}`,
    );
  }

  return {
    scope,
    denominators: {
      casesGraded: cases.length,
      withAtomSamplePoint,
      withTestableRing,
      withPostgisGeom,
      withNfhlAnswer,
      bySamplePointSource,
      countingRule:
        "one count per parcelNodeId presented to the grader. Every leg prints its OWN checked/failed/unmeasurable triple because the legs have different denominators: a parcel with no PostGIS geom is unmeasurable for the divergence leg while still being graded for the stamp leg. Unmeasurable is never folded into checked and never into failed. withTestableRing counts the RING alone and is independent of whether a point exists to test against it.",
    },
    legs: {
      stampPresent,
      stampEmittable,
      containmentDivergence,
      zoneAdjudication,
    },
    zoneAdjudicationOnStandInPoint: zoneOnStandIn,
    containmentStates: { contained, notContained, unmeasurable },
    bands,
    findings,
    pass: breaches.length === 0,
    breaches,
  };
}
