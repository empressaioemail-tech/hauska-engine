import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { classifyDiscoveryEvidence } from "../classify.js";
import type { DiscoveryProbeEvidence, QueueItem } from "../types.js";

const srcRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...collectTsFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("no per-city hardcode branches", () => {
  it("grep gate: no cityKey === equality branches in zoning-discovery src", () => {
    const files = collectTsFiles(srcRoot);
    const violations: string[] = [];
    const pattern = /cityKey\s*===\s*['"]/;

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (pattern.test(text)) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("classify — jurisdictionKind unincorporated", () => {
  const item: QueueItem = {
    cityKey: "unincorporated-harris-tx",
    cityName: "Unincorporated Harris County",
    cityGeoId: "",
    parentCountyFips: "48201",
    jurisdictionKind: "unincorporated",
    bbox4326: { xmin: -95.8, ymin: 29.5, xmax: -94.9, ymax: 30.2 },
  };

  const emptyEvidence: DiscoveryProbeEvidence = {
    cityKey: item.cityKey,
    searchPaths: [],
    layers: [],
    bestEuclidean: null,
    constraintLayers: [],
    emptySearch: true,
    allPathsTransportFailed: false,
    anyAuthBlocked: false,
  };

  it("returns NO-ZONING-AUTHORITY without empty-search absence", () => {
    const verdict = classifyDiscoveryEvidence(item, emptyEvidence);
    expect(verdict.status).toBe("NO-ZONING-AUTHORITY");
  });
});

describe("classify — NO-EUCLIDEAN-REGIME", () => {
  const item: QueueItem = {
    cityKey: "example-city-tx",
    cityName: "Example",
    cityGeoId: "4800000",
    parentCountyFips: "48000",
    jurisdictionKind: "incorporated-city",
    bbox4326: { xmin: -95.2, ymin: 29.6, xmax: -95.0, ymax: 29.8 },
  };

  it("returns NO-EUCLIDEAN-REGIME when constraints present and no Euclidean candidate", () => {
    const evidence: DiscoveryProbeEvidence = {
      cityKey: item.cityKey,
      searchPaths: [{ url: "https://example.gov/rest/services", source: "seed", httpStatus: 200, transportError: null, authBlocked: false, pathsAttempted: ["/"], layersInspected: 2 }],
      layers: [
        {
          layerUrl: "https://example.gov/rest/services/x/MapServer/13",
          servicePath: "x",
          layerId: 13,
          name: "Special Minimum Lot Size",
          geometryType: "esriGeometryPolygon",
          featureCount: 100,
          fields: [{ name: "LOTSIZE", type: "esriFieldTypeDouble" }],
          codeField: null,
          descriptionField: null,
          extent: item.bbox4326,
          euclideanScore: 0,
          isConstraintLayer: true,
          isEuclideanCandidate: false,
          rejectReason: "lot-size-only",
        },
      ],
      bestEuclidean: null,
      constraintLayers: [
        {
          layerUrl: "https://example.gov/rest/services/x/MapServer/13",
          servicePath: "x",
          layerId: 13,
          name: "Special Minimum Lot Size",
          geometryType: "esriGeometryPolygon",
          featureCount: 100,
          fields: [],
          codeField: null,
          descriptionField: null,
          extent: item.bbox4326,
          euclideanScore: 0,
          isConstraintLayer: true,
          isEuclideanCandidate: false,
          rejectReason: "lot-size-only",
        },
      ],
      emptySearch: false,
      allPathsTransportFailed: false,
      anyAuthBlocked: false,
    };

    const verdict = classifyDiscoveryEvidence(item, evidence);
    expect(verdict.status).toBe("NO-EUCLIDEAN-REGIME");
  });
});

describe("classify — LAYER-FOUND beats AUTH-WALLED", () => {
  const item: QueueItem = {
    cityKey: "example-city-tx",
    cityName: "Example",
    cityGeoId: "4800000",
    parentCountyFips: "48000",
    jurisdictionKind: "incorporated-city",
    bbox4326: { xmin: -95.2, ymin: 29.6, xmax: -95.0, ymax: 29.8 },
  };

  it("returns LAYER-FOUND when bestEuclidean exists even if anyAuthBlocked", () => {
    const layer = {
      layerUrl: "https://example.gov/rest/services/x/MapServer/0",
      servicePath: "x",
      layerId: 0,
      name: "Zoning",
      geometryType: "esriGeometryPolygon",
      featureCount: 10,
      fields: [{ name: "CODE", type: "esriFieldTypeString" }],
      codeField: "CODE",
      descriptionField: null,
      extent: item.bbox4326,
      euclideanScore: 20,
      isConstraintLayer: false,
      isEuclideanCandidate: true,
      rejectReason: null,
    };
    const evidence: DiscoveryProbeEvidence = {
      cityKey: item.cityKey,
      searchPaths: [],
      layers: [layer],
      bestEuclidean: layer,
      constraintLayers: [],
      emptySearch: false,
      allPathsTransportFailed: false,
      anyAuthBlocked: true,
    };
    expect(classifyDiscoveryEvidence(item, evidence).status).toBe("LAYER-FOUND");
  });
});
