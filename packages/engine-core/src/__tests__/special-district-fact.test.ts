import { describe, expect, it } from "vitest";

import {
  buildDistrictSpatialIndex,
  type SpecialDistrictFeature,
} from "../special-district-fact/geo.js";
import { planCountySpecialDistricts } from "../special-district-fact/plan-county-special-districts.js";

const square: SpecialDistrictFeature = {
  districtRowId: "tceq:1",
  districtId: "100",
  districtName: "TEST MUD",
  districtType: "MUD",
  countyFips: "48021",
  status: "A",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.5, 30.0],
        [-97.4, 30.0],
        [-97.4, 30.1],
        [-97.5, 30.1],
        [-97.5, 30.0],
      ],
    ],
  },
  westLng: -97.5,
  southLat: 30.0,
  eastLng: -97.4,
  northLat: 30.1,
};

describe("special-district-fact planner", () => {
  it("marks centroid inside polygon as present (binary PIP)", () => {
    const plan = planCountySpecialDistricts(
      [{ parcelKey: "100", centroid: [-97.45, 30.05] }],
      [square],
      { countyFips: "48021" },
    );
    expect(plan.counts.parcelsInDistrict).toBe(1);
    expect(plan.planned[0]?.outcome).toBe("present");
  });

  it("marks centroid outside polygon as scoped absence, not statewide negative", () => {
    const plan = planCountySpecialDistricts(
      [{ parcelKey: "200", centroid: [-98.0, 29.0] }],
      [square],
      { countyFips: "48021" },
    );
    expect(plan.counts.parcelsOutside).toBe(1);
    const entry = plan.planned[0];
    expect(entry?.outcome).toBe("absent");
    if (entry?.outcome === "absent") {
      expect(entry.absenceKind).toBe("outside-tceq-source-boundaries");
      expect(entry.reason.toLowerCase()).not.toContain("no special district");
      expect(entry.reason).toContain("tx_special_district");
    }
  });

  it("emits one present row per intersecting district (no first-hit-only)", () => {
    const overlap = {
      ...square,
      districtRowId: "tceq:2",
      districtId: "200",
      districtName: "OVERLAP WCID",
      districtType: "WCID",
    };
    const plan = planCountySpecialDistricts(
      [{ parcelKey: "300", centroid: [-97.45, 30.05] }],
      [square, overlap],
      { countyFips: "48021" },
    );
    expect(plan.counts.presentMemberships).toBe(2);
  });
});
