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
      objectIdField: "OBJECTID",
      sampleValues,
      extent: cityBbox,
      cityBbox,
      cityCoverageRatio: 0.9,
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
      objectIdField: "OBJECTID",
      sampleValues,
      extent: cityBbox,
      cityBbox,
      cityCoverageRatio: 0.9,
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
      objectIdField: "OBJECTID",
      sampleValues,
      extent: cityBbox,
      cityBbox,
      cityCoverageRatio: 0.9,
    });
    expect(result.isEuclideanCandidate).toBe(false);
    expect(result.rejectReason).toMatch(/strong-code-ratio|no-code-field/);
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
      objectIdField: "OBJECTID",
      sampleValues,
      extent: cityBbox,
      cityBbox,
      cityCoverageRatio: 0.9,
    });
    expect(result.isEuclideanCandidate).toBe(true);
    expect(result.codeField).toBe("Code");
  });

  it("rejects park-name distributions even when two names share zoning-like prefixes", () => {
    const fields: LayerFieldMeta[] = [
      { name: "NAME", type: "esriFieldTypeString" },
      { name: "Class", type: "esriFieldTypeString" },
    ];
    const sampleValues = {
      NAME: [
        "Independence Park",
        "Residential Commons Park",
        "Northwest Community Park",
        "Frisco Commons",
        "Central Park",
      ],
      Class: ["Neighborhood Park", "Community Park"],
    };
    const result = classifyLayerSignature({
      layerUrl: "https://example.gov/rest/services/Denton/FeatureServer/15",
      servicePath: "Denton",
      layerId: 15,
      name: "Parks",
      geometryType: "esriGeometryPolygon",
      featureCount: 18,
      fields,
      objectIdField: "OBJECTID_1",
      sampleValues,
      extent: cityBbox,
      cityBbox,
      cityCoverageRatio: 0.04,
    });
    expect(result.isEuclideanCandidate).toBe(false);
    expect(result.rejectReason).toMatch(
      /no-code-field-shape|code-length-distribution|strong-code-ratio/,
    );
  });

  it("rejects a code-shaped polygon layer that covers too little of the city", () => {
    const fields: LayerFieldMeta[] = [
      { name: "ZONE", type: "esriFieldTypeString" },
    ];
    const result = classifyLayerSignature({
      layerUrl: "https://example.gov/rest/services/partial/MapServer/0",
      servicePath: "partial",
      layerId: 0,
      name: "Partial polygons",
      geometryType: "esriGeometryPolygon",
      featureCount: 5,
      fields,
      objectIdField: "OID",
      sampleValues: { ZONE: ["R-1", "C-1", "SF2"] },
      extent: cityBbox,
      cityBbox,
      cityCoverageRatio: 0.2,
    });
    expect(result.isEuclideanCandidate).toBe(false);
    expect(result.rejectReason).toBe("city-coverage-ratio=0.200");
  });

  it("rejects county city-limits CityCode abbreviations as zoning districts", () => {
    const fields: LayerFieldMeta[] = [
      { name: "CityCode", type: "esriFieldTypeString" },
      { name: "NAME", type: "esriFieldTypeString" },
    ];
    const sampleValues = {
      CityCode: ["FRIS", "DENT", "PLAN", "LEWI", "PROS"],
      NAME: ["Frisco", "Denton", "Plano", "Lewisville", "Prosper"],
    };
    const result = classifyLayerSignature({
      layerUrl: "https://example.gov/rest/services/Denton/FeatureServer/27",
      servicePath: "Denton",
      layerId: 27,
      name: "City Limits",
      geometryType: "esriGeometryPolygon",
      featureCount: 117,
      fields,
      objectIdField: "OBJECTID_1",
      sampleValues,
      extent: { xmin: -97.45, ymin: 32.94, xmax: -96.78, ymax: 33.47 },
      cityBbox,
      cityCoverageRatio: 0.74,
    });
    expect(result.isEuclideanCandidate).toBe(false);
    expect(result.rejectReason).toMatch(
      /no-code-field-shape|strong-code-ratio|extent-to-city-area-ratio/,
    );
  });
});
