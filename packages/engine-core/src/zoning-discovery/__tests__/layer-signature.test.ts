import { describe, expect, it } from "vitest";

import {
  classifyLayerSignature,
  isBuildingLineOnlyLayer,
  isLotSizeOnlyLayer,
} from "../layer-signature.js";
import type { LayerFieldMeta } from "../types.js";

const cityBbox = { xmin: -95.2, ymin: 29.6, xmax: -95.0, ymax: 29.8 };

describe("layer signature — constraint rejection", () => {
  it("rejects LOTSIZE-only layer as Euclidean candidate", () => {
    const fields: LayerFieldMeta[] = [
      { name: "LOTSIZE", type: "esriFieldTypeDouble" },
      { name: "ORDINANCE", type: "esriFieldTypeString" },
    ];
    const sampleValues = {
      LOTSIZE: [5000, 7200, 6000],
      ORDINANCE: ["2006-0842", "2006-0843"],
    };
    expect(isLotSizeOnlyLayer(fields, sampleValues)).toBe(true);

    const result = classifyLayerSignature({
      layerUrl: "https://example.gov/rest/services/x/MapServer/13",
      servicePath: "HoustonMap/Planning_and_Development",
      layerId: 13,
      name: "Special Minimum Lot Size",
      geometryType: "esriGeometryPolygon",
      featureCount: 722,
      fields,
      sampleValues,
      extent: cityBbox,
      cityBbox,
    });
    expect(result.isEuclideanCandidate).toBe(false);
    expect(result.isConstraintLayer).toBe(true);
    expect(result.rejectReason).toBe("lot-size-only");
  });

  it("rejects BLD__LINE-only layer as Euclidean candidate", () => {
    const fields: LayerFieldMeta[] = [
      { name: "BLD__LINE", type: "esriFieldTypeDouble" },
      { name: "ORDINANCE_", type: "esriFieldTypeString" },
    ];
    const sampleValues = {
      BLD__LINE: [25, 30, 20],
      ORDINANCE_: ["2006-0781"],
    };
    expect(isBuildingLineOnlyLayer(fields, sampleValues)).toBe(true);

    const result = classifyLayerSignature({
      layerUrl: "https://example.gov/rest/services/x/MapServer/12",
      servicePath: "HoustonMap/Planning_and_Development",
      layerId: 12,
      name: "Special Minimum Building Lines",
      geometryType: "esriGeometryPolygon",
      featureCount: 195,
      fields,
      sampleValues,
      extent: cityBbox,
      cityBbox,
    });
    expect(result.isEuclideanCandidate).toBe(false);
    expect(result.isConstraintLayer).toBe(true);
    expect(result.rejectReason).toBe("building-line-only");
  });

  it("rejects map-grid PageName tokens (A1/C1) without strong Euclidean codes", () => {
    const fields: LayerFieldMeta[] = [{ name: "PageName", type: "esriFieldTypeString" }];
    const sampleValues = {
      PageName: ["A1", "A2", "B1", "C1", "C2", "D3"],
    };
    const result = classifyLayerSignature({
      layerUrl: "https://example.gov/rest/services/WGS84/Grid/MapServer/0",
      servicePath: "WGS84/Grid",
      layerId: 0,
      name: "Grid",
      geometryType: "esriGeometryPolygon",
      featureCount: 36,
      fields,
      sampleValues,
      extent: cityBbox,
      cityBbox,
    });
    expect(result.isEuclideanCandidate).toBe(false);
    expect(result.rejectReason).toMatch(/no-strong-euclidean|no-code-field/);
  });

  it("accepts polygon layer with Euclidean district codes", () => {
    const fields: LayerFieldMeta[] = [
      { name: "Code", type: "esriFieldTypeString" },
      { name: "Zoning", type: "esriFieldTypeString" },
    ];
    const sampleValues = {
      Code: ["SF1", "SF2", "MF1", "GC"],
      Zoning: ["Single Family 1", "General Commercial"],
    };
    const result = classifyLayerSignature({
      layerUrl: "https://example.gov/rest/services/WGS84/Zoning/MapServer/0",
      servicePath: "WGS84/Zoning_WGS84",
      layerId: 0,
      name: "Zoning Districts",
      geometryType: "esriGeometryPolygon",
      featureCount: 301,
      fields,
      sampleValues,
      extent: cityBbox,
      cityBbox,
    });
    expect(result.isEuclideanCandidate).toBe(true);
    expect(result.codeField).toBe("Code");
  });
});
