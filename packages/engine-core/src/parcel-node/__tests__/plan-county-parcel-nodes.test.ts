/**
 * Rail 1 `parcel-node` planner tests.
 *
 * Fixtures model the SHAPE measured on Kenedy 48261 in
 * `_inbox/2026-08-08_L2_first_county_proof.md`: 2,400 tile rows over 538
 * distinct features (seam 4.4610), one MultiPolygon, seven hole-carrying
 * Polygons, and feature 0 carrying `prop_id = '0'` with an empty owner.
 *
 * No database. Every assertion is against the pure planner.
 */
import { describe, expect, it } from "vitest";

import {
  classifyGeometryShape,
  normalizeParcelKeyToken,
  planCountyParcelNodes,
  type TxgioParcelRowInput,
} from "../plan-county-parcel-nodes.js";

const VINTAGE = "stratmap25-landparcels_48261_kenedy_202503";

function simplePolygon(): unknown {
  return {
    type: "Polygon",
    coordinates: [
      [
        [-97.9597, 26.6222],
        [-97.9590, 26.6222],
        [-97.9590, 26.6230],
        [-97.9597, 26.6230],
        [-97.9597, 26.6222],
      ],
    ],
  };
}

function polygonWithHole(): unknown {
  const outer = (simplePolygon() as { coordinates: unknown[] }).coordinates[0];
  return {
    type: "Polygon",
    coordinates: [
      outer,
      [
        [-97.9595, 26.6224],
        [-97.9593, 26.6224],
        [-97.9593, 26.6226],
        [-97.9595, 26.6224],
      ],
    ],
  };
}

function multiPolygonTwoParts(): unknown {
  const part = (simplePolygon() as { coordinates: unknown[] }).coordinates;
  return { type: "MultiPolygon", coordinates: [part, part] };
}

function singlePartMultiPolygon(): unknown {
  const part = (simplePolygon() as { coordinates: unknown[] }).coordinates;
  return { type: "MultiPolygon", coordinates: [part] };
}

/**
 * Build `tileCount` tile rows for one feature — the store's real shape, where a
 * feature is written once per 0.02-degree cell its bbox intersects.
 */
function tiledFeature(
  featureIndex: number,
  propId: string | null,
  tileCount: number,
  geometry: unknown = simplePolygon(),
  geoId: string | null = null,
): TxgioParcelRowInput[] {
  return Array.from({ length: tileCount }, (_, i) => ({
    featureIndex,
    tileKey: `g0.02:-97.9${(60 + i).toString().padStart(2, "0")}0,26.6${(20 + i).toString().padStart(2, "0")}0`,
    propId,
    geoId,
    geometry,
    sourceVintage: VINTAGE,
  }));
}

const PROP_ID_POLICY = {
  countyFips: "48261",
  keyKind: "prop_id",
  geometrySourceTier: "txgio-stratmap",
} as const;

describe("planCountyParcelNodes — tile-row de-duplication", () => {
  it("collapses tile rows to ONE atom per parcel, not one per row", () => {
    // 3 parcels, each written across 4 grid cells = 12 rows.
    const rows = [
      ...tiledFeature(1, "15271", 4),
      ...tiledFeature(2, "15276", 4),
      ...tiledFeature(3, "15305", 4),
    ];
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);

    expect(plan.rowsRead).toBe(12);
    expect(plan.distinctFeatures).toBe(3);
    expect(plan.planned.length).toBe(3);
    expect(plan.counts.resolved).toBe(3);
  });

  it("reports the seam factor rather than hiding the inflation", () => {
    const rows = [...tiledFeature(1, "15271", 5), ...tiledFeature(2, "15276", 4)];
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);
    expect(plan.rowsRead).toBe(9);
    expect(plan.distinctFeatures).toBe(2);
    expect(plan.seamFactor).toBe(4.5);
  });

  it("reproduces the Kenedy shape: 2400-ish rows collapse to 538 atoms, not 2400", () => {
    // 538 features at the measured 4.4610 seam ~= 2400 rows.
    const rows: TxgioParcelRowInput[] = [];
    for (let f = 1; f <= 538; f++) {
      // Vary tiles 4/5 to land near the measured total.
      rows.push(...tiledFeature(f, String(15000 + f), f % 2 === 0 ? 4 : 5));
    }
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);

    expect(plan.distinctFeatures).toBe(538);
    expect(plan.planned.length).toBe(538);
    expect(plan.rowsRead).toBeGreaterThan(2000);
    // The whole point: the atom count is the FEATURE count, never the row count.
    expect(plan.planned.length).not.toBe(plan.rowsRead);
  });

  it("is order-independent — the same rows shuffled produce the same plan", () => {
    const rows = [
      ...tiledFeature(3, "15305", 2),
      ...tiledFeature(1, "15271", 3),
      ...tiledFeature(2, "15276", 4),
    ];
    const shuffled = [...rows].reverse();
    const a = planCountyParcelNodes(rows, PROP_ID_POLICY);
    const b = planCountyParcelNodes(shuffled, PROP_ID_POLICY);
    expect(b.planned).toEqual(a.planned);
  });
});

describe("planCountyParcelNodes — account identity vs geometry identity", () => {
  it("keeps 133 accounts on one shared polygon as 133 atoms (the Tarrant trap)", () => {
    // Every one of these features carries the IDENTICAL geometry object — a
    // geometry-keyed dedup would collapse them to one and destroy 132
    // leasehold accounts. Dedup is on feature_index; identity is prop_id.
    const shared = simplePolygon();
    const rows: TxgioParcelRowInput[] = [];
    for (let i = 0; i < 133; i++) {
      rows.push(...tiledFeature(i + 1, `A36-1-${i + 1}`, 2, shared));
    }
    const plan = planCountyParcelNodes(rows, {
      ...PROP_ID_POLICY,
      countyFips: "48439",
    });

    expect(plan.distinctFeatures).toBe(133);
    expect(plan.planned.length).toBe(133);
    expect(plan.counts.resolved).toBe(133);
    expect(new Set(plan.planned.map((p) => p.parcelKey)).size).toBe(133);
  });

  it("folds several source features of ONE account into one atom and reports the extras", () => {
    // Same prop_id spanning three shapefile features — one account, so one
    // atom, but the extra features are counted, never silently dropped.
    const rows = [
      ...tiledFeature(10, "15271", 2),
      ...tiledFeature(11, "15271", 2),
      ...tiledFeature(12, "15271", 2),
      ...tiledFeature(20, "15276", 2),
    ];
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);

    expect(plan.distinctFeatures).toBe(4);
    expect(plan.planned.length).toBe(2);
    expect(plan.counts.multiFeatureAccounts).toBe(1);
    expect(plan.counts.foldedExtraFeatures).toBe(2);

    const folded = plan.planned.find((p) => p.parcelKey === "15271");
    expect(folded?.outcome).toBe("resolved");
    expect(
      (folded as { additionalFeatureIndexes: number[] }).additionalFeatureIndexes,
    ).toEqual([11, 12]);
  });

  it("normalizes zero-padded ids so the pointer resolves the same row the resolver would", () => {
    expect(normalizeParcelKeyToken("0015271")).toBe("15271");
    expect(normalizeParcelKeyToken("15271")).toBe("15271");
    // Non-numeric ids are left alone — stripping would corrupt them.
    expect(normalizeParcelKeyToken("R0015271")).toBe("R0015271");
    expect(normalizeParcelKeyToken("10-0017-2321-00000-3")).toBe(
      "10-0017-2321-00000-3",
    );
  });

  it("treats a zero-padded id and its bare form as ONE account", () => {
    const rows = [
      ...tiledFeature(1, "0015271", 2),
      ...tiledFeature(2, "15271", 2),
    ];
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);
    expect(plan.planned.length).toBe(1);
    expect(plan.planned[0]!.parcelKey).toBe("15271");
  });
});

describe("planCountyParcelNodes — typed absence, all three kinds", () => {
  it("emits parcel-key-unresolved for the `prop_id = 0` placeholder (Kenedy feature 0)", () => {
    const rows = [
      ...tiledFeature(0, "0", 3),
      ...tiledFeature(1, "15271", 3),
    ];
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);

    expect(plan.planned.length).toBe(2);
    expect(plan.counts.absentByKind["parcel-key-unresolved"]).toBe(1);
    const absent = plan.planned.find((p) => p.outcome === "absent");
    expect(absent?.absenceKind).toBe("parcel-key-unresolved");
    // Never minted under the fabricated `48261:0` key that every account-less
    // feature in the county would collide onto.
    expect(absent?.parcelKey).toBe("_feature-0");
    expect(absent?.reason).toMatch(/placeholder or blank id is not an account/);
  });

  it("emits parcel-key-unresolved for every parcel in a county whose key kind is unestablished", () => {
    // Williamson / Hays: TxGIO prop_ids do NOT correspond to the CAD roll. A
    // guessed join fabricated another property's land use onto ~97k parcels.
    const rows = [
      ...tiledFeature(1, "R123456", 2),
      ...tiledFeature(2, "R123457", 2),
    ];
    const plan = planCountyParcelNodes(rows, {
      countyFips: "48491",
      keyKind: "unresolved",
      geometrySourceTier: "txgio-stratmap",
    });

    expect(plan.counts.resolved).toBe(0);
    expect(plan.counts.absentByKind["parcel-key-unresolved"]).toBe(2);
    expect(plan.planned.every((p) => p.outcome === "absent")).toBe(true);
    expect(plan.planned[0]!.reason).toMatch(/key kind is unestablished/);
  });

  it("emits geometry-incomplete for a multi-part MultiPolygon, not a truncated ring", () => {
    const rows = [
      ...tiledFeature(1, "15271", 2, multiPolygonTwoParts()),
      ...tiledFeature(2, "15276", 2),
    ];
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);

    expect(plan.counts.absentByKind["geometry-incomplete"]).toBe(1);
    const incomplete = plan.planned.find((p) => p.outcome === "absent");
    expect(incomplete?.absenceKind).toBe("geometry-incomplete");
    expect(incomplete?.reason).toMatch(/MultiPolygon with 2 parts/);
    expect(incomplete?.reason).toMatch(/MULTI_PART_GEOMETRY_UNSUPPORTED/);
  });

  it("emits geometry-incomplete for a hole-carrying Polygon (7/538 on Kenedy)", () => {
    const rows = tiledFeature(1, "15271", 2, polygonWithHole());
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);
    expect(plan.counts.absentByKind["geometry-incomplete"]).toBe(1);
    expect(plan.planned[0]!.reason).toMatch(/1 interior/);
  });

  it("treats a single-part hole-free MultiPolygon as reducible, matching the resolver exactly", () => {
    const rows = tiledFeature(1, "15271", 2, singlePartMultiPolygon());
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);
    expect(plan.counts.resolved).toBe(1);
    expect(plan.counts.absentByKind["geometry-incomplete"]).toBe(0);
  });

  it("emits no-parcel-geometry when a loaded county's row carries unusable geometry", () => {
    const rows = tiledFeature(1, "15271", 2, { type: "Point", coordinates: [0, 0] });
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);
    expect(plan.counts.absentByKind["no-parcel-geometry"]).toBe(1);
    expect(plan.planned[0]!.reason).toMatch(/is loaded but this parcel's stored geometry is unusable/);
  });

  it("never silently drops a feature — planned entries account for every feature or fold", () => {
    const rows = [
      ...tiledFeature(0, "0", 2), // keyless
      ...tiledFeature(1, "15271", 2), // resolved
      ...tiledFeature(2, "15276", 2, multiPolygonTwoParts()), // geometry-incomplete
      ...tiledFeature(3, null, 2), // keyless (null)
      ...tiledFeature(4, "15271", 2), // folds into feature 1's account
    ];
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);

    expect(plan.distinctFeatures).toBe(5);
    expect(plan.planned.length + plan.counts.foldedExtraFeatures).toBe(5);
    expect(plan.counts.absent).toBe(3);
    expect(plan.counts.resolved).toBe(1);
  });

  it("rejects a key token the parcelNodeId contract cannot admit, as a counted absence", () => {
    const rows = tiledFeature(1, "bad key with spaces", 2);
    const plan = planCountyParcelNodes(rows, PROP_ID_POLICY);
    expect(plan.counts.absentByKind["parcel-key-unresolved"]).toBe(1);
    expect(plan.planned[0]!.reason).toMatch(/contract does not admit/);
  });
});

describe("planCountyParcelNodes — crosswalk counties", () => {
  it("keys on geo_id when the county's join key is the crosswalk", () => {
    const rows = tiledFeature(1, "15271", 2, simplePolygon(), "10-0017-2321-00000-3");
    const plan = planCountyParcelNodes(rows, {
      countyFips: "48453",
      keyKind: "geo_id_crosswalk",
      geometrySourceTier: "txgio-stratmap",
    });
    expect(plan.counts.resolved).toBe(1);
    expect(plan.planned[0]!.parcelKey).toBe("10-0017-2321-00000-3");
    expect(plan.planned[0]!.keyKind).toBe("geo_id_crosswalk");
  });

  it("emits absence when the crosswalk county's row has no geo_id", () => {
    const rows = tiledFeature(1, "15271", 2, simplePolygon(), null);
    const plan = planCountyParcelNodes(rows, {
      countyFips: "48453",
      keyKind: "geo_id_crosswalk",
      geometrySourceTier: "txgio-stratmap",
    });
    expect(plan.counts.absentByKind["parcel-key-unresolved"]).toBe(1);
    expect(plan.planned[0]!.reason).toMatch(/no usable geo_id_crosswalk token/);
  });
});

describe("classifyGeometryShape — mirrors the serving path's reducibility ruling", () => {
  it("classifies each shape the way parcel-geometry-resolver does", () => {
    expect(classifyGeometryShape(simplePolygon()).kind).toBe("reducible");
    expect(classifyGeometryShape(singlePartMultiPolygon()).kind).toBe("reducible");
    expect(classifyGeometryShape(polygonWithHole()).kind).toBe("multi-part");
    expect(classifyGeometryShape(multiPolygonTwoParts()).kind).toBe("multi-part");
    expect(classifyGeometryShape(null).kind).toBe("unusable");
    expect(classifyGeometryShape({ type: "Point", coordinates: [0, 0] }).kind).toBe("unusable");
    expect(classifyGeometryShape({ type: "Polygon", coordinates: [] }).kind).toBe("unusable");
  });
});

describe("planCountyParcelNodes — the plan IS the dry-run prediction", () => {
  it("returns the identical plan on repeat calls, so a dry run can be compared to an apply", () => {
    const rows = [
      ...tiledFeature(0, "0", 2),
      ...tiledFeature(1, "15271", 4),
      ...tiledFeature(2, "15276", 3, multiPolygonTwoParts()),
    ];
    const first = planCountyParcelNodes(rows, PROP_ID_POLICY);
    const second = planCountyParcelNodes(rows, PROP_ID_POLICY);
    expect(second).toEqual(first);
    // Prediction is per-kind, not a bare total.
    expect(first.counts.absentByKind).toEqual({
      "no-parcel-geometry": 0,
      "geometry-incomplete": 1,
      "parcel-key-unresolved": 1,
    });
  });

  it("reports zero features and a null seam factor for an empty county without dividing by zero", () => {
    const plan = planCountyParcelNodes([], PROP_ID_POLICY);
    expect(plan.distinctFeatures).toBe(0);
    expect(plan.seamFactor).toBeNull();
    expect(plan.planned).toEqual([]);
  });
});
