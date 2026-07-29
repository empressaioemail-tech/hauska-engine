import { describe, expect, it } from "vitest";

import { computeD8Field } from "@hauska-engine/adapters/hydrology";

import { buildDrainageGradient } from "../../drainage-gradient.js";
import {
  buildFloodDrainageBriefing,
  HONEST_EMPTY_FLAT_TERRAIN,
  type FloodDrainageStudy,
} from "../../flood-drainage-study.js";
import { AERIAL_IMAGERY_ATTRIBUTION, AERIAL_UNAVAILABLE_NOTE } from "../aerial.js";
import {
  FLOOD_DRAINAGE_BACKDROP_LINE,
  FLOOD_DRAINAGE_DEFAULT_RAINFALL_NOTE,
  FLOOD_DRAINAGE_DISCLAIMER,
  FLOOD_DRAINAGE_EMPTY_TITLE,
  FLOOD_DRAINAGE_TOTAL_SHEETS,
  emitPdfFloodDrainage,
  type EmitPdfFloodDrainageOptions,
} from "../flood-drainage.js";
import { decodeAllContentStreams } from "./decode-pdf-text.js";

// ─── fixtures ────────────────────────────────────────────────────────────
const ringWgs84: Array<[number, number]> = [
  [-97.3196, 30.1004],
  [-97.3184, 30.1004],
  [-97.3184, 30.1016],
  [-97.3196, 30.1016],
  [-97.3196, 30.1004],
];

const catchmentBbox = { westLng: -97.325, southLat: 30.095, eastLng: -97.313, northLat: 30.107 };

// 1x1 red PNG — a real, decodable PNG so the imagery success path exercises
// the actual embedPng pipeline without any network.
const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** Hermetic default: the sheet-1 imagery fetch NEVER hits the network. */
const aerialStubOk: EmitPdfFloodDrainageOptions["aerial"] = {
  fetchImage: async () => TINY_PNG,
};
const aerialStubDown: EmitPdfFloodDrainageOptions["aerial"] = {
  fetchImage: async () => {
    throw new Error("test stub: aerial endpoint unreachable");
  },
};

/** A REAL water gradient from a synthetic valley DEM (never a fake string —
 * the compositing path decodes and embeds it). */
function realGradient() {
  const W = 32;
  const H = 32;
  const elevation = new Float32Array(W * H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      elevation[row * W + col] = Math.abs(col - 16) * 2 + (H - row) * 0.5;
    }
  }
  const d8 = computeD8Field(elevation, W, H);
  const gradient = buildDrainageGradient({
    elevation,
    width: W,
    height: H,
    accumulation: d8.accumulation,
    bbox: catchmentBbox,
    rainfallDepthMm: 241,
    demResolutionMeters: 10,
    rainfallDepthInches: 9.5,
  });
  if (!gradient) throw new Error("fixture gradient must build");
  return gradient;
}

function quad(lng: number, lat: number, d: number, properties: Record<string, unknown> = {}) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lng, lat],
          [lng + d, lat],
          [lng + d, lat + d],
          [lng, lat + d],
          [lng, lat],
        ],
      ],
    },
    properties,
  };
}

function fullStudy(overrides: Partial<FloodDrainageStudy> = {}): FloodDrainageStudy {
  const base: FloodDrainageStudy = {
    parcelNodeId: "48021:47595",
    catchmentGeoJson: {
      type: "FeatureCollection",
      features: [
        quad(-97.3199, 30.1002, 0.0006, { zone: "catchment" }),
        quad(-97.3193, 30.1008, 0.0006, { zone: "catchment" }),
        // Far-out cell — must be clipped/clamped by the frame gate.
        quad(-97.34, 30.12, 0.0006, { zone: "catchment" }),
      ],
    },
    drainageZonesGeoJson: {
      type: "FeatureCollection",
      features: [
        quad(-97.3193, 30.1008, 0.0006, { zone: "catchment", concentration: 2 }),
        quad(-97.3199, 30.1002, 0.0006, { zone: "catchment", concentration: 1 }),
      ],
    },
    rainfallResultGeoJson: {
      type: "FeatureCollection",
      features: [
        // On-parcel ponding (clip-tagged by the study).
        quad(-97.3192, 30.1008, 0.0003, { rainfallDepthMm: 241, onParcel: true }),
        // Far-field ponding → context only (summary qualifier).
        quad(-97.324, 30.104, 0.001, { rainfallDepthMm: 241, onParcel: false }),
      ],
    },
    flowLinesGeoJson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [-97.319, 30.101],
              [-97.3184, 30.1009],
              [-97.3175, 30.1008],
            ],
          },
          properties: { accumulation: 120 },
        },
      ],
    },
    rainfallDepthInches: 9.5,
    rainfallSource: "noaa-atlas14",
    demProvenance: { source: "USGS 3DEP", resolutionMeters: 10 },
    briefing: "",
    gradient: realGradient(),
    flowExits: [{ lng: -97.3184, lat: 30.1009, bearingDeg: 95 }],
    stats: {
      catchmentAreaSqFt: 538_000,
      // Headline = parcel-clipped; the whole-region figure is context only.
      pondedAreaSqFt: 3_200,
      pondedAreaModeledRegionSqFt: 3_472_049,
      flowExitCount: 1,
      pourPoint: { lng: -97.319, lat: 30.101 },
      pourPointMethod: "max-accumulation-on-parcel",
    },
    computation: { library: "native-d8", routing: "d8", accumulationThreshold: 50 },
    parcelRingWgs84: ringWgs84,
    catchmentBbox,
    geometrySourceRef: "txgio-parcel:48021:47595:stratmap25",
    generatedAt: "2026-07-29T12:00:00.000Z",
    ...overrides,
  };
  base.briefing = buildFloodDrainageBriefing(base);
  return base;
}

function emptyStudy(): FloodDrainageStudy {
  const study = fullStudy({
    catchmentGeoJson: { type: "FeatureCollection", features: [] },
    drainageZonesGeoJson: { type: "FeatureCollection", features: [] },
    rainfallResultGeoJson: null,
    flowLinesGeoJson: { type: "FeatureCollection", features: [] },
    flowExits: [],
    stats: {
      catchmentAreaSqFt: 0,
      pondedAreaSqFt: null,
      pondedAreaModeledRegionSqFt: null,
      flowExitCount: 0,
      pourPoint: { lng: -97.319, lat: 30.101 },
      pourPointMethod: "ring-centroid",
    },
    honestEmpty: { reason: HONEST_EMPTY_FLAT_TERRAIN },
    computation: { library: "unavailable", routing: "d8", accumulationThreshold: 50 },
  });
  delete study.gradient;
  study.briefing = buildFloodDrainageBriefing(study);
  return study;
}

const descriptor = { address: "141 Old Antioch Rd, Smithville, TX", countyName: "Bastrop County" };

describe("emitPdfFloodDrainage", { timeout: 60_000 }, () => {
  it("emits the two-sheet document: Standard header/kicker, stat columns, summary sections, provenance, disclaimer", async () => {
    const result = await emitPdfFloodDrainage(fullStudy(), descriptor, {
      generatedAtIso: "2026-07-29T12:00:00.000Z",
      aerial: aerialStubOk,
    });
    expect(result.pageCount).toBe(FLOOD_DRAINAGE_TOTAL_SHEETS);
    expect(result.honestEmpty).toBe(false);
    expect(result.aerial.imageryEmbedded).toBe(true);
    expect(result.gradientComposited).toBe(true);

    const decoded = decodeAllContentStreams(result.bytes);
    // §2 kickers with sheet numbering.
    expect(decoded).toContain("FLOOD & DRAINAGE · SHEET 1 OF 2");
    expect(decoded).toContain("FLOOD & DRAINAGE SUMMARY · SHEET 2 OF 2");
    // Header: address + meta; stat columns.
    expect(decoded).toContain("141 OLD ANTIOCH RD");
    expect(decoded).toContain("Bastrop County");
    expect(decoded).toContain("CATCHMENT");
    expect(decoded).toContain("12.4 AC");
    expect(decoded).toContain("PONDING AT 9.5\"");
    // Headline ponding = the PARCEL-CLIPPED 3,200 SF — the 3.4M SF whole-
    // region figure must NEVER print as a headline stat (canary defect).
    expect(decoded).toContain("3,200 SF");
    expect(decoded).not.toContain("3,472,049 SF");
    expect(decoded).toContain("FLOW EXITS");
    // Summary sections (§7 grid language).
    expect(decoded).toContain("MODELED RESULTS");
    expect(decoded).toContain("538,000 sq ft");
    expect(decoded).toContain("(12.35 acres)");
    // The wider modeled region rides as a labeled context qualifier only.
    expect(decoded).toContain("Ponding on parcel");
    expect(decoded).toContain("wider modeled area 79.7 acres");
    expect(decoded).toContain("RAINFALL FORCING");
    expect(decoded).toContain("9.5 in · 24-hr · 100-yr");
    expect(decoded).toContain("NOAA Atlas 14 point estimate");
    // Briefing paragraph (the layman text).
    expect(decoded).toContain("delivers runoff toward the parcel");
    // Provenance table (§7/§13): three columns, computation basis named,
    // and the v2 water-gradient row.
    expect(decoded).toContain("PROVENANCE");
    expect(decoded).toContain("USGS 3DEP DEM · 10 m per pixel");
    expect(decoded).toContain("D8 flow accumulation · native-d8");
    expect(decoded).toContain("screening model");
    expect(decoded).toContain("Water gradient");
    // §8 fine print: the not-an-engineering-study disclaimer on the sheet,
    // plus §17-§19 backdrop language + verbatim imagery attribution.
    expect(decoded).toContain("not a drainage study or engineering determination");
    expect(decoded).toContain(FLOOD_DRAINAGE_BACKDROP_LINE);
    expect(decoded).toContain(AERIAL_IMAGERY_ATTRIBUTION);
    expect(decoded).toContain("Sheet 1 of 2");
    expect(decoded).toContain("Sheet 2 of 2");
  });

  it("composes sheet 1 in the v2 order: imagery → water gradient → catchment boundary → flow line → property line → exit arrow", async () => {
    const result = await emitPdfFloodDrainage(fullStudy(), descriptor, { aerial: aerialStubOk });
    const kinds = result.marks.filter((m) => m.page === 1).map((m) => m.kind);
    const order = [
      "imagery",
      "water-gradient",
      "catchment-boundary",
      "flow-line",
      "property-line",
      "flow-exit-arrow",
    ];
    const indices = order.map((kind) => kinds.indexOf(kind));
    for (const [i, idx] of indices.entries()) {
      expect(idx, `${order[i]} must be drawn on sheet 1`).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(idx, `${order[i]} must draw after ${order[i - 1]}`).toBeGreaterThan(indices[i - 1]!);
      }
    }
    // §5 legend names the gradient + backdrop honestly.
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain("Water gradient — modeled flow and ponding at 9.5\" storm");
    expect(decoded).toContain("Catchment boundary");
    expect(decoded).toContain("Aerial imagery — backdrop only, not a measurement source");
  });

  it("imagery unavailable: sheet still ships — gradient composites on the paper ground, honest note + legend row", async () => {
    const result = await emitPdfFloodDrainage(fullStudy(), descriptor, { aerial: aerialStubDown });
    expect(result.aerial.imageryEmbedded).toBe(false);
    expect(result.aerial.unavailableReason).toContain("unreachable");
    expect(result.gradientComposited).toBe(true);
    expect(result.pageCount).toBe(2);
    // No imagery mark; the gradient still draws.
    const kinds = new Set(result.marks.filter((m) => m.page === 1).map((m) => m.kind));
    expect(kinds.has("imagery")).toBe(false);
    expect(kinds.has("water-gradient")).toBe(true);
    expect(kinds.has("property-line")).toBe(true);
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain(AERIAL_UNAVAILABLE_NOTE);
    expect(decoded).toContain("Aerial imagery — unavailable · overlay on paper ground");
  });

  it("study without a gradient: honest legend row, nothing composited, never a fabricated raster", async () => {
    const study = fullStudy();
    delete study.gradient;
    const result = await emitPdfFloodDrainage(study, descriptor, { aerial: aerialStubOk });
    expect(result.gradientComposited).toBe(false);
    const kinds = new Set(result.marks.filter((m) => m.page === 1).map((m) => m.kind));
    expect(kinds.has("water-gradient")).toBe(false);
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain("Water gradient — not modeled");
  });

  it("keeps §11 prose hygiene on the briefing text: no colons, no machine identifiers", async () => {
    const study = fullStudy();
    expect(study.briefing).not.toContain(":");
    expect(study.briefing).not.toMatch(/[A-Za-z0-9]+[_/][A-Za-z0-9]+/);
    const result = await emitPdfFloodDrainage(study, descriptor, { aerial: aerialStubOk });
    const decoded = decodeAllContentStreams(result.bytes);
    // The machine geometry ref appears ONLY as a provenance SOURCE cell —
    // never inside the briefing paragraph (which is drawn verbatim).
    expect(decoded).toContain(study.briefing.slice(0, 40));
  });

  it("honest-empty still ships BOTH sheets: honest panel + UNAVAILABLE chips, never fabricated geometry", async () => {
    const result = await emitPdfFloodDrainage(emptyStudy(), {}, { aerial: aerialStubOk });
    expect(result.pageCount).toBe(2);
    expect(result.honestEmpty).toBe(true);
    expect(result.honestEmptyReason).toBe(HONEST_EMPTY_FLAT_TERRAIN);
    expect(result.gradientComposited).toBe(false);

    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain(FLOOD_DRAINAGE_EMPTY_TITLE);
    expect(decoded).toContain(HONEST_EMPTY_FLAT_TERRAIN);
    expect(decoded).toContain("UNAVAILABLE");
    // No address → parcel-id title + NO ADDRESS chip (§2, never a placeholder).
    expect(decoded).toContain("PARCEL 48021:47595");
    expect(decoded).toContain("NO ADDRESS");
    // No drainage geometry marks were drawn.
    const kinds = new Set(result.marks.map((m) => m.kind));
    expect(kinds.has("catchment-boundary")).toBe(false);
    expect(kinds.has("water-gradient")).toBe(false);
    expect(kinds.has("flow-line")).toBe(false);
    expect(kinds.has("property-line")).toBe(true);
    expect(kinds.has("honest-empty-callout")).toBe(true);
  });

  it("ponding modeled but NONE on the parcel: honest NONE MODELED headline + labeled qualifier only", async () => {
    const study = fullStudy({
      rainfallResultGeoJson: {
        type: "FeatureCollection",
        // All ponding is far-field — none intersects the ring.
        features: [quad(-97.324, 30.104, 0.001, { rainfallDepthMm: 241, onParcel: false })],
      },
    });
    study.stats = { ...study.stats, pondedAreaSqFt: 0, pondedAreaModeledRegionSqFt: 3_472_049 };
    study.briefing = buildFloodDrainageBriefing(study);
    const result = await emitPdfFloodDrainage(study, descriptor, { aerial: aerialStubOk });

    const decoded = decodeAllContentStreams(result.bytes);
    // §15-style honest headline — never the whole-region sum.
    expect(decoded).toContain("NONE MODELED");
    expect(decoded).not.toContain("3,472,049 SF");
    expect(decoded).toContain("None modeled");
    expect(decoded).toContain("no modeled ponding intersects the parcel");
    // The wider figure survives ONLY as the labeled qualifier.
    expect(decoded).toContain("wider modeled area 79.7 acres");
  });

  it("discloses the documented rainfall default in the fine print when the source is 'default'", async () => {
    const study = fullStudy({ rainfallSource: "default" });
    study.briefing = buildFloodDrainageBriefing(study);
    const result = await emitPdfFloodDrainage(study, descriptor, { aerial: aerialStubOk });
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain(FLOOD_DRAINAGE_DEFAULT_RAINFALL_NOTE);
    expect(decoded).toContain("documented regional default");
  });

  it("frame-clip (§3): every sheet-1 drawing mark bbox stays inside page1Frame", async () => {
    const result = await emitPdfFloodDrainage(fullStudy(), descriptor, { aerial: aerialStubOk });
    const drawingKinds = new Set([
      "imagery",
      "water-gradient",
      "catchment-boundary",
      "flow-line",
      "property-line",
      "flow-exit-arrow",
      "north-arrow",
      "honest-empty-callout",
    ]);
    const frame = result.page1Frame;
    const eps = 0.5;
    const drawingMarks = result.marks.filter((m) => m.page === 1 && drawingKinds.has(m.kind));
    expect(drawingMarks.length).toBeGreaterThan(3);
    for (const mark of drawingMarks) {
      expect(mark.bbox, `${mark.kind}:${mark.key} missing bbox`).toBeDefined();
      expect(mark.bbox!.minX).toBeGreaterThanOrEqual(frame.minX - eps);
      expect(mark.bbox!.maxX).toBeLessThanOrEqual(frame.maxX + eps);
      expect(mark.bbox!.minY).toBeGreaterThanOrEqual(frame.minY - eps);
      expect(mark.bbox!.maxY).toBeLessThanOrEqual(frame.maxY + eps);
    }
  });

  it("draw-once (§14): every keyed mark unique; furniture drawn exactly once per page", async () => {
    const result = await emitPdfFloodDrainage(fullStudy(), descriptor, { aerial: aerialStubOk });
    const ids = new Set(result.marks.map((m) => `${m.page}:${m.kind}:${m.key}`));
    expect(ids.size).toBe(result.marks.length);
    expect(result.marks.filter((m) => m.kind === "fine-print").length).toBe(2);
    expect(result.marks.filter((m) => m.kind === "north-arrow").length).toBe(1);
    expect(result.marks.filter((m) => m.kind === "legend").length).toBe(1);
    expect(result.marks.filter((m) => m.kind === "scale-bar").length).toBe(1);
    expect(result.marks.filter((m) => m.kind === "imagery").length).toBe(1);
    expect(result.marks.filter((m) => m.kind === "water-gradient").length).toBe(1);
  });

  it("keeps §21 vertical rhythm on every summary row (line-box invariants hold numerically)", async () => {
    const result = await emitPdfFloodDrainage(fullStudy(), descriptor, { aerial: aerialStubOk });
    expect(result.rhythm.length).toBeGreaterThan(6);
    for (const row of result.rhythm) {
      if (row.ruleY != null) {
        expect(Math.abs(row.ruleY - row.boxTopY - row.padTopPt)).toBeLessThan(1e-6);
      }
      expect(row.capTopY).toBeLessThan(row.boxTopY);
      expect(row.baselineY).toBeLessThan(row.capTopY);
      expect(row.bottomY).toBeLessThan(row.baselineY);
      expect(row.lines).toBeGreaterThanOrEqual(1);
    }
    expect(result.rhythm.some((r) => r.kind === "kv-row")).toBe(true);
    expect(result.rhythm.some((r) => r.kind === "briefing-text")).toBe(true);
    expect(result.rhythm.some((r) => r.kind === "provenance-row")).toBe(true);
  });

  it("never re-spells the disclaimer: one standing string on both sheets", async () => {
    const result = await emitPdfFloodDrainage(fullStudy(), descriptor, { aerial: aerialStubOk });
    const decoded = decodeAllContentStreams(result.bytes);
    const firstSentence = FLOOD_DRAINAGE_DISCLAIMER.split(".")[0]!;
    const occurrences = decoded.split(firstSentence).length - 1;
    // One standing spelling, present on each sheet's fine print (§8: never a
    // second spelling of the same disclosure).
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(result.marks.filter((m) => m.kind === "fine-print").length).toBe(2);
  });
});
