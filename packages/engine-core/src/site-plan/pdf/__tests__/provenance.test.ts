import { describe, expect, it } from "vitest";

import { composeSitePlanModel } from "../../site-model.js";
import { buildProvenancePanelEntries, SITE_PLAN_HONESTY_LINE } from "../provenance.js";

const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2,
    199.8, 200.2, 200.7, 201.0,
    199.5, 200.0, 200.4, 200.8,
    199.2, 199.7, 200.1, 200.5,
  ]),
  minElevation: 199.2,
  maxElevation: 201.2,
  nodataCount: 0,
};

const ringWgs84: Array<[number, number]> = [
  [-98.4998, 29.4001],
  [-98.4996, 29.4001],
  [-98.4996, 29.4003],
  [-98.4998, 29.4003],
  [-98.4998, 29.4001],
];

const setback = {
  front: 10,
  side: 5,
  rear: 20,
  sourceCodeAtomRef: { atomDid: "san_antonio_tx/udc/35-310.01/35-310.01", role: "rule", entityType: "code-section" },
};

describe("SITE_PLAN_HONESTY_LINE", () => {
  it("matches the exact WDLL-mandated string", () => {
    expect(SITE_PLAN_HONESTY_LINE).toBe(
      "Derived from public GIS records. Not a boundary survey. Not for legal record.",
    );
  });
});

describe("buildProvenancePanelEntries", () => {
  it("cites the setback rule's code section on the SETBACK entry", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      zoning: { district: "R-6" },
      floodZone: { honestUnavailable: true, reason: "test" },
    });
    const entries = buildProvenancePanelEntries(model);
    const setbackEntry = entries.find((e) => e.layer === "Setback");
    expect(setbackEntry).toBeTruthy();
    // §11: machine identifiers live ONLY in the source column.
    expect(setbackEntry!.source).toContain("san_antonio_tx/udc/35-310.01/35-310.01");
    // §13: confidence is the fixed short enum.
    expect(setbackEntry!.confidence).toBe("rule");
  });

  it("honestly discloses zoning and flood-zone absence/unavailability rather than fabricating them", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
    });
    const entries = buildProvenancePanelEntries(model);
    const zoningEntry = entries.find((e) => e.layer === "Zoning");
    const floodEntry = entries.find((e) => e.layer === "Flood zone");
    expect(zoningEntry!.confidence).toMatch(/honest absence/i);
    expect(floodEntry!.confidence).toMatch(/honest unavailable/i);
  });

  it("cites a live flood-zone read when supplied", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      floodZone: {
        zone: "X",
        inSpecialFloodHazardArea: false,
        sourceCitation: "FEMA National Flood Hazard Layer (NFHL)",
        asOfIso: "2026-07-25T00:00:00.000Z",
      },
    });
    const entries = buildProvenancePanelEntries(model);
    const floodEntry = entries.find((e) => e.layer === "Flood zone");
    expect(floodEntry!.source).toBe("FEMA National Flood Hazard Layer (NFHL)");
    expect(floodEntry!.confidence).toMatch(/zone X/);
  });

  it("cites the zoning-fact source when a district is present", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      zoning: { district: "R-6" },
    });
    const entries = buildProvenancePanelEntries(model);
    const zoningEntry = entries.find((e) => e.layer === "Zoning");
    expect(zoningEntry!.confidence).toBe("asserted");
  });
});
