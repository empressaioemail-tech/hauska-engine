import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadMlFootprintsForBbox } from "../ml-footprint-loader.js";

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "__fixtures__",
  "jonesHigginsMlFootprints.json",
);

describe("loadMlFootprintsForBbox", () => {
  it("loads fixture footprints inside bbox", async () => {
    const result = await loadMlFootprintsForBbox({
      bbox: {
        westLng: -97.34,
        southLat: 30.1,
        eastLng: -97.32,
        northLat: 30.12,
      },
      fixturePath: FIXTURE,
    });
    expect(result.features.length).toBeGreaterThan(0);
    expect(result.sourceLabel).toContain("fixture:");
    expect(result.featuresRead).toBe(result.features.length);
  });

  it("returns zero when bbox excludes fixture features", async () => {
    const result = await loadMlFootprintsForBbox({
      bbox: {
        westLng: -100,
        southLat: 25,
        eastLng: -99,
        northLat: 26,
      },
      fixturePath: FIXTURE,
    });
    expect(result.features).toHaveLength(0);
    expect(result.featuresRead).toBe(0);
  });
});

describe("loadMlFootprintsForBbox live zip", () => {
  const zipPath = process.env.ML_FOOTPRINT_TEST_ZIP?.trim();
  const live = zipPath ? it : it.skip;

  live("streams Texas.geojson zip with bounded queue depth", async () => {
    const result = await loadMlFootprintsForBbox({
      zipPath,
      bbox: {
        westLng: -97.45,
        southLat: 30.05,
        eastLng: -97.25,
        northLat: 30.2,
      },
      probeOnly: true,
    });
    expect(result.partitionsStreamed).toBe(1);
    expect(result.featuresScanned).toBeGreaterThan(1_000_000);
    expect(result.featuresRead).toBeGreaterThan(1_000);
    expect(result.peakQueueDepth).toBeLessThanOrEqual(33);
  }, 600_000);
});
