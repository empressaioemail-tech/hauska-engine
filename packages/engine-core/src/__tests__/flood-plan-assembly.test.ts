/**
 * Plan-assembly contract shared by the JS and PostGIS flood plan backends.
 *
 * The PostGIS backend resolves zones in SQL but must produce the same plan
 * records as the JS grid path. Everything except the point-in-polygon
 * predicate itself lives in `selectPlannableParcels` +
 * `assembleCountyFloodHazardPlan`, so these tests pin the rules that a second
 * backend could otherwise silently re-implement differently: unusable-key
 * skipping, first-key-wins dedupe, the empty-zone-index absence, the
 * no-centroid absence, and Zone X by omission.
 */
import { describe, expect, it } from "vitest";

import {
  assembleCountyFloodHazardPlan,
  hasUsableCentroid,
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

function parcel(key: string, lng: number | null = -97.5, lat = 30.5): FloodParcelInput {
  return { parcelKey: key, centroid: lng == null ? null : [lng, lat] };
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
    expect(sel.items[0]!.centroid).toEqual([-97.1, 30.1]);
    // A duplicate is not "unusable" — it is already planned.
    expect(sel.skippedUnusableKey).toBe(0);
  });

  it("treats a non-finite centroid as unusable without dropping the parcel", () => {
    const sel = selectPlannableParcels([
      { parcelKey: "R2", centroid: [Number.NaN, 30.5] },
    ]);
    expect(sel.items).toHaveLength(1);
    expect(hasUsableCentroid(sel.items[0]!)).toBe(false);
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
    expect(plan.planned[0]).toMatchObject({
      outcome: "absent",
      absenceKind: "no-flood-coverage",
    });
  });

  it("emits Zone X by omission (present, not absent) when no zone contains the point", () => {
    const sel = selectPlannableParcels([parcel("R1")]);
    const plan = assembleCountyFloodHazardPlan(sel, [null], {
      countyFips: "48099",
      zonesIndexed: 1543,
    });
    expect(plan.planned[0]).toEqual({
      outcome: "present",
      parcelKey: "R1",
      inSpecialFloodHazardArea: false,
      floodZone: null,
      zoneSubtype: null,
      baseFloodElevation: null,
    });
    expect(plan.counts.presentOutside).toBe(1);
  });

  it("carries zone attributes and the SFHA flag onto the record", () => {
    const sel = selectPlannableParcels([parcel("R1")]);
    const plan = assembleCountyFloodHazardPlan(sel, [AE], {
      countyFips: "48099",
      zonesIndexed: 1543,
    });
    expect(plan.planned[0]).toEqual({
      outcome: "present",
      parcelKey: "R1",
      inSpecialFloodHazardArea: true,
      floodZone: "AE",
      zoneSubtype: null,
      baseFloodElevation: 412.5,
      sourceVintage: "nfhl-2026-06",
    });
    expect(plan.counts.presentInSfha).toBe(1);
  });

  it("classifies SFHA exactly as isSfhaFlag does — 'TRUE' is not SFHA", () => {
    const sel = selectPlannableParcels([parcel("R1"), parcel("R2"), parcel("R3")]);
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

  it("absents a parcel with no usable centroid even when zones exist", () => {
    const sel = selectPlannableParcels([parcel("R1", null)]);
    const plan = assembleCountyFloodHazardPlan(sel, [null], {
      countyFips: "48099",
      zonesIndexed: 1543,
    });
    expect(plan.planned[0]).toMatchObject({
      outcome: "absent",
      reason: "no usable geocode/centroid for 48099:R1",
    });
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
    const parcels = [{ parcelKey: "R1", centroid: [2, 2] as const }];
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
  });
});
