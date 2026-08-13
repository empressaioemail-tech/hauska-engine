import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadStagedNtadCorridors,
  loadStagedNtadCrossings,
} from "../staged-narn.js";

describe("staged NTAD NARN loaders", () => {
  it("maps ArcGIS paths + NET the same shape as the live fetch", () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-narn-"));
    const narnPath = join(dir, "48011.json");
    const crossingsPath = join(dir, "48011.crossings.json");
    try {
      writeFileSync(
        narnPath,
        JSON.stringify({
          countyFips: "48011",
          features: [
            {
              attributes: {
                OBJECTID: 1,
                NET: "M",
                RROWNER1: "BNSF",
                SUBDIV: "RED RIVER VALLEY",
              },
              geometry: {
                paths: [
                  [
                    [-101.2, 35.03],
                    [-101.1, 35.04],
                  ],
                ],
              },
            },
          ],
        }),
      );
      writeFileSync(
        crossingsPath,
        JSON.stringify({
          features: [
            {
              attributes: {
                CrossingID: "123456A",
                Longitude: -101.15,
                Latitude: 35.035,
              },
            },
          ],
        }),
      );
      const corridors = loadStagedNtadCorridors(narnPath);
      expect(corridors).toHaveLength(1);
      expect(corridors[0]?.segmentId).toBe("1");
      expect(corridors[0]?.status).toBe("active");
      expect(corridors[0]?.corridorClass).toBe("mainline");
      expect(corridors[0]?.westLng).toBeCloseTo(-101.2);
      expect(corridors[0]?.eastLng).toBeCloseTo(-101.1);
      const crossings = loadStagedNtadCrossings(crossingsPath);
      expect(crossings).toHaveLength(1);
      expect(crossings[0]?.crossingId).toBe("123456A");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when --narn-json path is missing (no live ArcGIS fallback)", () => {
    expect(() => loadStagedNtadCorridors("P:/tmp/does-not-exist-narn.json")).toThrow(
      /RAIL_STAGED_NARN_MISSING/,
    );
  });

  it("throws when --crossings-json path is missing", () => {
    expect(() =>
      loadStagedNtadCrossings("P:/tmp/does-not-exist-crossings.json"),
    ).toThrow(/RAIL_STAGED_CROSSINGS_MISSING/);
  });
});
