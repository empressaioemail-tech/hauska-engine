import { describe, expect, it } from "vitest";

import {
  WELL_FACT_PROXIMITY_RADIUS_METERS,
  planCountyWellFacts,
} from "../plan-county-well-facts.js";
import { pointInGeoJson } from "../geo.js";
import { mapSymnumToWellStatus, mapSymnumToWellType } from "../symnum.js";

describe("well-fact symnum mapping", () => {
  it("maps producing oil well SYMNUM 4", () => {
    expect(mapSymnumToWellStatus(4)).toBe("producing");
    expect(mapSymnumToWellType(4)).toBe("oil");
  });

  it("maps plugged gas well SYMNUM 8", () => {
    expect(mapSymnumToWellStatus(8)).toBe("plugged-abandoned");
    expect(mapSymnumToWellType(8)).toBe("gas");
  });

  it("maps injection/disposal SYMNUM 11", () => {
    expect(mapSymnumToWellStatus(11)).toBe("producing");
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
      expect(hit.proximityDistanceMeters).toBeGreaterThan(0);
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
  });
});
