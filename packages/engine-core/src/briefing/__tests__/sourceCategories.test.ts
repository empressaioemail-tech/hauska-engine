import { describe, expect, it } from "vitest";
import {
  categorizeLayerKind,
  citationLabel,
  groupSourcesBySection,
} from "../sourceCategories";
import type { BriefingSourceInput } from "../types";

const src = (overrides: Partial<BriefingSourceInput>): BriefingSourceInput => ({
  id: overrides.id ?? "src-1",
  layerKind: overrides.layerKind ?? "unknown",
  sourceKind: overrides.sourceKind ?? "manual-upload",
  provider: overrides.provider ?? null,
  snapshotDate: overrides.snapshotDate ?? "2026-04-01",
  note: overrides.note ?? null,
  payload: overrides.payload,
});

describe("categorizeLayerKind", () => {
  it("routes flood/wetland/soil to section B", () => {
    expect(categorizeLayerKind("fema-flood")).toBe("b");
    expect(categorizeLayerKind("nws-snow-load")).toBe("b");
    expect(categorizeLayerKind("usda-soil-map")).toBe("b");
    expect(categorizeLayerKind("nwi-wetland")).toBe("b");
  });
  it("routes zoning/overlays/historic to section C", () => {
    expect(categorizeLayerKind("qgis-zoning")).toBe("c");
    expect(categorizeLayerKind("historic-overlay")).toBe("c");
    expect(categorizeLayerKind("setback-zone")).toBe("c");
  });
  it("routes utilities + roads to section D", () => {
    expect(categorizeLayerKind("water-main")).toBe("d");
    expect(categorizeLayerKind("sewer-line")).toBe("d");
    expect(categorizeLayerKind("street-centerline")).toBe("d");
    expect(categorizeLayerKind("electric-grid")).toBe("d");
  });
  it("routes parcel/topo/buildable to section E", () => {
    expect(categorizeLayerKind("parcel-polygon")).toBe("e");
    expect(categorizeLayerKind("usgs-topo")).toBe("e");
    expect(categorizeLayerKind("buildable-envelope")).toBe("e");
  });
  it("routes neighbors/adjacent to section F", () => {
    expect(categorizeLayerKind("parcel-neighbors")).toBe("f");
    expect(categorizeLayerKind("adjacent-parcels")).toBe("f");
    expect(categorizeLayerKind("nearby-context")).toBe("f");
  });
  it("falls through to general for unknowns", () => {
    expect(categorizeLayerKind("custom-thing")).toBe("general");
  });
});

describe("groupSourcesBySection", () => {
  it("returns one bucket per section with unknowns in general", () => {
    const grouped = groupSourcesBySection([
      src({ id: "1", layerKind: "fema-flood" }),
      src({ id: "2", layerKind: "qgis-zoning" }),
      src({ id: "3", layerKind: "water-main" }),
      src({ id: "4", layerKind: "parcel-polygon" }),
      src({ id: "5", layerKind: "parcel-neighbors" }),
      src({ id: "6", layerKind: "weird-thing" }),
    ]);
    expect(grouped.b.map((s) => s.id)).toEqual(["1"]);
    expect(grouped.c.map((s) => s.id)).toEqual(["2"]);
    expect(grouped.d.map((s) => s.id)).toEqual(["3"]);
    expect(grouped.e.map((s) => s.id)).toEqual(["4"]);
    expect(grouped.f.map((s) => s.id)).toEqual(["5"]);
    expect(grouped.general.map((s) => s.id)).toEqual(["6"]);
  });
});

describe("citationLabel", () => {
  it("prefers provider over layerKind", () => {
    expect(
      citationLabel(src({ provider: "FEMA", layerKind: "fema-flood" })),
    ).toBe("FEMA");
  });
  it("falls back to layerKind when provider is empty", () => {
    expect(citationLabel(src({ provider: "  ", layerKind: "qgis-zoning" }))).toBe(
      "qgis-zoning",
    );
    expect(citationLabel(src({ provider: null, layerKind: "qgis-zoning" }))).toBe(
      "qgis-zoning",
    );
  });
});
