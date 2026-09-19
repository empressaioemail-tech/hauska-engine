/**
 * Plan-assembly contract shared by the JS and PostGIS flood plan backends.
 *
 * The PostGIS backend resolves zones in SQL but must produce the same plan
 * records as the JS grid path. Everything except the point-in-polygon
 * predicate itself lives in `selectPlannableParcels` +
 * `assembleCountyFloodHazardPlan`, so these tests pin the rules that a second
 * backend could otherwise silently re-implement differently: unusable-key
 * skipping, first-key-wins dedupe, the empty-zone-index absence, the
 * no-centroid absence, fail-closed absence when no loaded zone hits (never
 * Zone X by omission — SF-9), and the SS-W17 sample-point containment gate.
 *
 * Every parcel here now carries a REAL RING. That is the point of the change:
 * a test that supplies a bare coordinate is testing a path the writer can no
 * longer take, and the old fixtures were exactly that.
 */
import { describe, expect, it } from "vitest";

import {
  assembleCountyFloodHazardPlan,
  hasUsableCentroid,
  isQueryableParcel,
  planCountyFloodHazard,
  selectPlannableParcels,
  type FloodParcelInput,
  type ResolvedFloodZone,
} from "../flood-hazard-fact/plan-county-flood-hazard.js";
import type { FloodZoneFeature } from "../flood-hazard-fact/geo.js";

const AE: ResolvedFloodZone = {
  fldZone: "AE",
  zoneSubty: null,
  sfhaTf: "T",
  staticBfe: 412.5,
  sourceVintage: "nfhl-2026-06",
};

/** A square ring centred on (lng, lat) whose vertex mean is that point. */
function ringAround(lng: number, lat: number, half = 0.001) {
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng - half, lat - half],
        [lng + half, lat - half],
        [lng + half, lat + half],
        [lng - half, lat + half],
        [lng - half, lat - half],
      ],
    ],
  };
}

function parcel(
  key: string,
  lng: number | null = -97.5,
  lat = 30.5,
): FloodParcelInput {
  return {
    parcelKey: key,
    geometry: lng == null ? null : ringAround(lng, lat),
  };
}

describe("selectPlannableParcels", () => {
  it("skips blank and all-zero keys, counting them as unusable", () => {
    const sel = selectPlannableParcels([
      parcel("R12345"),
      parcel("   "),
      parcel("000000"),
      parcel("0"),
    ]);
    expect(sel.items.map((i) => i.parcelKey)).toEqual(["R12345"]);
    expect(sel.skippedUnusableKey).toBe(3);
    expect(sel.parcelsRead).toBe(4);
  });

  it("dedupes on trimmed key, first occurrence wins its centroid", () => {
    const sel = selectPlannableParcels([
      parcel("R1", -97.1, 30.1),
      parcel(" R1 ", -98.9, 31.9),
    ]);
    expect(sel.items).toHaveLength(1);
    expect(sel.items[0]!.centroid![0]).toBeCloseTo(-97.1, 9);
    expect(sel.items[0]!.centroid![1]).toBeCloseTo(30.1, 9);
    // A duplicate is not "unusable" — it is already planned.
    expect(sel.skippedUnusableKey).toBe(0);
  });

  it("treats a non-finite declared centroid as unusable without dropping the parcel", () => {
    const sel = selectPlannableParcels([
      { parcelKey: "R2", geometry: null, centroid: [Number.NaN, 30.5] },
    ]);
    expect(sel.items).toHaveLength(1);
    expect(hasUsableCentroid(sel.items[0]!)).toBe(false);
  });

  it("records the derivation and the containment verdict on every item", () => {
    const sel = selectPlannableParcels([parcel("R1")]);
    expect(sel.items[0]!.samplePointDerivation).toBe("ring-centroid");
    expect(sel.items[0]!.containment.state).toBe("contained");
    expect(isQueryableParcel(sel.items[0]!)).toBe(true);
  });
});

describe("assembleCountyFloodHazardPlan", () => {
  it("emits typed absence for every parcel when the zone index is empty", () => {
    const sel = selectPlannableParcels([parcel("R1"), parcel("R2")]);
    const plan = assembleCountyFloodHazardPlan(sel, [null, null], {
      countyFips: "48099",
      zonesIndexed: 0,
    });
    expect(plan.emptyZoneIndex).toBe(true);
    expect(plan.counts.absent).toBe(2);
    expect(plan.counts.present).toBe(0);
    expect(plan.counts.refused).toBe(0);
    expect(plan.planned[0]).toMatchObject({
      outcome: "absent",
      absenceKind: "no-flood-coverage",
    });
  });

  it("fail-closes to typed absence when no loaded zone contains the point (never Zone X by omission)", () => {
    const sel = selectPlannableParcels([parcel("R1")]);
    const plan = assembleCountyFloodHazardPlan(sel, [null], {
      countyFips: "48099",
      zonesIndexed: 1543,
    });
    expect(plan.planned[0]).toMatchObject({
      outcome: "absent",
      parcelKey: "R1",
      absenceKind: "no-flood-coverage",
    });
    expect(String((plan.planned[0] as { reason?: string }).reason)).toMatch(
      /not proven Zone X/i,
    );
    expect(plan.counts.present).toBe(0);
    expect(plan.counts.presentOutside).toBe(0);
    expect(plan.counts.absent).toBe(1);
  });

  it("carries zone attributes, the SFHA flag and the sampling stamp onto the record", () => {
    const sel = selectPlannableParcels([parcel("R1")]);
    const plan = assembleCountyFloodHazardPlan(sel, [AE], {
      countyFips: "48099",
      zonesIndexed: 1543,
    });
    expect(plan.planned[0]).toMatchObject({
      outcome: "present",
      parcelKey: "R1",
      inSpecialFloodHazardArea: true,
      floodZone: "AE",
      zoneSubtype: null,
      baseFloodElevation: 412.5,
      sourceVintage: "nfhl-2026-06",
      samplePointDerivation: "ring-centroid",
      samplePointContainment: "contained",
    });
    expect(plan.counts.presentInSfha).toBe(1);
  });

  it("classifies SFHA exactly as isSfhaFlag does — 'TRUE' is not SFHA", () => {
    const sel = selectPlannableParcels([
      parcel("R1"),
      parcel("R2"),
      parcel("R3"),
    ]);
    const plan = assembleCountyFloodHazardPlan(
      sel,
      [
        { ...AE, sfhaTf: "t" },
        { ...AE, sfhaTf: "TRUE" },
        { ...AE, sfhaTf: "F" },
      ],
      { countyFips: "48099", zonesIndexed: 10 },
    );
    expect(plan.counts.presentInSfha).toBe(1);
    expect(plan.counts.presentOutside).toBe(2);
  });

  it("absents a parcel with a Point geometry and no usable coordinate", () => {
    const sel = selectPlannableParcels([
      { parcelKey: "R1", geometry: { type: "Point", coordinates: [] } },
    ]);
    const plan = assembleCountyFloodHazardPlan(sel, [null], {
      countyFips: "48099",
      zonesIndexed: 1543,
    });
    // No ring and no point at all: nothing ties a query to this parcel, so the
    // determination is REFUSED rather than absented. An absence would be a
    // claim about the parcel; this is a refusal to make one.
    expect(plan.counts.refused).toBe(1);
    expect(plan.refused[0]).toMatchObject({
      outcome: "refused",
      reasonCode: "no-sample-point",
    });
  });
});

describe("the containment gate inside plan assembly", () => {
  /** C shape: the vertex mean lands in the mouth, outside the parcel. */
  const C_SHAPE = {
    type: "Polygon",
    coordinates: [
      [
        [-97.4, 30.1],
        [-97.3, 30.1],
        [-97.3, 30.11],
        [-97.39, 30.11],
        [-97.39, 30.14],
        [-97.3, 30.14],
        [-97.3, 30.15],
        [-97.4, 30.15],
        [-97.4, 30.1],
      ],
    ],
  };

  it("REFUSES a determination whose point falls outside the parcel, and emits no atom row for it", () => {
    const sel = selectPlannableParcels([
      { parcelKey: "R1", geometry: C_SHAPE },
    ]);
    const plan = assembleCountyFloodHazardPlan(sel, [AE], {
      countyFips: "48021",
      zonesIndexed: 1543,
    });
    expect(plan.planned).toHaveLength(0);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]!.reasonCode).toBe("sample-point-outside-parcel");
    expect(plan.counts.present).toBe(0);
    expect(plan.counts.absent).toBe(0);
    expect(plan.counts.refused).toBe(1);
    expect(plan.containment.notContained).toBe(1);
  });

  it("REFUSES a ringless parcel whose point is a bbox centre, rather than absenting it", () => {
    const sel = selectPlannableParcels([
      {
        parcelKey: "R1",
        geometry: null,
        bbox: {
          westLng: -97.4,
          southLat: 30.1,
          eastLng: -97.3,
          northLat: 30.2,
        },
      },
    ]);
    const plan = assembleCountyFloodHazardPlan(sel, [AE], {
      countyFips: "48021",
      zonesIndexed: 1543,
    });
    expect(plan.counts.refused).toBe(1);
    expect(plan.refused[0]!.reasonCode).toBe("sample-point-not-tied-to-parcel");
    expect(plan.containment.unmeasurable).toBe(1);
    expect(plan.containment.byDerivation["bbox-centre"]).toBe(1);
  });

  it("keeps the three containment states and the two decisions summing to the plannable population", () => {
    const sel = selectPlannableParcels([
      parcel("OK"),
      { parcelKey: "OUT", geometry: C_SHAPE },
      {
        parcelKey: "NORING",
        geometry: null,
        bbox: {
          westLng: -97.4,
          southLat: 30.1,
          eastLng: -97.3,
          northLat: 30.2,
        },
      },
    ]);
    const plan = assembleCountyFloodHazardPlan(sel, [AE, AE, AE], {
      countyFips: "48021",
      zonesIndexed: 10,
    });
    const c = plan.containment;
    expect(c.contained + c.notContained + c.unmeasurable).toBe(3);
    expect(c.emitted + c.refused).toBe(3);
    expect(plan.planned.length).toBe(c.emitted);
    expect(plan.refused.length).toBe(c.refused);
  });
});

describe("planCountyFloodHazard still routes through the shared assembly", () => {
  const zone: FloodZoneFeature = {
    zoneRowId: "z1",
    fldZone: "AE",
    zoneSubty: null,
    sfhaTf: "T",
    staticBfe: 10,
    westLng: 0,
    southLat: 0,
    eastLng: 4,
    northLat: 4,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
      ],
    },
  };

  it("produces the same record the assembly helper would from the same hit", () => {
    const parcels: FloodParcelInput[] = [
      { parcelKey: "R1", geometry: ringAround(2, 2, 0.1) },
    ];
    const viaPlanner = planCountyFloodHazard(parcels, [zone], {
      countyFips: "48099",
    });
    const viaAssembly = assembleCountyFloodHazardPlan(
      selectPlannableParcels(parcels),
      [
        {
          fldZone: "AE",
          zoneSubty: null,
          sfhaTf: "T",
          staticBfe: 10,
          sourceVintage: undefined,
        },
      ],
      { countyFips: "48099", zonesIndexed: 1 },
    );
    expect(viaPlanner.planned).toEqual(viaAssembly.planned);
    expect(viaPlanner.counts).toEqual(viaAssembly.counts);
    expect(viaPlanner.refused).toEqual(viaAssembly.refused);
  });

  it("never sends a refused parcel to the zone resolver", () => {
    const outside: FloodParcelInput = {
      parcelKey: "OUT",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [3.9, 0],
            [3.9, 0.1],
            [0.1, 0.1],
            [0.1, 3.9],
            [3.9, 3.9],
            [3.9, 4],
            [0, 4],
            [0, 0],
          ],
        ],
      },
    };
    const plan = planCountyFloodHazard([outside], [zone], {
      countyFips: "48099",
    });
    expect(plan.planned).toHaveLength(0);
    expect(plan.refused).toHaveLength(1);
    // The parcel sits wholly inside the AE zone, so an ungated planner would
    // have produced a confident present-in-SFHA record here.
    expect(plan.counts.presentInSfha).toBe(0);
  });
});
