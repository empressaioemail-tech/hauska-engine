/**
 * T2 WS1 / 109 Higgins: spike-detector for DXF contour polylines.
 *
 * Root cause: artifacts/dxf-worker/run.py emitted every contour with
 * close=True. Bastrop Contour1Ft2017 paths are open ArcGIS LineStrings;
 * sealing them draws a chord from last→first across the parcel (radiating
 * spikes/tangle in CAD). This suite parses the emitted R2000 DXF and asserts:
 *   - open paths stay open (POLYLINE flag bit 0 clear)
 *   - closed rings stay closed
 *   - one POLYLINE entity per contour path (no concatenation)
 *   - no segment longer than ~0.75 × that polyline's XY bbox diagonal
 *   - BUILDABLE carries the offset ring; SETBACK is text-only
 */

import { describe, expect, it } from "vitest";

import { buildTerrainMeshGeometry } from "../../parcel-terrain/mesh.js";
import type { ContourPolyline2d } from "../../parcel-terrain/emitters.js";
import { buildDxfSitePlanRequest, emitDxfSitePlan } from "../emitters.js";
import { composeSitePlanModel } from "../site-model.js";
import { boundaryEdgesForRing } from "./boundary-edge-fixture.js";

const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2, 199.8, 200.2, 200.7, 201.0, 199.5, 200.0, 200.4, 200.8, 199.2, 199.7,
    200.1, 200.5,
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
  sourceCodeAtomRef: {
    atomDid: "san_antonio_tx/udc/35-310.01/35-310.01",
    role: "rule",
    entityType: "code-section",
  },
};

const boundaryEdges = boundaryEdgesForRing(ringWgs84, [
  { role: "front", feet: 10 },
  { role: "side", feet: 5 },
  { role: "rear", feet: 20 },
  { role: "side", feet: 5 },
]);

/** Open ArcGIS-shaped contour: ends far apart — close=True would chord ~100m. */
const OPEN_CONTOUR: ContourPolyline2d = {
  elevation: 200.4,
  closed: false,
  points: [
    [0, 50],
    [20, 52],
    [40, 51],
    [60, 53],
    [80, 50],
    [100, 52],
  ],
};

/** Closed DEM-shaped ring (first repeated last). */
const CLOSED_CONTOUR: ContourPolyline2d = {
  elevation: 200.8,
  closed: true,
  points: [
    [10, 10],
    [30, 10],
    [30, 30],
    [10, 30],
    [10, 10],
  ],
};

const SPIKE_RATIO = 0.75;

interface ParsedPolyline {
  layer: string;
  closed: boolean;
  vertices: Array<{ x: number; y: number; z: number }>;
}

/** Parse classic 3D POLYLINE (+ VERTEX + SEQEND) entities from R2000 DXF text. */
function parsePolylines(dxf: string): ParsedPolyline[] {
  const lines = dxf.split(/\r?\n/);
  const out: ParsedPolyline[] = [];
  let i = 0;
  while (i < lines.length - 1) {
    if (lines[i]!.trim() !== "0" || lines[i + 1]!.trim() !== "POLYLINE") {
      i += 1;
      continue;
    }
    i += 2;
    let layer = "";
    let flags = 0;
    while (i < lines.length - 1) {
      const code = lines[i]!.trim();
      const value = lines[i + 1]!.trim();
      if (code === "0") break;
      if (code === "8") layer = value;
      if (code === "70") flags = Number(value) || 0;
      i += 2;
    }
    const vertices: Array<{ x: number; y: number; z: number }> = [];
    while (i < lines.length - 1) {
      if (lines[i]!.trim() === "0" && lines[i + 1]!.trim() === "SEQEND") {
        i += 2;
        break;
      }
      if (lines[i]!.trim() !== "0" || lines[i + 1]!.trim() !== "VERTEX") {
        i += 1;
        continue;
      }
      i += 2;
      let x = NaN;
      let y = NaN;
      let z = NaN;
      while (i < lines.length - 1) {
        const code = lines[i]!.trim();
        const value = lines[i + 1]!.trim();
        if (code === "0") break;
        if (code === "10") x = Number(value);
        if (code === "20") y = Number(value);
        if (code === "30") z = Number(value);
        i += 2;
      }
      if (Number.isFinite(x) && Number.isFinite(y)) {
        vertices.push({ x, y, z: Number.isFinite(z) ? z : 0 });
      }
    }
    out.push({ layer, closed: (flags & 1) === 1, vertices });
  }
  return out;
}

function maxSegmentLength(poly: ParsedPolyline): number {
  const pts = poly.vertices;
  if (pts.length < 2) return 0;
  let max = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    max = Math.max(max, Math.hypot(b.x - a.x, b.y - a.y));
  }
  if (poly.closed && pts.length >= 2) {
    const a = pts[pts.length - 1]!;
    const b = pts[0]!;
    max = Math.max(max, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return max;
}

function bboxDiagonal(poly: ParsedPolyline): number {
  const xs = poly.vertices.map((v) => v.x);
  const ys = poly.vertices.map((v) => v.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return Math.hypot(maxX - minX, maxY - minY);
}

function countLayerTableEntries(dxf: string, layer: string): number {
  // LAYER table rows: group 2 = layer name after a TABLE/LAYER context.
  return dxf.split(/\r?\n/).filter((line, i, all) => all[i - 1]?.trim() === "2" && line.trim() === layer)
    .length;
}

function countEntityLayerHits(dxf: string, layer: string): number {
  // Entities section: group 8 = layer on entity. Count all (poly + text + point).
  const lines = dxf.split(/\r?\n/);
  let inEntities = false;
  let count = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i]!.trim() === "2" && lines[i + 1]!.trim() === "ENTITIES") inEntities = true;
    if (lines[i]!.trim() === "0" && lines[i + 1]!.trim() === "ENDSEC" && inEntities) break;
    if (inEntities && lines[i]!.trim() === "8" && lines[i + 1]!.trim() === layer) count += 1;
  }
  return count;
}

describe("DXF contour spike detector (T2 WS1 / 109 Higgins)", { timeout: 20_000 }, () => {
  it("keeps open contours open and closed rings closed; no chord spikes", async () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48021:31362",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      boundaryEdges,
      geometrySourceRef: "txgio-parcel:48021:31362:fixture",
      contourOverride: [OPEN_CONTOUR, CLOSED_CONTOUR],
    });
    expect(model.contours).toHaveLength(2);

    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const request = buildDxfSitePlanRequest(model, mesh) as Record<string, any>;
    expect(request.contours).toHaveLength(2);
    expect(request.contours[0].closed).toBe(false);
    expect(request.contours[1].closed).toBe(true);

    const { bytes } = await emitDxfSitePlan(model, mesh);
    const dxf = new TextDecoder().decode(bytes);
    const polylines = parsePolylines(dxf);
    const contours = polylines.filter((p) => p.layer === "CONTOUR");

    // One POLYLINE entity per path — never concatenated into a single entity.
    expect(contours).toHaveLength(2);

    const open = contours.find((c) => !c.closed);
    const closed = contours.find((c) => c.closed);
    expect(open, "open contour must remain open (flag bit 0 clear)").toBeTruthy();
    expect(closed, "closed ring must seal (flag bit 0 set)").toBeTruthy();
    expect(open!.vertices.length).toBe(OPEN_CONTOUR.points.length);
    // Closed ring drops duplicate closing vertex before seal.
    expect(closed!.vertices.length).toBe(CLOSED_CONTOUR.points.length - 1);

    for (const contour of contours) {
      const diag = bboxDiagonal(contour);
      expect(diag).toBeGreaterThan(0);
      const maxSeg = maxSegmentLength(contour);
      expect(
        maxSeg,
        `CONTOUR spike: maxSeg=${maxSeg.toFixed(2)} > ${SPIKE_RATIO}*diag=${(SPIKE_RATIO * diag).toFixed(2)}`,
      ).toBeLessThanOrEqual(diag * SPIKE_RATIO);
    }

    // Premortem of the bug: if the open path were sealed, the chord would
    // span ~100m ≈ the polyline bbox diagonal and fail the ratio bound.
    const openChord = Math.hypot(
      OPEN_CONTOUR.points[OPEN_CONTOUR.points.length - 1]![0] - OPEN_CONTOUR.points[0]![0],
      OPEN_CONTOUR.points[OPEN_CONTOUR.points.length - 1]![1] - OPEN_CONTOUR.points[0]![1],
    );
    expect(openChord).toBeGreaterThan(bboxDiagonal(open!) * SPIKE_RATIO);
  });

  it("places buildable offset ring on BUILDABLE and setback labels on SETBACK", async () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48021:31362",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      boundaryEdges,
      geometrySourceRef: "txgio-parcel:48021:31362:fixture",
      contourOverride: [OPEN_CONTOUR, CLOSED_CONTOUR],
    });
    expect(model.setback.offsetRingLocal?.length).toBeGreaterThan(0);

    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const { bytes } = await emitDxfSitePlan(model, mesh);
    const dxf = new TextDecoder().decode(bytes);

    for (const layer of [
      "PROPERTY_LINE",
      "BUILDABLE",
      "SETBACK",
      "DIMENSION",
      "CONTOUR",
      "ELEVATION_LABEL",
      "STREET",
      "NORTH",
    ]) {
      expect(countLayerTableEntries(dxf, layer), `layer table missing ${layer}`).toBeGreaterThan(0);
    }

    const polylines = parsePolylines(dxf);
    const buildable = polylines.filter((p) => p.layer === "BUILDABLE");
    const setbackPolys = polylines.filter((p) => p.layer === "SETBACK");
    expect(buildable.length).toBe(1);
    expect(buildable[0]!.closed).toBe(true);
    expect(setbackPolys.length, "SETBACK must not carry the offset ring polyline").toBe(0);

    // SETBACK still has TEXT (role labels / legend); BUILDABLE is geometry.
    expect(countEntityLayerHits(dxf, "SETBACK")).toBeGreaterThan(0);
    expect(countEntityLayerHits(dxf, "BUILDABLE")).toBeGreaterThan(0);
    expect(countEntityLayerHits(dxf, "PROPERTY_LINE")).toBeGreaterThan(0);
    // VERTEX entities also carry layer 8 — count POLYLINE headers only.
    expect(polylines.filter((p) => p.layer === "CONTOUR")).toHaveLength(2);
  });

  it("auto-detects closedness from first≈last when `closed` is omitted", async () => {
    const openNoFlag: ContourPolyline2d = {
      elevation: 199.5,
      points: [
        [5, 5],
        [15, 6],
        [25, 5],
        [35, 7],
      ],
    };
    const closedNoFlag: ContourPolyline2d = {
      elevation: 199.9,
      points: [
        [40, 40],
        [55, 40],
        [55, 55],
        [40, 55],
        [40, 40],
      ],
    };
    const model = composeSitePlanModel({
      parcelNodeId: "48021:31362",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      boundaryEdges,
      geometrySourceRef: "txgio-parcel:48021:31362:fixture",
      contourOverride: [openNoFlag, closedNoFlag],
    });
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const { bytes } = await emitDxfSitePlan(model, mesh);
    const contours = parsePolylines(new TextDecoder().decode(bytes)).filter((p) => p.layer === "CONTOUR");
    expect(contours).toHaveLength(2);
    expect(contours.filter((c) => c.closed)).toHaveLength(1);
    expect(contours.filter((c) => !c.closed)).toHaveLength(1);
  });
});
