import { describe, expect, it } from "vitest";

import {
  planCountyRailCorridor,
} from "../plan-county-rail-corridor.js";
import {
  mapNetToClass,
  mapNetToStatus,
} from "../ntad-source.js";
import {
  minEdgeToLineDistanceMeters,
  pointToSegmentMeters,
  ringsFromGeoJson,
} from "../geo.js";
import type { GradeCrossingFeature, RailCorridorFeature } from "../ntad-source.js";

describe("rail-corridor geo", () => {
  it("computes point-to-segment distance in meters", () => {
    const d = pointToSegmentMeters(
      [-97.32, 30.11],
      [-97.33, 30.11],
      [-97.31, 30.11],
    );
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(500);
  });

  it("detects parcel edge within buffer of a corridor line", () => {
    const parcelRing = ringsFromGeoJson({
      type: "Polygon",
      coordinates: [
        [
          [-97.3205, 30.1105],
          [-97.3195, 30.1105],
          [-97.3195, 30.1115],
          [-97.3205, 30.1115],
          [-97.3205, 30.1105],
        ],
      ],
    });
    const corridorLine = [
      [
        [-97.325, 30.111],
        [-97.318, 30.111],
      ],
    ];
    const dist = minEdgeToLineDistanceMeters(parcelRing, corridorLine);
    expect(dist).toBeLessThan(200);
  });
});

describe("rail-corridor NET mapping", () => {
  it("maps abandoned and trail codes", () => {
    expect(mapNetToStatus("A")).toBe("abandoned");
    expect(mapNetToStatus("T")).toBe("rail-trail");
    expect(mapNetToStatus("M")).toBe("active");
  });

  it("maps class from NET", () => {
    expect(mapNetToClass("M")).toBe("mainline");
    expect(mapNetToClass("Y")).toBe("yard");
  });

  it("does not map unmapped NET O or null to spur/active", () => {
    expect(mapNetToClass("O")).not.toBe("spur");
    expect(mapNetToClass("O")).toBe("unknown");
    expect(mapNetToClass(null)).not.toBe("spur");
    expect(mapNetToClass(null)).toBe("unknown");
    expect(mapNetToClass("")).not.toBe("spur");
    expect(mapNetToClass("")).toBe("unknown");
    expect(mapNetToStatus(null)).not.toBe("active");
    expect(mapNetToStatus(null)).toBe("unknown");
    expect(mapNetToStatus("O")).not.toBe("active");
    expect(mapNetToStatus("O")).toBe("unknown");
    expect(mapNetToStatus("")).not.toBe("active");
    expect(mapNetToStatus("")).toBe("unknown");
  });
});

describe("planCountyRailCorridor", () => {
  const corridor: RailCorridorFeature = {
    segmentId: "1",
    net: "M",
    status: "active",
    corridorClass: "mainline",
    rrowner1: "UP",
    subdiv: "Gulf Coast",
    geometry: {
      type: "LineString",
      coordinates: [
        [-97.325, 30.111],
        [-97.318, 30.111],
      ],
    },
    westLng: -97.325,
    eastLng: -97.318,
    southLat: 30.111,
    northLat: 30.111,
  };

  const crossing: GradeCrossingFeature = {
    crossingId: "416320C",
    lng: -97.32,
    lat: 30.1108,
  };

  it("plans present-near with crossings when edge is within buffer", () => {
    const plan = planCountyRailCorridor(
      [
        {
          parcelKey: "27303",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-97.3205, 30.1105],
                [-97.3195, 30.1105],
                [-97.3195, 30.1115],
                [-97.3205, 30.1115],
                [-97.3205, 30.1105],
              ],
            ],
          },
        },
      ],
      [corridor],
      [crossing],
      { countyFips: "48021" },
    );
    expect(plan.counts.presentNear).toBe(1);
    const row = plan.planned[0];
    expect(row?.outcome).toBe("present");
    if (row?.outcome === "present") {
      expect(row.nearRailCorridor).toBe(true);
      expect(row.corridorStatus).toBe("active");
      expect(row.corridorClass).toBe("mainline");
    }
  });

  it("plans present-outside when corridor is far away", () => {
    const plan = planCountyRailCorridor(
      [
        {
          parcelKey: "99999",
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
        },
      ],
      [corridor],
      [],
      { countyFips: "48021" },
    );
    expect(plan.counts.presentOutside).toBe(1);
  });

  it("typed absence when geometry missing", () => {
    const plan = planCountyRailCorridor(
      [{ parcelKey: "88888", geometry: null }],
      [corridor],
      [],
      { countyFips: "48021" },
    );
    expect(plan.counts.absent).toBe(1);
    expect(plan.planned[0]?.outcome).toBe("absent");
  });
});
