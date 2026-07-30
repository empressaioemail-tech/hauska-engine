/**
 * F3 lot-line geometry scrub — mechanical tests (BDC downtown STEP 3).
 *
 * Specimen 48021:34073 + shared-edge neighbor 48021:34081.
 */

import { describe, expect, it } from "vitest";

import { insetPerEdge, openRing, projectRing } from "../../depth-warm/geometry.js";
import { ringHasSelfTouch, ringSelfIntersects } from "../../geometry/polygon-inset.js";
import { buildParcelAdjacencyIndex } from "../adjacency-grid.js";
import {
  isNearRectangularParcelRing,
  nearRectEnvelopeCheck,
  scrubLotLineRing,
  scrubParcelCohortEntries,
  snapSharedLotLineVertices,
} from "../lot-line-scrub.js";
import {
  DOWNTOWN_DRILL_MANIFEST_PROP_IDS,
  PARCEL_34073_BCAD,
  PARCEL_34073_CORRUPT_TXGIO,
  PARCEL_34081_BCAD,
  PARCEL_34073_SF1_LAYER23,
} from "../fixtures/bastropDowntownDrill.js";
import type { ParcelIndexEntry } from "../types.js";

const COUNTY = "48021";

function entry(propId: string, ring: typeof PARCEL_34073_BCAD, situs?: string): ParcelIndexEntry {
  const lngs = openRing(ring).map((p) => p[0]);
  const lats = openRing(ring).map((p) => p[1]);
  return {
    countyFips: COUNTY,
    propId,
    parcelNodeId: `${COUNTY}:${propId}`,
    situsAddress: situs ?? null,
    ring,
    westLng: Math.min(...lngs),
    southLat: Math.min(...lats),
    eastLng: Math.max(...lngs),
    northLat: Math.max(...lats),
  };
}

/** SF-1 inset for 34073 Jefferson row (layer 23 per-parcel record). */
function sf1InsetFeet34073(ring: typeof PARCEL_34073_BCAD): number[] {
  const n = openRing(ring).length;
  const sb = PARCEL_34073_SF1_LAYER23;
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return sb.front;
    if (i === 2) return sb.rear;
    return sb.side;
  });
}

describe("F3 lot-line geometry scrub (34073 + 34081)", () => {
  it("34073 corrupt txgio ring fails SF-1 inset before scrub", () => {
    const r = insetPerEdge(PARCEL_34073_CORRUPT_TXGIO, sf1InsetFeet34073(PARCEL_34073_CORRUPT_TXGIO));
    expect(r.empty).toBe(true);
    expect(r.emptyReason).toMatch(/setbacks exceed|correctness gate|null/i);
  });

  it("34073 scrubbed from corrupt → near-rect parcel with ≤6-vertex clean envelope", () => {
    const scrubbed = scrubLotLineRing(PARCEL_34073_CORRUPT_TXGIO);
    expect(openRing(scrubbed).length).toBeLessThanOrEqual(5);
    expect(isNearRectangularParcelRing(scrubbed)).toBe(true);

    const inset = insetPerEdge(scrubbed, sf1InsetFeet34073(scrubbed));
    expect(inset.empty, inset.emptyReason).toBe(false);

    const check = nearRectEnvelopeCheck(scrubbed, inset.ring, 6);
    expect(check.pass, check.reasons.join("; ")).toBe(true);
    expect(check.insetVertexCount).toBeLessThanOrEqual(6);

    const insetOpen = openRing(inset.ring!);
    const proj = openRing(inset.ring!);
    expect(proj.length).toBeGreaterThanOrEqual(4);
  });

  it("34073 authoritative BCAD ring: scrub + SF-1 → clean near-rect envelope", () => {
    const scrubbed = scrubLotLineRing(PARCEL_34073_BCAD);
    expect(isNearRectangularParcelRing(scrubbed)).toBe(true);

    const inset = insetPerEdge(scrubbed, sf1InsetFeet34073(scrubbed));
    expect(inset.empty, inset.emptyReason).toBe(false);

    const check = nearRectEnvelopeCheck(scrubbed, inset.ring, 6);
    expect(check.pass, check.reasons.join("; ")).toBe(true);
    expect(check.insetVertexCount).toBeLessThanOrEqual(6);

    const insetProj = inset.ring ? projectRing(inset.ring) : null;
    expect(insetProj).not.toBeNull();
    if (insetProj) {
      expect(ringHasSelfTouch(insetProj.points)).toBe(false);
      expect(ringSelfIntersects(insetProj.points)).toBe(false);
    }
  });

  it("34081 shared-edge neighbor: cohort snap aligns south lot line with 34073", () => {
    const entries = scrubParcelCohortEntries([
      entry("34073", PARCEL_34073_BCAD, "1006 JEFFERSON ST"),
      entry("34081", PARCEL_34081_BCAD, "1004 JEFFERSON ST"),
    ]);

    const r73 = entries.find((e) => e.propId === "34073")!.ring;
    const r81 = entries.find((e) => e.propId === "34081")!.ring;

    const shared73 = openRing(r73).filter(([lng, lat]) =>
      openRing(r81).some(([lng2, lat2]) =>
        Math.hypot(lng - lng2, lat - lat2) < 1e-6,
      ),
    );
    expect(shared73.length).toBeGreaterThanOrEqual(1);

    const inset81 = insetPerEdge(r81, sf1InsetFeet34073(r81));
    expect(inset81.empty, inset81.emptyReason).toBe(false);
    expect(nearRectEnvelopeCheck(r81, inset81.ring, 6).pass).toBe(true);
  });

  it("cohort scrub builds adjacency index without shrinking manifest set", () => {
    const cohort = [
      entry("34073", PARCEL_34073_BCAD),
      entry("34081", PARCEL_34081_BCAD),
    ];
    const scrubbed = scrubParcelCohortEntries(cohort);
    const index = buildParcelAdjacencyIndex(COUNTY, scrubbed);
    expect(index.entries.size).toBe(2);
    expect(index.entries.has("48021:34073")).toBe(true);
  });

  it("manifest prop_id list matches downtown drill catalog (39 seed parcels)", () => {
    expect(DOWNTOWN_DRILL_MANIFEST_PROP_IDS.length).toBe(39);
    expect(DOWNTOWN_DRILL_MANIFEST_PROP_IDS).toContain(34073);
    expect(DOWNTOWN_DRILL_MANIFEST_PROP_IDS).toContain(8741972);
    expect(DOWNTOWN_DRILL_MANIFEST_PROP_IDS).not.toContain(34065);
  });
});

describe("snapSharedLotLineVertices", () => {
  it("merges near-duplicate shared vertices across two parcels", () => {
    const drifted81: typeof PARCEL_34081_BCAD = [
      [-97.316394922348977, 30.110992466811997],
      [-97.31639608, 30.11113535], // ~2cm drift from 34073 v1
      [-97.316704763, 30.111119676], // ~1cm drift from 34073 v0
      [-97.316699846182914, 30.110982118735119],
      [-97.316394922348977, 30.110992466811997],
    ];
    const snapped = snapSharedLotLineVertices(
      new Map([
        ["34073", PARCEL_34073_BCAD],
        ["34081", drifted81],
      ]),
    );
    const v73 = openRing(snapped.get("34073")!);
    const v81 = openRing(snapped.get("34081")!);
    const shared = v73.filter(([lng, lat]) =>
      v81.some(([lng2, lat2]) => Math.hypot(lng - lng2, lat - lat2) < 1e-7),
    );
    expect(shared.length).toBeGreaterThanOrEqual(2);
  });
});
