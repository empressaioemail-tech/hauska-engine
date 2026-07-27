import { describe, expect, it } from "vitest";

import { composeSitePlanModel } from "../../site-model.js";
import { buildSitePlanDrawingLayout, projectPoint, type DrawingBox } from "../layout.js";
import { formatGisBearing, formatPropertyLineTag, PROPERTY_LINE_TAGS_HONESTY } from "../annotation-placement.js";

// Same fixture shape as site-model.test.ts: a ~70x110 ft lot inside a 4x4
// DEM, San Antonio R-6 setback (front=10, side=5, rear=20 ft) for
// 48029:105129.
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

function buildModel(streetAnchors?: Array<{ name: string; points: Array<[number, number]>; sourceRef?: string }>) {
  return composeSitePlanModel({
    parcelNodeId: "48029:105129",
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
    streetAnchors,
  });
}

const box: DrawingBox = { x: 36, y: 60, width: 540, height: 600 };

describe("formatGisBearing / property-line tags", () => {
  it("formats cardinal directions from local-ENU deltas ( +Y north, +X east )", () => {
    expect(formatGisBearing(0, 10)).toBe("N 0°00' E");
    expect(formatGisBearing(10, 0)).toBe("N 90°00' E");
    expect(formatGisBearing(0, -10)).toBe("S 0°00' W");
    expect(formatGisBearing(-10, 0)).toBe("N 90°00' W");
  });

  it("includes bearing + feet and never claims survey grade in the tag text", () => {
    const tag = formatPropertyLineTag({
      a: { x: 0, y: 0 },
      b: { x: 0, y: 30.48 },
      lengthFeet: 100,
    });
    expect(tag).toContain("100.0'");
    expect(tag).toMatch(/N /);
    expect(tag.toLowerCase()).not.toContain("survey");
  });
});

describe("buildSitePlanDrawingLayout", () => {
  it("projects every PROPERTY_LINE vertex through the exact same transform as the model's ringLocal points (hash/sampled-point parity)", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);

    expect(layout.propertyLine).toHaveLength(model.ringLocal.length);
    for (let i = 0; i < model.ringLocal.length; i++) {
      const expected = projectPoint(layout.transform, model.ringLocal[i]!);
      expect(layout.propertyLine[i]!.x).toBeCloseTo(expected.x, 6);
      expect(layout.propertyLine[i]!.y).toBeCloseTo(expected.y, 6);
    }
  });

  it("projects the SETBACK offset ring through the same transform as the model's offsetRingLocal", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(model.setback.offsetRingLocal).not.toBeNull();
    expect(layout.setback.offsetRing).not.toBeNull();
    const offsetRing = model.setback.offsetRingLocal!;
    for (let i = 0; i < offsetRing.length; i++) {
      const expected = projectPoint(layout.transform, offsetRing[i]!);
      expect(layout.setback.offsetRing![i]!.x).toBeCloseTo(expected.x, 6);
      expect(layout.setback.offsetRing![i]!.y).toBeCloseTo(expected.y, 6);
    }
  });

  it("keeps every projected property-line point inside the drawing box (fit-to-box did not overflow)", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    for (const p of layout.propertyLine) {
      expect(p.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(p.x).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(p.y).toBeGreaterThanOrEqual(box.y - 1);
      expect(p.y).toBeLessThanOrEqual(box.y + box.height + 1);
    }
  });

  it("carries dimension labels with the model's exact per-segment lengthFeet values", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(layout.dimensions).toHaveLength(model.propertySegments.length);
    for (let i = 0; i < model.propertySegments.length; i++) {
      expect(layout.dimensions[i]!.lengthFeet).toBe(model.propertySegments[i]!.lengthFeet);
    }
  });

  it("emits one GIS-approximate property-line tag per segment with honesty string", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(layout.propertyLineTags).toHaveLength(model.propertySegments.length);
    expect(layout.propertyLineTagsHonesty).toBe(PROPERTY_LINE_TAGS_HONESTY);
    for (let i = 0; i < model.propertySegments.length; i++) {
      expect(layout.propertyLineTags[i]!.text).toContain(
        `${model.propertySegments[i]!.lengthFeet.toFixed(1)}'`,
      );
      expect(layout.propertyLineTags[i]!.text).toMatch(/[NS] .+°.+[EW]/);
    }
  });

  it("places property-line tag boxes without pairwise overlap (non-colliding craft)", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    const boxes = layout.propertyLineTags.map((t) => t.box);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = !(
          a.x + a.width < b.x ||
          b.x + b.width < a.x ||
          a.y + a.height < b.y ||
          b.y + b.height < a.y
        );
        expect(overlap).toBe(false);
      }
    }
  });

  it("reflects street honest-absence in the layout with no fabricated anchors", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(layout.streets.honestAbsence).toBe(true);
    expect(layout.streets.anchors).toHaveLength(0);
  });

  // Track B2: parcel-primary fit — DEM contours no longer dominate the
  // transform. Contours that survive declutter must still land in-box;
  // parcel span must occupy a meaningful fraction of the drawing box.
  it("uses parcel-primary fit so property line dominates the sheet; decluttered contours stay in-box", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);

    const ringXs = layout.propertyLine.map((p) => p.x);
    const ringYs = layout.propertyLine.map((p) => p.y);
    const parcelSpan = Math.max(
      Math.max(...ringXs) - Math.min(...ringXs),
      Math.max(...ringYs) - Math.min(...ringYs),
    );
    // Parcel should fill a substantial share of the drawing box (not a tiny
    // island inside DEM-bbox spaghetti).
    expect(parcelSpan).toBeGreaterThan(Math.min(box.width, box.height) * 0.35);

    for (const contour of layout.contours) {
      for (const p of contour.points) {
        expect(p.x).toBeGreaterThanOrEqual(box.x - 2);
        expect(p.x).toBeLessThanOrEqual(box.x + box.width + 2);
        expect(p.y).toBeGreaterThanOrEqual(box.y - 2);
        expect(p.y).toBeLessThanOrEqual(box.y + box.height + 2);
      }
    }
  });

  it("projects supplied street anchors through the same transform when present", () => {
    const model = buildModel([{ name: "N PINE ST", points: [[-98.4999, 29.4002], [-98.4995, 29.4002]], sourceRef: "osm:way/123" }]);
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(layout.streets.honestAbsence).toBe(false);
    expect(layout.streets.anchors).toHaveLength(1);
    expect(layout.streets.anchors[0]!.points.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a frontage street just outside the parcel ring (not only on-ring geometry)", () => {
    // ~25 m south of the lot — typical centerline offset past the ROW.
    const model = buildModel([
      {
        name: "WILSON ST",
        points: [
          [-98.4999, 29.39985],
          [-98.4995, 29.39985],
        ],
        sourceRef: "osm:way/wilson",
      },
    ]);
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(layout.streets.anchors.map((a) => a.name)).toContain("WILSON ST");
    const baseline = buildSitePlanDrawingLayout(buildModel(), box);
    const baselineSpan = (() => {
      const xs = baseline.propertyLine.map((p) => p.x);
      const ys = baseline.propertyLine.map((p) => p.y);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    })();
    const parcelSpan = (() => {
      const xs = layout.propertyLine.map((p) => p.x);
      const ys = layout.propertyLine.map((p) => p.y);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    })();
    // Street must not expand the fit.
    expect(parcelSpan / baselineSpan).toBeGreaterThan(0.95);
    expect(parcelSpan / baselineSpan).toBeLessThan(1.05);
  });

  // Site-plan road regression: streets must not expand the fit bbox (B1+B2
  // combined failure on 48021:33890 — distant attaching road + long OSM way).
  it("does not let a distant street shrink the parcel; outlier clips off the sheet", () => {
    const baseline = buildSitePlanDrawingLayout(buildModel(), box);
    const baselineSpan = (() => {
      const xs = baseline.propertyLine.map((p) => p.x);
      const ys = baseline.propertyLine.map((p) => p.y);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    })();

    // ~1.5 km north of the fixture parcel — mirrors bad attach 48021:road:15094293.
    const model = buildModel([
      {
        name: "OUTLIER RD",
        points: [
          [-98.4997, 29.414],
          [-98.4995, 29.415],
        ],
        sourceRef: "osm:way/outlier",
      },
      {
        name: "N PINE ST",
        points: [
          [-98.4999, 29.4002],
          [-98.4995, 29.4002],
        ],
        sourceRef: "osm:way/123",
      },
    ]);
    const layout = buildSitePlanDrawingLayout(model, box);
    const ringXs = layout.propertyLine.map((p) => p.x);
    const ringYs = layout.propertyLine.map((p) => p.y);
    const parcelSpan = Math.max(
      Math.max(...ringXs) - Math.min(...ringXs),
      Math.max(...ringYs) - Math.min(...ringYs),
    );
    expect(parcelSpan).toBeGreaterThan(Math.min(box.width, box.height) * 0.35);
    expect(parcelSpan / baselineSpan).toBeGreaterThan(0.95);
    expect(parcelSpan / baselineSpan).toBeLessThan(1.05);

    const names = layout.streets.anchors.map((a) => a.name);
    expect(names).toContain("N PINE ST");
    expect(names).not.toContain("OUTLIER RD");
  });

  it("clips a long street centerline to parcel+ROW buffer instead of fitting its full extent", () => {
    const baseline = buildSitePlanDrawingLayout(buildModel(), box);
    const baselineSpan = (() => {
      const xs = baseline.propertyLine.map((p) => p.x);
      const ys = baseline.propertyLine.map((p) => p.y);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    })();

    // Long E–W way that only grazes the parcel (Chestnut-style OSM centerline).
    const model = buildModel([
      {
        name: "CHESTNUT ST",
        points: [
          [-98.505, 29.4002],
          [-98.4997, 29.4002],
          [-98.494, 29.4002],
        ],
        sourceRef: "osm:way/long",
      },
    ]);
    const layout = buildSitePlanDrawingLayout(model, box);
    const ringXs = layout.propertyLine.map((p) => p.x);
    const ringYs = layout.propertyLine.map((p) => p.y);
    const parcelSpan = Math.max(
      Math.max(...ringXs) - Math.min(...ringXs),
      Math.max(...ringYs) - Math.min(...ringYs),
    );
    expect(parcelSpan / baselineSpan).toBeGreaterThan(0.95);
    expect(parcelSpan / baselineSpan).toBeLessThan(1.05);
    expect(layout.streets.anchors).toHaveLength(1);
    const streetXs = layout.streets.anchors[0]!.points.map((p) => p.x);
    const streetSpan = Math.max(...streetXs) - Math.min(...streetXs);
    const fullXs = model.streets.anchors[0]!.pointsLocal.map((p) => projectPoint(layout.transform, p).x);
    const fullSpan = Math.max(...fullXs) - Math.min(...fullXs);
    // Clipped frontage is a fraction of the raw multi-block projection.
    expect(streetSpan).toBeLessThan(fullSpan * 0.35);
    expect(fullSpan).toBeGreaterThan(parcelSpan * 2);
  });
});
