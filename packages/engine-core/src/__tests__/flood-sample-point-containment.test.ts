/**
 * Store-gated flood sample-point containment.
 *
 * Snapshot: hauska-engine d3f37949003fae5a99a82b62956352b7dcaa1022
 * worktree P:/tmp/mp-b-flood-chain branch fix/flood-geo-failclosed.
 *
 * GATE: the check reads the parcel ring from a ParcelRingStore, never from
 * the atom / fixture geometry. The cheapest contamination is passing the
 * same GeoJSON as both the point's source and the ring. That path is kept
 * as a defect copy so a clean pass cannot be confused with a check that
 * cannot fail.
 */
import { describe, expect, it } from "vitest";

import {
  classifySamplePointContainment,
  countTestableRings,
  floodDeterminationGate,
  MemoryParcelRingStore,
  memoryStoreContainingCentroids,
} from "../flood-hazard-fact/containment.js";
import {
  assembleCountyFloodHazardPlan,
  buildAtomsForFloodHazardPlan,
  planCountyFloodHazard,
  selectPlannableParcels,
} from "../flood-hazard-fact/index.js";
import { pointInGeoJson, type LngLat } from "../flood-hazard-fact/geo.js";
import {
  ingestTxgioParcelRingRows,
  parseFloodParcelStoreKey,
  TXGIO_PARCEL_RING_BY_FEATURE_INDEX_SQL,
  TXGIO_PARCEL_RING_BY_PROP_ID_SQL,
  TXGIO_PARCEL_RING_COUNTY_BATCH_SQL,
} from "../flood-hazard-fact/txgio-parcel-ring-store.js";

const COUNTY = "48021";
const KEY = "34137";
const REF = { countyFips: COUNTY, parcelKey: KEY };

/** Atom/fixture ring. Contains POINT. Independently constructed. */
const ATOM_RING = {
  type: "Polygon",
  coordinates: [
    [
      [-97.8, 30.0],
      [-97.2, 30.0],
      [-97.2, 30.4],
      [-97.8, 30.4],
      [-97.8, 30.0],
    ],
  ],
};

/** Store ring. Does NOT contain POINT. Different object from ATOM_RING. */
const STORE_RING = {
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

const POINT: LngLat = [-97.35, 30.125];

const AE_ZONE = {
  zoneRowId: "z1",
  fldZone: "AE",
  zoneSubty: null,
  sfhaTf: "T" as const,
  staticBfe: 10,
  westLng: -98,
  southLat: 29,
  eastLng: -96,
  northLat: 32,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-98, 29],
        [-96, 29],
        [-96, 32],
        [-98, 32],
        [-98, 29],
      ],
    ],
  },
};

/**
 * W-17 contaminated harness: classifier takes geometry from the caller.
 * Kept so violation 1 / the store-divergence case would go GREEN here
 * and RED on the live check.
 */
function classifyContaminated(
  point: LngLat,
  geometry: unknown,
): "contained" | "not-contained" | "unmeasurable" {
  if (!geometry) return "unmeasurable";
  return pointInGeoJson(point[0], point[1], geometry)
    ? "contained"
    : "not-contained";
}

class RecordingStore extends MemoryParcelRingStore {
  readonly reads: Array<{ countyFips: string; parcelKey: string }> = [];
  override getRing(ref: { countyFips: string; parcelKey: string }) {
    this.reads.push({ countyFips: ref.countyFips, parcelKey: ref.parcelKey });
    return super.getRing(ref);
  }
}

describe("store demonstration: the check reads the ParcelRingStore", () => {
  it("calls store.getRing with county_fips + parcelKey, not the atom geometry", () => {
    const store = new RecordingStore("txgio_parcel");
    store.set(COUNTY, KEY, STORE_RING);
    classifySamplePointContainment(POINT, REF, store);
    expect(store.reads).toEqual([REF]);
    expect(store.source).toBe("txgio_parcel");
  });

  it("production SQL selects geometry FROM txgio_parcel, not atoms, keyed by county_fips + prop_id / feature_index", () => {
    expect(TXGIO_PARCEL_RING_BY_PROP_ID_SQL).toMatch(/SELECT geometry/);
    expect(TXGIO_PARCEL_RING_BY_PROP_ID_SQL).toMatch(/FROM txgio_parcel/);
    expect(TXGIO_PARCEL_RING_BY_PROP_ID_SQL).toMatch(/county_fips = \$1/);
    expect(TXGIO_PARCEL_RING_BY_PROP_ID_SQL).toMatch(/prop_id = \$2/);
    expect(TXGIO_PARCEL_RING_BY_PROP_ID_SQL).not.toMatch(/hauska_mcp/);
    expect(TXGIO_PARCEL_RING_BY_PROP_ID_SQL).not.toMatch(/FROM atoms/);
    expect(TXGIO_PARCEL_RING_BY_PROP_ID_SQL).not.toMatch(/parcel_node/);
    expect(TXGIO_PARCEL_RING_BY_PROP_ID_SQL).not.toMatch(/parcel-node/);

    expect(TXGIO_PARCEL_RING_BY_FEATURE_INDEX_SQL).toMatch(/FROM txgio_parcel/);
    expect(TXGIO_PARCEL_RING_BY_FEATURE_INDEX_SQL).toMatch(/feature_index = \$2/);
    expect(TXGIO_PARCEL_RING_BY_FEATURE_INDEX_SQL).toMatch(/prop_id IS NULL/);
    expect(TXGIO_PARCEL_RING_COUNTY_BATCH_SQL).toMatch(/FROM txgio_parcel/);
    expect(TXGIO_PARCEL_RING_COUNTY_BATCH_SQL).toMatch(/DISTINCT ON \(feature_index\)/);
  });

  it("writer keying: prop_id vs _feature-${feature_index}", () => {
    expect(parseFloodParcelStoreKey("48021", "34137")).toEqual({
      kind: "prop_id",
      countyFips: "48021",
      propId: "34137",
    });
    expect(parseFloodParcelStoreKey("48021", "_feature-12")).toEqual({
      kind: "feature_index",
      countyFips: "48021",
      featureIndex: 12,
    });
  });

  it("first-write-wins: later feature_index for the same prop_id does not replace the ring", () => {
    const store = new MemoryParcelRingStore("txgio_parcel");
    ingestTxgioParcelRingRows(store, COUNTY, [
      { feature_index: 1634, prop_id: "10250", geometry: ATOM_RING },
      { feature_index: 1635, prop_id: "10250", geometry: STORE_RING },
    ]);
    const live = classifySamplePointContainment(POINT, {
      countyFips: COUNTY,
      parcelKey: "10250",
    }, store);
    expect(live.state).toBe("contained");
    const lastWins = new MemoryParcelRingStore("txgio_parcel");
    lastWins.set(COUNTY, "10250", ATOM_RING);
    lastWins.set(COUNTY, "10250", STORE_RING);
    expect(
      classifySamplePointContainment(POINT, {
        countyFips: COUNTY,
        parcelKey: "10250",
      }, lastWins).state,
    ).toBe("not-contained");
  });
});

describe("VIOLATION 1: out-of-parcel point → not-contained, observed failing", () => {
  it("FIRES not-contained when the store ring does not contain the point", () => {
    const store = new MemoryParcelRingStore("txgio_parcel");
    store.set(COUNTY, KEY, STORE_RING);
    expect(pointInGeoJson(POINT[0], POINT[1], STORE_RING)).toBe(false);

    const verdict = classifySamplePointContainment(POINT, REF, store);
    expect(verdict.state).toBe("not-contained");
    expect(verdict.ringsTested).toBe(1);
    expect(verdict.storeSource).toBe("txgio_parcel");

    const gate = floodDeterminationGate(verdict);
    expect(gate.decision).toBe("refuse");
    expect(gate.reasonCode).toBe("sample-point-outside-parcel");
  });
});

describe("VIOLATION 2: missing ring → unmeasurable (not not-contained), observed failing", () => {
  it("FIRES unmeasurable when the store has no ring for the key", () => {
    const store = new MemoryParcelRingStore("txgio_parcel");
    const verdict = classifySamplePointContainment(POINT, REF, store);
    expect(verdict.state).toBe("unmeasurable");
    expect(verdict.state).not.toBe("not-contained");
    expect(verdict.ringsTested).toBe(0);
    expect(verdict.basis).toMatch(/missing/);

    const gate = floodDeterminationGate(verdict);
    expect(gate.decision).toBe("refuse");
    expect(gate.reasonCode).toBe("parcel-ring-unmeasurable");
  });

  it("FIRES unmeasurable for a loaded unusable ring, still not not-contained", () => {
    const store = new MemoryParcelRingStore("txgio_parcel");
    const degenerate = {
      type: "Polygon",
      coordinates: [
        [
          [-97.4, 30.1],
          [-97.3, 30.1],
        ],
      ],
    };
    store.set(COUNTY, KEY, degenerate);
    const loaded = store.getRing(REF);
    expect(loaded.status).toBe("present");
    if (loaded.status === "present") {
      expect(countTestableRings(loaded.geometry)).toBe(0);
    }
    const verdict = classifySamplePointContainment(POINT, REF, store);
    expect(verdict.state).toBe("unmeasurable");
    expect(verdict.state).not.toBe("not-contained");
    expect(verdict.ringsTested).toBe(0);
  });
});

describe("store gate vs contamination: atom contains, store does not", () => {
  it("returns not-contained when the store ring excludes a point the atom ring contains", () => {
    expect(pointInGeoJson(POINT[0], POINT[1], ATOM_RING)).toBe(true);
    expect(pointInGeoJson(POINT[0], POINT[1], STORE_RING)).toBe(false);
    expect(ATOM_RING).not.toBe(STORE_RING);

    const contaminated = classifyContaminated(POINT, ATOM_RING);
    expect(contaminated).toBe("contained");

    const store = new MemoryParcelRingStore("txgio_parcel");
    store.set(COUNTY, KEY, STORE_RING);
    const live = classifySamplePointContainment(POINT, REF, store);
    expect(live.state).toBe("not-contained");
  });

  it("refuses a store that is not a ParcelRingStore (no geometry argument to fall back on)", () => {
    expect(() =>
      classifySamplePointContainment(
        POINT,
        REF,
        ATOM_RING as unknown as MemoryParcelRingStore,
      ),
    ).toThrow(/ParcelRingStore/);
  });
});

describe("three states never collapse", () => {
  it("contained / not-contained / unmeasurable are three different returns", () => {
    const inside = new MemoryParcelRingStore("memory");
    inside.set(COUNTY, KEY, ATOM_RING);
    const outside = new MemoryParcelRingStore("memory");
    outside.set(COUNTY, KEY, STORE_RING);
    const missing = new MemoryParcelRingStore("memory");

    const a = classifySamplePointContainment(POINT, REF, inside);
    const b = classifySamplePointContainment(POINT, REF, outside);
    const c = classifySamplePointContainment(POINT, REF, missing);
    expect(a.state).toBe("contained");
    expect(b.state).toBe("not-contained");
    expect(c.state).toBe("unmeasurable");
    expect(new Set([a.state, b.state, c.state]).size).toBe(3);
  });
});

describe("plan path: not-contained cannot be emitted as present", () => {
  const parcels = [{ parcelKey: KEY, centroid: POINT }];

  it("refuses an out-of-parcel point instead of writing present", () => {
    const store = new MemoryParcelRingStore("txgio_parcel");
    store.set(COUNTY, KEY, STORE_RING);
    const plan = planCountyFloodHazard(parcels, [AE_ZONE], {
      countyFips: COUNTY,
      ringStore: store,
    });
    expect(plan.counts.present).toBe(0);
    expect(plan.counts.refused).toBe(1);
    expect(plan.refused[0]?.samplePointContainment).toBe("not-contained");
    expect(plan.planned).toEqual([]);
    const atoms = buildAtomsForFloodHazardPlan(plan, {
      sourceAdapter: "test",
      sourceCitation: "test",
      sourceUrl: "test",
      observedAt: "2026-08-20T00:00:00.000Z",
      jurisdictionTenant: "tx_48021",
      verificationStatus: "machine",
    });
    expect(atoms).toHaveLength(0);
  });

  it("refuses a missing ring as unmeasurable, not as not-contained, and not as present", () => {
    const store = new MemoryParcelRingStore("txgio_parcel");
    const plan = planCountyFloodHazard(parcels, [AE_ZONE], {
      countyFips: COUNTY,
      ringStore: store,
    });
    expect(plan.counts.present).toBe(0);
    expect(plan.counts.refused).toBe(1);
    expect(plan.refused[0]?.samplePointContainment).toBe("unmeasurable");
    expect(plan.refused[0]?.reasonCode).toBe("parcel-ring-unmeasurable");
    expect(plan.planned).toEqual([]);
  });

  it("emits present only when the STORE ring contains the point", () => {
    const store = new MemoryParcelRingStore("txgio_parcel");
    store.set(COUNTY, KEY, ATOM_RING);
    const plan = planCountyFloodHazard(parcels, [AE_ZONE], {
      countyFips: COUNTY,
      ringStore: store,
    });
    expect(plan.counts.present).toBe(1);
    expect(plan.planned[0]).toMatchObject({
      outcome: "present",
      samplePointContainment: "contained",
      inSpecialFloodHazardArea: true,
    });
    expect(plan.counts.refused).toBe(0);
  });

  it("throws if ringStore is omitted (mjs writer cannot silently skip)", () => {
    expect(() =>
      planCountyFloodHazard(parcels, [AE_ZONE], {
        countyFips: COUNTY,
      } as never),
    ).toThrow(/ringStore/);
  });

  it("B5 null centroid is unmeasurable, still absents, never not-contained", () => {
    const store = new MemoryParcelRingStore("txgio_parcel");
    const sel = selectPlannableParcels(
      [{ parcelKey: KEY, centroid: null }],
      { countyFips: COUNTY, ringStore: store },
    );
    expect(sel.items[0]!.containment.state).toBe("unmeasurable");
    expect(sel.items[0]!.containment.cause).toBe("no-point");
    const plan = assembleCountyFloodHazardPlan(sel, [null], {
      countyFips: COUNTY,
      zonesIndexed: 10,
    });
    expect(plan.planned[0]).toMatchObject({
      outcome: "absent",
      reason: `no usable geocode/centroid for ${COUNTY}:${KEY}`,
    });
    expect(plan.counts.refused).toBe(0);
    expect(plan.containment.notContained).toBe(0);
    expect(plan.containment.unmeasurable).toBe(1);
    expect(plan.populationIdentity.sum).toBe(1);
  });
});

describe("memoryStoreContainingCentroids builds rings independently of the centroid tuple", () => {
  it("does not alias the centroid array as geometry", () => {
    const centroid: LngLat = [-97.5, 30.5];
    const parcels = [{ parcelKey: "R1", centroid }];
    const store = memoryStoreContainingCentroids("48099", parcels);
    const loaded = store.getRing({ countyFips: "48099", parcelKey: "R1" });
    expect(loaded.status).toBe("present");
    if (loaded.status !== "present") return;
    expect(loaded.geometry).not.toBe(centroid);
    expect(
      classifySamplePointContainment(centroid, {
        countyFips: "48099",
        parcelKey: "R1",
      }, store).state,
    ).toBe("contained");
  });
});
