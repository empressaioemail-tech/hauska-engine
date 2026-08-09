import { describe, expect, it } from "vitest";

import { isNonPavementOsmHighwayTag } from "../classify.js";
import {
  decideRoadSupersede,
  ROAD_PBF_SOURCE_ADAPTER,
} from "../road-supersede.js";
import {
  COUNTY_ROADWAY_ID_OFFSET,
  countyRoadwaySyntheticWayId,
  isLegacyCountySyntheticWayId,
  LEGACY_COUNTY_ROADWAY_ID_OFFSET,
} from "../classify-county-street.js";
import {
  buildCountyBoundaryIndex,
  resolveWayCounties,
  segmentsIntersect,
  type CountyBoundaryRecord,
} from "../way-to-county.js";
import { collinearOrientationEpsilon } from "../geometry-epsilon.js";

/** Realistic diagonal split — TIGER-style, not unit squares. */
function diagonalSplitCounties(): ReturnType<typeof buildCountyBoundaryIndex> {
  // Shared edge: (-97.40, 30.00) → (-97.20, 30.20)
  const sharedA: [number, number] = [-97.4, 30.0];
  const sharedB: [number, number] = [-97.2, 30.2];
  const west: CountyBoundaryRecord = {
    countyFips: "48021",
    countyName: "Bastrop",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-97.6, 29.8],
          sharedB,
          sharedA,
          [-97.6, 29.8],
        ],
      ],
    },
  };
  const east: CountyBoundaryRecord = {
    countyFips: "48055",
    countyName: "Caldwell",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          sharedA,
          sharedB,
          [-97.0, 30.4],
          [-97.0, 29.8],
          sharedA,
        ],
      ],
    },
  };
  return buildCountyBoundaryIndex([west, east]);
}

describe("collinearOrientationEpsilon", () => {
  it("exceeds 1e-18 on realistic Texas diagonal coordinates", () => {
    const a: [number, number] = [-97.4, 30.0];
    const b: [number, number] = [-97.2, 30.2];
    const mid: [number, number] = [-97.3, 30.1];
    const eps = collinearOrientationEpsilon(a, b, mid, mid);
    expect(eps).toBeGreaterThan(1e-15);
    expect(eps).toBeLessThan(1e-12);
  });

  it("detects collinear touch on diagonal WGS84 edge", () => {
    const a: [number, number] = [-97.4, 30.0];
    const b: [number, number] = [-97.2, 30.2];
    const c: [number, number] = [-97.35, 30.05];
    const d: [number, number] = [-97.25, 30.15];
    expect(segmentsIntersect(a, b, c, d)).toBe(true);
  });
});

describe("two-county diagonal boundary (H2 pre-registered)", () => {
  const index = diagonalSplitCounties();
  const JITTER = 3e-5;
  const SWEEP = 200;

  it("assigns ≥99% of along-line jittered ways to BOTH counties", () => {
    let both = 0;
    let oneOnly = 0;
    let neither = 0;
    for (let i = 0; i < SWEEP; i++) {
      const t0 = 0.05 + (0.9 * i) / SWEEP;
      const t1 = t0 + 0.02;
      const j = ((i % 7) - 3) * JITTER;
      const along: readonly [number, number][] = [
        [-97.4 + 0.2 * t0 + j, 30.0 + 0.2 * t0 + j],
        [-97.4 + 0.2 * t1 + j, 30.0 + 0.2 * t1 + j],
      ];
      const { hits, unresolved } = resolveWayCounties(along, index);
      const fips = new Set(hits.map((h) => h.countyFips));
      if (unresolved || fips.size === 0) neither += 1;
      else if (fips.has("48021") && fips.has("48055") && fips.size === 2) both += 1;
      else if (fips.size === 1) oneOnly += 1;
      else neither += 1;
    }
    expect(oneOnly / SWEEP).toBeLessThan(0.01);
    expect(neither / SWEEP).toBe(0);
    expect(both / SWEEP).toBeGreaterThanOrEqual(0.99);
  });
});

describe("synthetic id partition (H4)", () => {
  it("negative county roadway ids never collide with positive OSM id bands", () => {
    const synth = countyRoadwaySyntheticWayId(11351);
    expect(synth).toBeLessThan(0);
    expect(synth).toBe(COUNTY_ROADWAY_ID_OFFSET - 11351);
    // Bastrop extract adversarial: real OSM ids densely in 700M–999M positive space.
    expect(synth).toBeLessThan(700_000_000);
    expect(isLegacyCountySyntheticWayId(LEGACY_COUNTY_ROADWAY_ID_OFFSET + 1)).toBe(
      true,
    );
    expect(isLegacyCountySyntheticWayId(synth)).toBe(false);
  });
});

describe("taxonomy bound (review fix)", () => {
  it("rejects proposed and construction highway tags", () => {
    expect(isNonPavementOsmHighwayTag("proposed")).toBe(true);
    expect(isNonPavementOsmHighwayTag("construction")).toBe(true);
    expect(isNonPavementOsmHighwayTag("residential")).toBe(false);
  });
});

describe("road supersede contract (H5)", () => {
  it("skips PBF overwrite of protected Overpass row", () => {
    const d = decideRoadSupersede(
      { sourceAdapter: ROAD_PBF_SOURCE_ADAPTER, versionStamp: "v2" },
      {
        atomDid: "did:hauska:road-node:48021:road:1",
        sourceAdapter: "road-intake-osm-overpass",
        versionStamp: "v1",
        status: "active",
      },
    );
    expect(d.action).toBe("skip-protected");
  });

  it("allows same-adapter re-ingest upsert", () => {
    const d = decideRoadSupersede(
      { sourceAdapter: ROAD_PBF_SOURCE_ADAPTER, versionStamp: "v2" },
      {
        atomDid: "x",
        sourceAdapter: ROAD_PBF_SOURCE_ADAPTER,
        versionStamp: "v1",
        status: "active",
      },
    );
    expect(d.action).toBe("upsert");
  });
});
