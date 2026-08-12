import { describe, expect, it } from "vitest";

import { planCountyRoadNodes } from "../plan-county-road-nodes.js";

const BASE_OBS = {
  osmWayId: 123,
  displayName: "Main St",
  osmHighwayTag: "residential",
  osmTags: { highway: "residential" },
  classification: "residential" as const,
  centerline: [
    [-97.3, 30.1],
    [-97.29, 30.11],
  ] as const,
  sourceCitation: "OpenStreetMap way/123 highway=residential",
  extractedAt: "2026-08-11T00:00:00.000Z",
};

describe("planCountyRoadNodes", () => {
  it("derives roadNodeId as {countyFips}:road:{osmWayId}", () => {
    const plan = planCountyRoadNodes(
      [{ osmWayId: 123, observation: { ...BASE_OBS, osmWayId: 123 } }],
      { countyFips: "48021" },
    );
    expect(plan.planned[0]?.roadNodeId).toBe("48021:road:123");
  });

  it("fail-closed collision when prior protected adapter holds same id", () => {
    const plan = planCountyRoadNodes(
      [{ osmWayId: 123, observation: { ...BASE_OBS, osmWayId: 123 } }],
      { countyFips: "48021" },
      [
        {
          roadNodeId: "48021:road:123",
          osmWayId: 123,
          sourceAdapter: "road-intake-osm-overpass",
          status: "active",
        },
      ],
    );
    expect(plan.collisionCandidates.length).toBeGreaterThan(0);
  });
});
