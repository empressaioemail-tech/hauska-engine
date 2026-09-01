import { describe, expect, it } from "vitest";

import {
  WELL_FACT_PROXIMITY_RADIUS_METERS,
  planCountyWellFacts,
} from "../plan-county-well-facts.js";
import { pointInGeoJson } from "../geo.js";
import {
  buildApiNumber14,
  mapSymnumToWellStatus,
  mapSymnumToWellType,
} from "../symnum.js";
import {
  assertNoChunkPkCollapse,
  countWellFactPersistCollisions,
  wellFactPersistDid,
} from "../persist-key.js";

describe("well-fact symnum mapping", () => {
  it("maps producing oil well SYMNUM 4", () => {
    expect(mapSymnumToWellStatus(4)).toBe("producing");
    expect(mapSymnumToWellType(4)).toBe("oil");
  });

  it("maps plugged gas well SYMNUM 8", () => {
    expect(mapSymnumToWellStatus(8)).toBe("plugged-abandoned");
    expect(mapSymnumToWellType(8)).toBe("gas");
  });

  it("maps injection/disposal SYMNUM 11 without confident producing status", () => {
    expect(mapSymnumToWellStatus(11)).toBe("unknown");
    expect(mapSymnumToWellType(11)).toBe("disposal");
  });
});

describe("well-fact county planner", () => {
  const squareParcel = {
    parcelKey: "TEST1",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-97.0, 30.0],
          [-96.999, 30.0],
          [-96.999, 30.001],
          [-97.0, 30.001],
          [-97.0, 30.0],
        ],
      ],
    },
    westLng: -97.0,
    southLat: 30.0,
    eastLng: -96.999,
    northLat: 30.001,
  };

  it("emits on-parcel present atom when well point is inside polygon", () => {
    const plan = planCountyWellFacts(
      [squareParcel],
      [
        {
          surfaceId: 1,
          symnum: 4,
          api: "20104320",
          wellId: "04320",
          lng: -96.9995,
          lat: 30.0005,
          reliab: "15",
        },
      ],
      { countyFips: "48021" },
    );
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.onParcel).toBe(1);
    expect(plan.planned[0]?.outcome).toBe("present");
    if (plan.planned[0]?.outcome === "present") {
      expect(plan.planned[0].parcelRelation).toBe("on-parcel");
      expect(plan.planned[0].wellStatus).toBe("producing");
    }
  });

  it("emits near-parcel atom when well is outside but within radius", () => {
    const plan = planCountyWellFacts(
      [squareParcel],
      [
        {
          surfaceId: 2,
          symnum: 11,
          api: "20105893",
          wellId: "05893",
          lng: -96.9988,
          lat: 30.0005,
          reliab: "15",
        },
      ],
      { countyFips: "48021", proximityRadiusMeters: 200 },
    );
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.nearParcel).toBe(1);
    const hit = plan.planned.find((p) => p.outcome === "present");
    expect(hit?.outcome).toBe("present");
    if (hit?.outcome === "present") {
      expect(hit.parcelRelation).toBe("near-parcel");
      expect(hit.wellType).toBe("disposal");
      expect(hit.wellStatus).toBe("unknown");
      expect(hit.proximityDistanceMeters).toBeGreaterThan(0);
    }
  });

  it("prefers GIS_SYMBOL_DESCRIPTION over SYMNUM when present", () => {
    const plan = planCountyWellFacts(
      [squareParcel],
      [
        {
          surfaceId: 3,
          symnum: 4,
          api: "20109999",
          wellId: "09999",
          lng: -96.9995,
          lat: 30.0005,
          reliab: "15",
          gisSymbolDescription: "Canceled / Abandoned Location",
        },
      ],
      { countyFips: "48021" },
    );
    const hit = plan.planned.find((p) => p.outcome === "present");
    expect(hit?.outcome).toBe("present");
    if (hit?.outcome === "present") {
      expect(hit.wellStatus).toBe("unknown");
      expect(hit.wellType).toBe("unknown");
    }
  });

  it("emits typed absence when no wells qualify", () => {
    const plan = planCountyWellFacts([squareParcel], [], {
      countyFips: "48113",
    });
    expect(plan.counts.absent).toBe(1);
    expect(plan.counts.absentByKind["no-well-on-or-near"]).toBe(1);
    expect(plan.proximityRadiusMeters).toBe(WELL_FACT_PROXIMITY_RADIUS_METERS);
  });

  it("prefers on-parcel over near-parcel for the same well", () => {
    expect(
      pointInGeoJson(-96.9995, 30.0005, squareParcel.geometry),
    ).toBe(true);
    const plan = planCountyWellFacts(
      [squareParcel],
      [
        {
          surfaceId: 10,
          symnum: 4,
          api: "20104320",
          wellId: "04320-near",
          lng: -96.9988,
          lat: 30.0005,
          reliab: "15",
        },
        {
          surfaceId: 11,
          symnum: 4,
          api: "20104320",
          wellId: "04320-on",
          lng: -96.9995,
          lat: 30.0005,
          reliab: "15",
        },
      ],
      { countyFips: "48021", proximityRadiusMeters: 200 },
    );
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.collapsedDuplicateWellKeys).toBe(1);
    expect(plan.counts.onParcel).toBe(1);
    expect(plan.counts.nearParcel).toBe(0);
    const hit = plan.planned.find((p) => p.outcome === "present");
    expect(hit?.outcome).toBe("present");
    if (hit?.outcome === "present") {
      expect(hit.parcelRelation).toBe("on-parcel");
      expect(hit.wellKey).toBe("42201043200000");
    }
  });

  it("counts extras when two features share wellKey on one parcel (the 2087 class)", () => {
    const plan = planCountyWellFacts(
      [squareParcel],
      [
        {
          surfaceId: 1,
          symnum: 4,
          api: "20104320",
          wellId: "a",
          lng: -96.9995,
          lat: 30.0005,
          reliab: "15",
        },
        {
          surfaceId: 2,
          symnum: 8,
          api: "20104320",
          wellId: "b",
          lng: -96.9994,
          lat: 30.0004,
          reliab: "15",
        },
      ],
      { countyFips: "48021" },
    );
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.collapsedDuplicateWellKeys).toBe(1);
    expect(plan.planned).toHaveLength(1);
  });

  it("three distinct API-14 wellKeys on one parcel stay three present atoms", () => {
    const plan = planCountyWellFacts(
      [squareParcel],
      [
        {
          surfaceId: 1,
          symnum: 4,
          api: "20104320",
          wellId: "a",
          lng: -96.9995,
          lat: 30.0005,
          reliab: "15",
        },
        {
          surfaceId: 2,
          symnum: 8,
          api: "20105893",
          wellId: "b",
          lng: -96.9994,
          lat: 30.0004,
          reliab: "15",
        },
        {
          surfaceId: 3,
          symnum: 11,
          api: "20109999",
          wellId: "c",
          lng: -96.9996,
          lat: 30.0006,
          reliab: "15",
        },
      ],
      { countyFips: "48021" },
    );
    expect(plan.counts.present).toBe(3);
    expect(plan.counts.collapsedDuplicateWellKeys).toBe(0);
    const keys = plan.planned
      .filter((p) => p.outcome === "present")
      .map((p) => p.wellKey)
      .sort();
    expect(keys).toEqual([
      "42201043200000",
      "42201058930000",
      "42201099990000",
    ]);
  });
});

describe("well-fact persist PK collapse (same-API feature class)", () => {
  it("counts extras when two atoms share entityId", () => {
    const collisions = countWellFactPersistCollisions([
      { entityId: "48021:10001:42201043200000" },
      { entityId: "48021:10001:42201043200000" },
      { entityId: "48021:10002:none" },
    ]);
    expect(collisions.unique).toBe(2);
    expect(collisions.extras).toBe(1);
    expect(collisions.collapsedEntityIds).toEqual([
      "48021:10001:42201043200000",
    ]);
    expect(wellFactPersistDid("48021:10001:42201043200000")).toBe(
      "did:hauska:well-fact:48021:10001:42201043200000",
    );
  });

  it("CHUNK_PK_COLLAPSE throws when unique persist PKs are fewer than the slice", () => {
    expect(() =>
      assertNoChunkPkCollapse([
        "48021:10001:42201043200000",
        "48021:10001:42201043200000",
      ]),
    ).toThrow(/CHUNK_PK_COLLAPSE/);
  });

  it("CHUNK_PK_COLLAPSE does not throw when every persist PK is unique", () => {
    const record = assertNoChunkPkCollapse([
      "48021:10001:42201043200000",
      "48021:10002:none",
    ]);
    expect(record.plannedIn).toHaveLength(2);
    expect(record.writtenOut).toHaveLength(2);
  });
});

describe("buildApiNumber14 collision classes", () => {
  it("empty and null API collapse to the same 14-digit zero wellKey", () => {
    expect(buildApiNumber14("")).toBe("42000000000000");
    expect(buildApiNumber14(null)).toBe("42000000000000");
    expect(buildApiNumber14(undefined)).toBe("42000000000000");
  });

  it("8-digit county+unique matches the Caldwell stored shape", () => {
    expect(buildApiNumber14("05534595")).toBe("42055345950000");
  });

  it("14-digit APIs that already carry 42 lose the event suffix", () => {
    expect(buildApiNumber14("42021316410000")).toBe(
      buildApiNumber14("42021316410001"),
    );
  });
});
