import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  PDFPage,
  clip,
  closePath,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFImage,
  type RGB,
} from "pdf-lib";

import type { GeoJsonFeatureCollection } from "@hauska-engine/adapters/hydrology";
import polygonClipping from "polygon-clipping";

import { gradientRampColor } from "../drainage-gradient.js";
import type { FloodDrainageStudy } from "../flood-drainage-study.js";
import {
  AERIAL_IMAGERY_ATTRIBUTION,
  AERIAL_UNAVAILABLE_NOTE,
  aerialImagePixelSize,
  aerialPagePointsPerGroundMeter,
  buildAerialExportUrl,
  computeMercatorBboxFromWgs84Ring,
  fetchAerialImagery,
  makeWgs84PageTransform,
  type AerialImageFetcher,
  type AerialImageryResult,
  type MercatorBbox,
  type PageRect,
} from "./aerial.js";
import { clipPolylineToAabb } from "./annotation-placement.js";
import {
  CHIP_UNAVAILABLE,
  countyDisplayName,
  formatAcresQualifier,
  formatScaleRatio,
  formatSqFt,
  formatSf,
  confidenceCell,
  CONFIDENCE,
} from "./format.js";
import {
  RhythmCapture,
  placeRowBelowRule,
  type RhythmRow,
} from "./line-box.js";
import { SITE_PLAN_HONESTY_LINE } from "./provenance.js";
import {
  LB,
  MARGIN_BOTTOM,
  MARGIN_TOP,
  MARGIN_X,
  MarkRegistry,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  cityFromAddress,
  drawChipOnLineBox,
  drawFinePrint,
  drawHairlineRule,
  drawHeaderStats,
  drawNorthArrow,
  drawPolyline,
  drawRing,
  drawSectionHeading,
  drawTrackedText,
  headerRuleY,
  loadFont,
  streetOnly,
  trackedWidth,
  wrapTextToWidth,
  type Fonts,
  type HeaderStat,
  type SheetMark,
  type MarkBbox,
} from "./render.js";
import { SETBACK_DASH, SPACE, STROKE, TOKENS, TRACKING, TYPE, pt } from "./template-tokens.js";

/**
 * FLOOD & DRAINAGE assembler (v2, 2026-07-29 — operator-directed redesign
 * of the FIRST paid report document). Sits beside dossier.ts on the SAME
 * binding SHEET_STANDARD (v1.3): tokens, Barlow faces, §21 line-box rhythm,
 * §6 chips, §12 number form, §11 prose hygiene, §8 fine print, §14
 * draw-once, §3 frame-clip. ONE document pattern — this reuses the dossier
 * scaffolding style, the render.ts sibling primitives, AND the aerial-page
 * machinery (§17–§20); it never invents a second visual system.
 *
 *   SHEET 1 · DRAWING (v2, imagery + water gradient) — composition order:
 *     1. Esri World Imagery backdrop (the SAME imagery the map uses),
 *        fetched through the aerial machinery (LOD floor, 3857 alignment);
 *        honest-unavailable → the paper ground, never a dropped sheet.
 *     2. The WATER GRADIENT raster composited over it (same bbox
 *        transform) — the study's transparent blue ramp of modeled flow +
 *        ponding, clipped to the drawing frame.
 *     3. Catchment boundary as a clean dashed overlay (union of the
 *        modeled cells), paper-haloed.
 *     4. Traced flow lines, bold water-blue with paper halos, with
 *        direction arrows along the paths.
 *     5. Parcel ring, paper-haloed, heaviest stroke on the sheet.
 *     6. PROMINENT flow-exit arrows at each traced exit.
 *     7. North arrow (halo disc), legend, ground-true scale bar, fine
 *        print with imagery attribution + backdrop-not-a-measurement
 *        language (§17–§19).
 *   SHEET 2 · SUMMARY — modeled results + rainfall forcing (source honestly
 *     labeled) + the layman briefing + a three-column provenance table +
 *     fine print with the not-an-engineering-study disclaimer.
 *
 * HONEST-EMPTY: a flat-terrain / DEM-void study still ships BOTH sheets —
 * the drawing carries the parcel ring over the backdrop and a centred
 * honest panel (aerial-page pattern), the summary carries UNAVAILABLE chips
 * with the reason. Nothing geometric is ever fabricated.
 */

export const FLOOD_DRAINAGE_TOTAL_SHEETS = 2;

export const FLOOD_DRAINAGE_KICKER = "FLOOD & DRAINAGE";
export const FLOOD_DRAINAGE_SUMMARY_KICKER = "FLOOD & DRAINAGE SUMMARY";

/** §8 disclaimer — screening-level model, never an engineering determination. */
export const FLOOD_DRAINAGE_DISCLAIMER =
  "Screening-level drainage model, not a drainage study or engineering determination. Verify drainage with a licensed engineer before design or permitting.";
export const FLOOD_DRAINAGE_MODEL_BASIS_LINE =
  "Drainage is computed by D8 flow accumulation over the public USGS 3DEP elevation model.";
export const FLOOD_DRAINAGE_DEFAULT_RAINFALL_NOTE =
  "Rainfall depth uses a documented regional default because a live NOAA estimate was unavailable on this run.";
export const FLOOD_DRAINAGE_EMPTY_TITLE = "NO DRAINAGE CONCENTRATION MODELED";
export const FLOOD_DRAINAGE_PONDING_NOT_MODELED_REASON =
  "Rainfall response was not modeled on this run.";
/** §17–§19: imagery + gradient are a backdrop, never a measurement source. */
export const FLOOD_DRAINAGE_BACKDROP_LINE =
  "Aerial imagery and the water gradient are a visual backdrop, not a measurement source; imagery capture date is not verified.";

export interface FloodDrainageDescriptor {
  address?: string;
  countyName?: string;
  /** Caller-forwarded deep link to the live Smart Site record (P-90 item 5).
   * Printed verbatim on sheet 1's footer when present; simply omitted (no
   * chip) when absent — an enhancement link, not a core fact class. */
  liveViewUrl?: string;
}

export interface EmitPdfFloodDrainageOptions {
  /** Test seam for a stable generated stamp. Defaults to now. */
  generatedAtIso?: string;
  /** Sheet-1 aerial imagery fetch seams — same as the site-plan export. */
  aerial?: {
    fetchImage?: AerialImageFetcher;
    timeoutMs?: number;
  };
}

export interface PdfFloodDrainageResult {
  bytes: Uint8Array;
  pageCount: number;
  honestEmpty: boolean;
  honestEmptyReason?: string;
  fontNote: string;
  marks: ReadonlyArray<SheetMark>;
  rhythm: ReadonlyArray<RhythmRow>;
  /** §3 sheet-1 drawing frame — every drawing mark bbox stays inside. */
  page1Frame: MarkBbox;
  /** §17 imagery outcome — embedded or the honest reason it was not. */
  aerial: { imageryEmbedded: boolean; sourceUrl: string; unavailableReason?: string };
  /** True when the study's water gradient composited onto sheet 1. */
  gradientComposited: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Colour roles — water-blue strokes inside the ONE accent family; the
// raster water ramp itself lives in drainage-gradient.ts (documented stops).
// ─────────────────────────────────────────────────────────────────────────
const INK = TOKENS.text;
const PAPER = TOKENS.neutral100;
const FLOW_LINE_COLOR = TOKENS.accent600;
const EXIT_ARROW_COLOR = TOKENS.accent800;
const CATCHMENT_BOUNDARY_COLOR = TOKENS.accent700;
const SUPPRESSED = TOKENS.neutral500;

/** Context pad around the parcel's mercator extent on sheet 1 — the
 * upstream catchment reads around the parcel without losing the parcel. */
export const FD_CONTEXT_PAD_FRACTION = 0.9;

/** Property-line stroke over imagery (heaviest on the sheet, §20-style). */
const FD_PROPERTY_STROKE = 1.8;

/** Paper halo width added behind rings/lines so they read over imagery. */
const FD_HALO_EXTRA = 1.8;

/** Flow-exit arrow geometry — sized to read at arm's length. */
const EXIT_ARROW_LEN = pt(34);
const EXIT_ARROW_HEAD = pt(11);
const EXIT_ARROW_STROKE = 2.2;

// ─────────────────────────────────────────────────────────────────────────
// Frame + footer geometry (§21): legend runs 3 rows per column (2 columns),
// scale bar right, fine print band below.
// ─────────────────────────────────────────────────────────────────────────
function finePrintBandTop(): number {
  return MARGIN_BOTTOM + LB.finePrint.lineBoxHeight * 4;
}

function page1FooterRuleYFd(): number {
  const legendBlock = pt(SPACE.s2) + 3 * LB.legend.lineBoxHeight + 2 * pt(SPACE.s2);
  return finePrintBandTop() + pt(SPACE.s3) + legendBlock;
}

function drawingFrame(): MarkBbox {
  return {
    minX: MARGIN_X,
    maxX: PAGE_WIDTH - MARGIN_X,
    minY: page1FooterRuleYFd() + pt(SPACE.s3),
    maxY: headerRuleY() - pt(SPACE.s3),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Projection (v2): WGS84 → EPSG:3857 → page, the SAME transform family the
// aerial page uses — imagery pixels, gradient raster, and vector overlay
// all share one linear mercator-bbox→rect mapping, so they register.
// Fit is PARCEL-PRIMARY: the ring's mercator extent plus the context pad
// governs scale; catchment context beyond the frame is clipped, never
// allowed to shrink the parcel to a dot.
// ─────────────────────────────────────────────────────────────────────────
type FdToPage = (lng: number, lat: number) => { x: number; y: number };

function frameRect(frame: MarkBbox): PageRect {
  return {
    x: frame.minX,
    y: frame.minY,
    width: frame.maxX - frame.minX,
    height: frame.maxY - frame.minY,
  };
}

function clampToFrame(p: { x: number; y: number }, frame: MarkBbox): { x: number; y: number } {
  return {
    x: Math.min(frame.maxX, Math.max(frame.minX, p.x)),
    y: Math.min(frame.maxY, Math.max(frame.minY, p.y)),
  };
}

function bboxOf(points: ReadonlyArray<{ x: number; y: number }>): MarkBbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// ─────────────────────────────────────────────────────────────────────────
// §20-style paper halos: paper-coloured underdraw behind rings/lines/text
// so vectors read over the imagery + gradient on any tone.
// ─────────────────────────────────────────────────────────────────────────
function drawHaloedRingFd(
  page: PDFPage,
  ring: Array<{ x: number; y: number }>,
  color: RGB,
  thickness: number,
  dashArray?: number[],
): void {
  drawRing(page, ring, PAPER, thickness + FD_HALO_EXTRA);
  drawRing(page, ring, color, thickness, dashArray);
}

function drawHaloedPolylineFd(
  page: PDFPage,
  points: Array<{ x: number; y: number }>,
  color: RGB,
  thickness: number,
  dashArray?: number[],
): void {
  drawPolyline(page, points, PAPER, thickness + FD_HALO_EXTRA);
  drawPolyline(page, points, color, thickness, dashArray);
}

/** Filled triangle arrowhead with a paper halo behind it. */
function drawHaloedArrowHead(
  page: PDFPage,
  tip: { x: number; y: number },
  ux: number,
  uy: number,
  headLen: number,
  color: RGB,
): void {
  const px = -uy;
  const py = ux;
  const draw = (len: number, fill: RGB, tipExtend: number): void => {
    const t = { x: tip.x + ux * tipExtend, y: tip.y + uy * tipExtend };
    const base = { x: t.x - ux * len, y: t.y - uy * len };
    const leftPt = { x: base.x + px * len * 0.45, y: base.y + py * len * 0.45 };
    const rightPt = { x: base.x - px * len * 0.45, y: base.y - py * len * 0.45 };
    const path =
      `M ${t.x.toFixed(2)} ${t.y.toFixed(2)} ` +
      `L ${leftPt.x.toFixed(2)} ${leftPt.y.toFixed(2)} ` +
      `L ${rightPt.x.toFixed(2)} ${rightPt.y.toFixed(2)} Z`;
    page.drawSvgPath(path, { color: fill, borderWidth: 0 });
  };
  draw(headLen + FD_HALO_EXTRA, PAPER, FD_HALO_EXTRA * 0.6);
  draw(headLen, color, 0);
}

/** Project a GeoJSON Polygon exterior ring, clamped to the frame. Returns
 * null when the polygon lies entirely outside the frame. */
function projectPolygon(
  toPage: FdToPage,
  frame: MarkBbox,
  coordinates: unknown,
): Array<{ x: number; y: number }> | null {
  const exterior = Array.isArray(coordinates) ? (coordinates as unknown[])[0] : null;
  if (!Array.isArray(exterior) || exterior.length < 3) return null;
  const projected = (exterior as Array<[number, number]>).map(([lng, lat]) => toPage(lng, lat));
  const inside = projected.some(
    (p) => p.x >= frame.minX && p.x <= frame.maxX && p.y >= frame.minY && p.y <= frame.maxY,
  );
  if (!inside) return null;
  return projected.map((p) => clampToFrame(p, frame));
}

/**
 * Union the modeled catchment geometry into its outline rings — the CLEAN
 * dashed catchment boundary. Exact boolean union via polygon-clipping (the
 * repo's standing polygon-ops dependency); a degenerate input yields no
 * boundary rather than a guessed one.
 *
 * HOLES (2026-07-30 overlay redesign). The catchment used to arrive as
 * hundreds of subsampled single-ring squares, so reading `coordinates[0]` and
 * discarding the rest lost nothing. The dissolved converters now emit traced
 * regions WITH INTERIOR RINGS where the mask has holes, and silently dropping
 * them would draw a boundary around area the model says is NOT in the
 * catchment. Every ring is therefore passed to the union, which resolves
 * interiors correctly and returns them as their own outline rings to stroke.
 */
export function catchmentBoundaryRings(
  catchment: GeoJsonFeatureCollection,
): Array<Array<[number, number]>> {
  const polys: Array<[number, number][][]> = [];
  for (const feature of catchment.features) {
    if (feature.geometry.type !== "Polygon") continue;
    const rings = (feature.geometry.coordinates as [number, number][][])
      .filter((ring) => Array.isArray(ring) && ring.length >= 3)
      .map((ring) => ring.map((p) => [p[0], p[1]] as [number, number]));
    if (rings.length === 0) continue;
    polys.push(rings);
  }
  if (polys.length === 0) return [];
  try {
    const unioned = polygonClipping.union(polys[0]!, ...polys.slice(1));
    const rings: Array<Array<[number, number]>> = [];
    for (const poly of unioned) {
      for (const ring of poly) {
        if (ring.length >= 3) rings.push(ring.map((p) => [p[0], p[1]] as [number, number]));
      }
    }
    return rings;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Header (§2, dossier-style: request/study-carried descriptors only).
// ─────────────────────────────────────────────────────────────────────────
function drawFdHeader(
  page: PDFPage,
  study: FloodDrainageStudy,
  descriptor: FloodDrainageDescriptor,
  F: Fonts,
  eyebrow: string,
  stats: HeaderStat[] | null,
  rightMeta: string[] | null,
): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const top = PAGE_HEIGHT - MARGIN_TOP;

  drawTrackedText(page, eyebrow, {
    x: left,
    y: top - LB.eyebrow.baselineFromBoxTop,
    size: TYPE.eyebrow,
    font: F.display,
    color: TOKENS.accent,
    trackingEm: TRACKING.eyebrow,
  });

  const titleBoxTop = top - LB.eyebrow.lineBoxHeight - pt(2);
  const street = streetOnly(descriptor.address);
  const big = (street ?? `PARCEL ${study.parcelNodeId}`).toUpperCase();
  page.drawText(big, {
    x: left,
    y: titleBoxTop - LB.address.baselineFromBoxTop,
    size: TYPE.address,
    font: F.display,
    color: INK,
  });
  if (!street) {
    const bigW = F.display.widthOfTextAtSize(big, TYPE.address);
    drawChipOnLineBox(page, "NO ADDRESS", left + bigW + pt(10), titleBoxTop, LB.address, "solid", F);
  }

  const metaBoxTop = titleBoxTop - LB.address.lineBoxHeight - pt(2);
  const metaParts = [
    cityFromAddress(descriptor.address),
    `Parcel ${study.parcelNodeId}`,
    countyDisplayName(descriptor.countyName),
  ].filter((p): p is string => !!p);
  page.drawText(metaParts.join("  ·  "), {
    x: left,
    y: metaBoxTop - LB.subline.baselineFromBoxTop,
    size: TYPE.subline,
    font: F.body,
    color: TOKENS.neutral700,
  });

  if (stats) drawHeaderStats(page, stats, right, top - pt(6), F);
  if (rightMeta) {
    const metaTop = top - pt(6);
    rightMeta.forEach((line, i) => {
      page.drawText(line, {
        x: right - F.body.widthOfTextAtSize(line, TYPE.sheetMeta),
        y: metaTop - i * LB.sheetMeta.lineBoxHeight - LB.sheetMeta.baselineFromBoxTop,
        size: TYPE.sheetMeta,
        font: F.body,
        color: TOKENS.neutral600,
      });
    });
  }

  const ruleY = headerRuleY();
  drawHairlineRule(page, left, ruleY, right - left);
  return ruleY;
}

function catchmentStatValue(study: FloodDrainageStudy): string {
  const sqFt = study.stats.catchmentAreaSqFt;
  if (sqFt >= 43_560) return `${(sqFt / 43_560).toFixed(1)} AC`;
  return formatSf(sqFt);
}

function headerStats(study: FloodDrainageStudy): HeaderStat[] {
  if (study.honestEmpty) {
    return [
      { label: "CATCHMENT", chip: CHIP_UNAVAILABLE },
      { label: "PONDING", chip: CHIP_UNAVAILABLE },
      { label: "FLOW EXITS", chip: CHIP_UNAVAILABLE },
    ];
  }
  // PONDING headline = the PARCEL-CLIPPED area only (2026-07-29 canary
  // fix — the whole-region sum printed 3.4M SF on a 0.19-acre parcel).
  // 0 takes the §15-style NONE MODELED treatment (suppressed, honest);
  // null (not computed) takes the UNAVAILABLE chip.
  const ponding: HeaderStat =
    study.stats.pondedAreaSqFt == null
      ? { label: `PONDING AT ${study.rainfallDepthInches}"`, chip: CHIP_UNAVAILABLE }
      : study.stats.pondedAreaSqFt > 0
        ? {
            label: `PONDING AT ${study.rainfallDepthInches}"`,
            value: formatSf(study.stats.pondedAreaSqFt),
          }
        : {
            label: `PONDING AT ${study.rainfallDepthInches}"`,
            value: "NONE MODELED",
            color: SUPPRESSED,
          };
  return [
    { label: "CATCHMENT", value: catchmentStatValue(study), color: TOKENS.accent700 },
    ponding,
    { label: "FLOW EXITS", value: String(study.stats.flowExitCount) },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// Sheet-1 drawing (v2): imagery backdrop → water gradient → catchment
// boundary → flow lines → parcel ring → exit arrows → furniture.
// ─────────────────────────────────────────────────────────────────────────
interface FdSheet1Layers {
  imagery: AerialImageryResult;
  imageryPng: PDFImage | undefined;
  gradientPng: PDFImage | undefined;
}

function drawStudyDrawing(
  page: PDFPage,
  study: FloodDrainageStudy,
  F: Fonts,
  frame: MarkBbox,
  marks: MarkRegistry,
  toPage: FdToPage,
  layers: FdSheet1Layers,
): void {
  const rect = frameRect(frame);

  // 1) BACKDROP — the SAME Esri World Imagery the map uses; honest paper
  // ground when the fetch failed (§17: never a dropped sheet).
  if (layers.imagery.ok && layers.imageryPng) {
    if (marks.once(1, "imagery", "raster", frame)) {
      page.drawImage(layers.imageryPng, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    }
  } else {
    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      color: PAPER,
      borderColor: TOKENS.neutral300,
      borderWidth: 0.7,
    });
  }

  // 2) THE WATER GRADIENT — composited over the backdrop by the SAME bbox
  // transform (gradient bbox corners → mercator → page), clipped hard to
  // the drawing frame (§3). The raster's row-0 edge is its bbox's north.
  if (layers.gradientPng && study.gradient) {
    const sw = toPage(study.gradient.bbox.westLng, study.gradient.bbox.southLat);
    const ne = toPage(study.gradient.bbox.eastLng, study.gradient.bbox.northLat);
    if (marks.once(1, "water-gradient", "raster", frame)) {
      page.pushOperators(
        pushGraphicsState(),
        moveTo(frame.minX, frame.minY),
        lineTo(frame.maxX, frame.minY),
        lineTo(frame.maxX, frame.maxY),
        lineTo(frame.minX, frame.maxY),
        closePath(),
        clip(),
        endPath(),
      );
      page.drawImage(layers.gradientPng, {
        x: sw.x,
        y: sw.y,
        width: ne.x - sw.x,
        height: ne.y - sw.y,
      });
      page.pushOperators(popGraphicsState());
    }
  }

  if (!study.honestEmpty) {
    // 3) CATCHMENT BOUNDARY — clean dashed outline of the modeled cells'
    // union, paper-haloed so it reads over imagery.
    {
      const drawn: Array<{ x: number; y: number }> = [];
      catchmentBoundaryRings(study.catchmentGeoJson).forEach((ring) => {
        const closed = [...ring, ring[0]!];
        const projected = closed.map(([lng, lat]) => {
          const p = toPage(lng, lat);
          return [p.x, p.y] as [number, number];
        });
        for (const part of clipPolylineToAabb(projected, frame)) {
          const line = part.map(([x, y]) => ({ x, y }));
          if (line.length < 2) continue;
          drawHaloedPolylineFd(page, line, CATCHMENT_BOUNDARY_COLOR, 0.9, SETBACK_DASH);
          drawn.push(...line);
        }
      });
      if (drawn.length > 0) marks.once(1, "catchment-boundary", "outline", bboxOf(drawn));
    }

    // 4) FLOW LINES — bold water-blue with paper halos, clipped hard to the
    // frame (§3), with a direction arrow along each path.
    study.flowLinesGeoJson.features.forEach((feature, i) => {
      if (feature.geometry.type !== "LineString") return;
      const projected = (feature.geometry.coordinates as Array<[number, number]>).map(
        ([lng, lat]) => {
          const p = toPage(lng, lat);
          return [p.x, p.y] as [number, number];
        },
      );
      const clips = clipPolylineToAabb(projected, frame);
      const pts: Array<{ x: number; y: number }> = [];
      for (const part of clips) {
        const line = part.map(([x, y]) => ({ x, y }));
        if (line.length < 2) continue;
        drawHaloedPolylineFd(page, line, FLOW_LINE_COLOR, 1.6);
        pts.push(...line);
        // Direction arrow ~60% along the clipped part, inset from the frame.
        const k = Math.max(1, Math.floor(line.length * 0.6));
        const a = line[k - 1]!;
        const b = line[Math.min(k, line.length - 1)]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-6) {
          const ux = dx / len;
          const uy = dy / len;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (
            mid.x > frame.minX + pt(10) &&
            mid.x < frame.maxX - pt(10) &&
            mid.y > frame.minY + pt(10) &&
            mid.y < frame.maxY - pt(10)
          ) {
            drawHaloedArrowHead(page, mid, ux, uy, pt(7), FLOW_LINE_COLOR);
          }
        }
      }
      if (pts.length > 0) marks.once(1, "flow-line", String(i), bboxOf(pts));
    });
  }

  // 5) PROPERTY LINE — heaviest stroke on the sheet, paper-haloed, always
  // drawn (§3/§20).
  const ringPage = study.parcelRingWgs84.map(([lng, lat]) =>
    clampToFrame(toPage(lng, lat), frame),
  );
  if (marks.once(1, "property-line", "ring", bboxOf(ringPage))) {
    drawHaloedRingFd(page, ringPage, INK, FD_PROPERTY_STROKE);
  }

  // 6) FLOW EXIT ARROWS — PROMINENT, water-blue with paper halos, outbound
  // bearing at each traced exit (§14 keyed), sized to read at arm's length.
  if (!study.honestEmpty) {
    study.flowExits.forEach((exit, i) => {
      const at = toPage(exit.lng, exit.lat);
      const rad = (exit.bearingDeg * Math.PI) / 180;
      const ux = Math.sin(rad);
      const uy = Math.cos(rad);
      const tip = { x: at.x + ux * EXIT_ARROW_LEN, y: at.y + uy * EXIT_ARROW_LEN };
      const inset = pt(8);
      const insideFrame = (p: { x: number; y: number }): boolean =>
        p.x > frame.minX + inset &&
        p.x < frame.maxX - inset &&
        p.y > frame.minY + inset &&
        p.y < frame.maxY - inset;
      if (!insideFrame(at) || !insideFrame(tip)) {
        return; // an arrow that would cross the frame is dropped, not clipped ugly
      }
      const shaftEnd = {
        x: tip.x - ux * EXIT_ARROW_HEAD,
        y: tip.y - uy * EXIT_ARROW_HEAD,
      };
      const px = -uy;
      const py = ux;
      const headHalf = EXIT_ARROW_HEAD * 0.45;
      const headBboxPts = [
        at,
        tip,
        { x: shaftEnd.x + px * headHalf, y: shaftEnd.y + py * headHalf },
        { x: shaftEnd.x - px * headHalf, y: shaftEnd.y - py * headHalf },
      ];
      if (!marks.once(1, "flow-exit-arrow", String(i), bboxOf(headBboxPts))) return;
      page.drawLine({
        start: at,
        end: shaftEnd,
        thickness: EXIT_ARROW_STROKE + FD_HALO_EXTRA,
        color: PAPER,
      });
      page.drawLine({ start: at, end: shaftEnd, thickness: EXIT_ARROW_STROKE, color: EXIT_ARROW_COLOR });
      drawHaloedArrowHead(page, tip, ux, uy, EXIT_ARROW_HEAD, EXIT_ARROW_COLOR);
    });
  }

  // 7) HONEST PANEL (aerial-page pattern): centred title + ONE sentence on
  // a translucent paper panel so it reads over the backdrop.
  if (study.honestEmpty) {
    const cx = (frame.minX + frame.maxX) / 2;
    const cy = (frame.minY + frame.maxY) / 2 + pt(60);
    const titleSize = pt(16);
    const sentenceSize = pt(11);
    const w = Math.max(
      F.display.widthOfTextAtSize(FLOOD_DRAINAGE_EMPTY_TITLE, titleSize),
      F.body.widthOfTextAtSize(study.honestEmpty.reason, sentenceSize),
    );
    if (
      marks.once(1, "honest-empty-callout", "callout", {
        minX: cx - w / 2,
        maxX: cx + w / 2,
        minY: cy - titleSize - pt(4) - sentenceSize,
        maxY: cy + titleSize,
      })
    ) {
      page.drawRectangle({
        x: cx - w / 2 - pt(14),
        y: cy - titleSize - pt(4) - sentenceSize - pt(10),
        width: w + pt(28),
        height: titleSize * 2 + sentenceSize + pt(22),
        color: PAPER,
        opacity: 0.88,
      });
      page.drawText(FLOOD_DRAINAGE_EMPTY_TITLE, {
        x: cx - F.display.widthOfTextAtSize(FLOOD_DRAINAGE_EMPTY_TITLE, titleSize) / 2,
        y: cy,
        size: titleSize,
        font: F.display,
        color: INK,
      });
      page.drawText(study.honestEmpty.reason, {
        x: cx - F.body.widthOfTextAtSize(study.honestEmpty.reason, sentenceSize) / 2,
        y: cy - titleSize - pt(4),
        size: sentenceSize,
        font: F.body,
        color: TOKENS.neutral600,
      });
    }
  }

  // 8) FRAME — a quiet border keeps the imagery composition bound (§3).
  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    borderColor: TOKENS.neutral300,
    borderWidth: 0.7,
    color: undefined,
  });

  // 9) NORTH ARROW — exactly one, top-right inside the frame (§9/§14),
  // halo disc behind it so it reads over any imagery tone.
  {
    const x = frame.maxX - pt(22);
    const origin = { x, y: frame.maxY - pt(52) };
    const tip = { x, y: frame.maxY - pt(24) };
    if (
      marks.once(1, "north-arrow", "north", {
        minX: x - pt(8),
        maxX: x + pt(8),
        minY: origin.y - pt(2),
        maxY: tip.y + pt(6) + pt(11),
      })
    ) {
      page.drawCircle({
        x,
        y: (origin.y + tip.y) / 2 + pt(2),
        size: pt(22),
        color: PAPER,
        opacity: 0.55,
      });
      drawNorthArrow(page, { origin, tip }, F.display);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Sheet-1 footer: legend (fixed §5 order, empty rows grey with the reason
// inline) + scale bar + fine print.
// ─────────────────────────────────────────────────────────────────────────
interface FdLegendRow {
  label: string;
  swatch: "line-heavy" | "gradient" | "line-dashed" | "line-solid" | "arrow" | "imagery";
  color: RGB;
  empty?: boolean;
}

function fdLegendRows(
  study: FloodDrainageStudy,
  imagery: AerialImageryResult,
  gradientComposited: boolean,
): FdLegendRow[] {
  const empty = !!study.honestEmpty;
  // §5: an empty layer stays LISTED, greys to neutral-500, and carries its
  // reason INLINE on the same row — a populated-looking legend row over a
  // layer that drew nothing (the 2026-07-29 canary smoke) is a defect.
  return [
    { label: "Property line", swatch: "line-heavy", color: INK },
    {
      label: gradientComposited
        ? `Water gradient — modeled flow and ponding at ${study.rainfallDepthInches}" storm`
        : "Water gradient — not modeled",
      swatch: "gradient",
      color: FLOW_LINE_COLOR,
      empty: !gradientComposited,
    },
    {
      label: empty ? "Catchment boundary — none modeled" : "Catchment boundary",
      swatch: "line-dashed",
      color: CATCHMENT_BOUNDARY_COLOR,
      empty,
    },
    {
      label: empty ? "Flow lines — none traced" : "Traced flow line",
      swatch: "line-solid",
      color: FLOW_LINE_COLOR,
      empty,
    },
    {
      label:
        empty || study.stats.flowExitCount === 0 ? "Flow exit — none traced" : "Flow exit",
      swatch: "arrow",
      color: EXIT_ARROW_COLOR,
      empty: empty || study.stats.flowExitCount === 0,
    },
    imagery.ok
      ? {
          label: "Aerial imagery — backdrop only, not a measurement source",
          swatch: "imagery",
          color: SUPPRESSED,
          empty: true,
        }
      : {
          label: "Aerial imagery — unavailable · overlay on paper ground",
          swatch: "imagery",
          color: SUPPRESSED,
          empty: true,
        },
  ];
}

function drawFdLegendSwatch(page: PDFPage, row: FdLegendRow, x: number, y: number): void {
  const w = pt(24);
  const midY = y + pt(3);
  if (row.swatch === "line-heavy") {
    page.drawLine({ start: { x, y: midY }, end: { x: x + w, y: midY }, thickness: STROKE.property, color: row.color });
  } else if (row.swatch === "gradient") {
    // Three steps of THE water ramp (drainage-gradient.ts documented stops).
    const steps = [0.25, 0.6, 0.95];
    const stepW = w / steps.length;
    steps.forEach((t, i) => {
      const c = gradientRampColor(t);
      page.drawRectangle({
        x: x + i * stepW,
        y: y - pt(1),
        width: stepW,
        height: pt(8),
        color: rgb(c.r / 255, c.g / 255, c.b / 255),
        opacity: row.empty ? 0.35 : Math.max(0.25, c.a),
        borderWidth: 0,
      });
    });
    page.drawRectangle({
      x,
      y: y - pt(1),
      width: w,
      height: pt(8),
      borderColor: row.empty ? SUPPRESSED : TOKENS.accent400,
      borderWidth: 0.5,
      color: undefined,
    });
  } else if (row.swatch === "imagery") {
    page.drawRectangle({
      x,
      y: y - pt(1),
      width: w,
      height: pt(8),
      color: TOKENS.accent200,
      borderColor: TOKENS.neutral300,
      borderWidth: 0.5,
    });
  } else if (row.swatch === "line-dashed") {
    page.drawLine({
      start: { x, y: midY },
      end: { x: x + w, y: midY },
      thickness: 0.9,
      color: row.color,
      dashArray: SETBACK_DASH,
    });
  } else if (row.swatch === "line-solid") {
    page.drawLine({ start: { x, y: midY }, end: { x: x + w, y: midY }, thickness: 1.6, color: row.color });
  } else {
    page.drawLine({ start: { x, y: midY }, end: { x: x + w - pt(6), y: midY }, thickness: 1.1, color: row.color });
    const path =
      `M ${(x + w).toFixed(2)} ${midY.toFixed(2)} ` +
      `L ${(x + w - pt(6)).toFixed(2)} ${(midY + pt(2.6)).toFixed(2)} ` +
      `L ${(x + w - pt(6)).toFixed(2)} ${(midY - pt(2.6)).toFixed(2)} Z`;
    page.drawSvgPath(path, { color: row.color, borderWidth: 0 });
  }
}

function drawFdFooter(
  page: PDFPage,
  study: FloodDrainageStudy,
  ptsPerMeter: number,
  F: Fonts,
  marks: MarkRegistry,
  rhythm: RhythmCapture,
  generatedAtIso: string,
  imagery: AerialImageryResult,
  gradientComposited: boolean,
  liveViewUrl?: string,
): void {
  const ruleY = page1FooterRuleYFd();
  drawHairlineRule(page, MARGIN_X, ruleY, PAGE_WIDTH - MARGIN_X * 2, TOKENS.neutral300, 0.7);

  // Legend — column-major, 3 rows per column (§5 fixed order).
  if (marks.once(1, "legend", "legend")) {
    const rows = fdLegendRows(study, imagery, gradientComposited);
    const size = TYPE.legend;
    const pitch = LB.legend.lineBoxHeight + pt(SPACE.s2);
    const perCol = 3;
    const swatchBand = pt(24) + pt(9);
    const col1Width =
      Math.max(...rows.slice(0, perCol).map((r) => F.body.widthOfTextAtSize(r.label, size))) +
      swatchBand;
    rows.forEach((row, i) => {
      const col = Math.floor(i / perCol);
      const line = i % perCol;
      const x = col === 0 ? MARGIN_X : MARGIN_X + col1Width + pt(18);
      const boxTop = ruleY - pt(SPACE.s2) - line * pitch;
      const y = boxTop - LB.legend.baselineFromBoxTop;
      drawFdLegendSwatch(page, row, x, y);
      page.drawText(row.label, {
        x: x + swatchBand,
        y,
        size,
        font: F.body,
        color: row.empty ? SUPPRESSED : TOKENS.neutral800,
      });
      if (col === 0) {
        const placed = placeRowBelowRule(ruleY - line * pitch, LB.legend, {
          padTop: pt(SPACE.s2),
          padBottom: pt(SPACE.s2),
        });
        rhythm.row(1, "legend-row", placed, LB.legend, pt(SPACE.s2), { ruleDrawn: line === 0 });
      }
    });
  }

  // Scale bar (§9): three segments, unit on the LAST label only. Ground-
  // true through the mercator transform (mercator-plane inflation divided
  // back out by aerialPagePointsPerGroundMeter upstream).
  if (marks.once(1, "scale-bar", "scale")) {
    const right = PAGE_WIDTH - MARGIN_X;
    const barWidth = pt(120);
    const ptPerFoot = ptsPerMeter * 0.3048;
    const lengthFeet = ptPerFoot > 0 ? barWidth / ptPerFoot : 0;
    const barTop = ruleY - pt(8);
    const blockW = barWidth / 3;
    const blockColors = [INK, TOKENS.neutral300, INK];
    for (let i = 0; i < 3; i++) {
      page.drawRectangle({
        x: right - barWidth + i * blockW,
        y: barTop,
        width: blockW,
        height: pt(5),
        color: blockColors[i]!,
        borderWidth: 0,
      });
    }
    const labelSize = TYPE.scaleBarLabel;
    const labelY = barTop - pt(11);
    page.drawText("0", { x: right - barWidth, y: labelY, size: labelSize, font: F.body, color: TOKENS.neutral700 });
    const midLabel = `${Math.round(lengthFeet / 2)}`;
    page.drawText(midLabel, {
      x: right - barWidth / 2 - F.body.widthOfTextAtSize(midLabel, labelSize) / 2,
      y: labelY,
      size: labelSize,
      font: F.body,
      color: TOKENS.neutral700,
    });
    const maxLabel = `${Math.round(lengthFeet)} ft`;
    page.drawText(maxLabel, {
      x: right - F.body.widthOfTextAtSize(maxLabel, labelSize),
      y: labelY,
      size: labelSize,
      font: F.body,
      color: TOKENS.neutral700,
    });
    const scaleRatio = ptPerFoot > 0 ? formatScaleRatio(Math.round(72 / ptPerFoot)) : "";
    const docId = `FD-${study.parcelNodeId.replace(/:/g, "-")}`;
    const stamp = `generated ${generatedAtIso.slice(0, 16).replace("T", " ")}Z`;
    const metaLine = [scaleRatio, docId, stamp].filter(Boolean).join(" · ");
    page.drawText(metaLine, {
      x: right - F.body.widthOfTextAtSize(metaLine, TYPE.scaleRatioLine),
      y: labelY - pt(13),
      size: TYPE.scaleRatioLine,
      font: F.body,
      color: TOKENS.neutral600,
    });
    // Live-view deep link (P-90 item 5) — same baseline, left-aligned,
    // printed only when the caller forwarded one.
    if (liveViewUrl) {
      page.drawText(liveViewUrl, {
        x: MARGIN_X,
        y: labelY - pt(13),
        size: TYPE.scaleRatioLine,
        font: F.body,
        color: TOKENS.neutral600,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Sheet-2 summary rows.
// ─────────────────────────────────────────────────────────────────────────
const LABEL_COL = pt(200);

function drawFdKvRow(
  page: PDFPage,
  pageNo: number,
  row: { label: string; value?: string; chip?: boolean; grey?: string; accentValue?: boolean },
  ruleY: number,
  F: Fonts,
  rhythm: RhythmCapture,
): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const valueX = left + LABEL_COL;
  let vx = valueX;
  if (row.chip) {
    vx += trackedWidth(F.displayMedium, CHIP_UNAVAILABLE, TYPE.chip, TRACKING.chip) + pt(14) + pt(8);
  }
  if (row.value) vx += F.body.widthOfTextAtSize(row.value, TYPE.rowValue) + pt(8);
  const greySize = row.chip ? pt(12) : TYPE.rowQualifier;
  const greyLines = row.grey
    ? wrapTextToWidth(row.grey, F.body, greySize, Math.max(right - vx, pt(120)))
    : [];
  const lines = Math.max(1, greyLines.length);
  const placed = placeRowBelowRule(ruleY, LB.kvRow, { padTop: pt(SPACE.s2), padBottom: pt(SPACE.s2), lines });
  page.drawLine({ start: { x: left, y: ruleY }, end: { x: right, y: ruleY }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
  page.drawText(row.label, { x: left, y: placed.baselines[0]!, size: TYPE.rowLabel, font: F.body, color: TOKENS.neutral600 });
  let dx = valueX;
  if (row.chip) {
    dx = drawChipOnLineBox(page, CHIP_UNAVAILABLE, dx, placed.boxTopY, LB.kvRow, "solid", F) + pt(8);
  }
  if (row.value) {
    page.drawText(row.value, {
      x: dx,
      y: placed.baselines[0]!,
      size: TYPE.rowValue,
      font: F.body,
      color: row.accentValue ? TOKENS.accent700 : INK,
    });
    dx += F.body.widthOfTextAtSize(row.value, TYPE.rowValue) + pt(8);
  }
  greyLines.forEach((line, li) => {
    page.drawText(line, {
      x: li === 0 ? dx : valueX,
      y: placed.baselines[li]!,
      size: greySize,
      font: F.body,
      color: row.chip ? TOKENS.neutral700 : TOKENS.neutral600,
    });
  });
  rhythm.row(pageNo, "kv-row", placed, LB.kvRow, pt(SPACE.s2));
  return placed.nextRuleY;
}

interface FdProvenanceRow {
  layer: string;
  source: string;
  confidence: string;
}

function fdProvenanceRows(study: FloodDrainageStudy): FdProvenanceRow[] {
  const rainfallConfidence =
    study.rainfallSource === "noaa-atlas14"
      ? CONFIDENCE.asserted
      : study.rainfallSource === "parameter"
        ? confidenceCell(CONFIDENCE.asserted, "caller parameter")
        : confidenceCell(CONFIDENCE.asserted, "regional default");
  const rainfallSourceCell =
    study.rainfallSource === "noaa-atlas14"
      ? "NOAA Atlas 14 PFDS point estimate (100-yr 24-hr)"
      : study.rainfallSource === "parameter"
        ? "request parameter"
        : "NOAA Atlas 14 Volume 11 (Texas) regional default";
  return [
    {
      layer: "Terrain / elevation",
      source: `USGS 3DEP DEM · ${study.demProvenance.resolutionMeters} m per pixel`,
      confidence: CONFIDENCE.asserted,
    },
    {
      layer: "Rainfall forcing",
      source: rainfallSourceCell,
      confidence: rainfallConfidence,
    },
    study.honestEmpty
      ? {
          layer: "Drainage computation",
          source: "unavailable",
          confidence: CONFIDENCE.honestUnavailable,
        }
      : {
          layer: "Drainage computation",
          source: `D8 flow accumulation · ${study.computation.library}`,
          confidence: confidenceCell(CONFIDENCE.asserted, "screening model"),
        },
    ...(study.gradient
      ? [
          {
            layer: "Water gradient",
            source: "derived raster · D8 flow accumulation + modeled ponding",
            confidence: confidenceCell(CONFIDENCE.asserted, "visual aid"),
          },
        ]
      : []),
    {
      layer: "Parcel geometry",
      source: study.geometrySourceRef,
      confidence: confidenceCell(CONFIDENCE.asserted, "GIS-approx"),
    },
  ];
}

function drawFdProvenanceTable(
  page: PDFPage,
  pageNo: number,
  rows: FdProvenanceRow[],
  ruleY: number,
  F: Fonts,
  rhythm: RhythmCapture,
): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const layerCol = left;
  const sourceCol = left + pt(150);
  const confidenceCol = right - pt(150);

  // Header row (tracked condensed caps).
  const head = placeRowBelowRule(ruleY, LB.tableHead, { padTop: pt(SPACE.s2), padBottom: pt(SPACE.s1) });
  page.drawLine({ start: { x: left, y: ruleY }, end: { x: right, y: ruleY }, thickness: STROKE.rowRule, color: TOKENS.neutral300 });
  const drawHead = (text: string, x: number) =>
    drawTrackedText(page, text, {
      x,
      y: head.baselines[0]!,
      size: TYPE.tableHead,
      font: F.displayMedium,
      color: TOKENS.neutral600,
      trackingEm: TRACKING.tableHead,
    });
  drawHead("LAYER", layerCol);
  drawHead("SOURCE", sourceCol);
  drawHead("CONFIDENCE", confidenceCol);
  rhythm.row(pageNo, "provenance-head", head, LB.tableHead, pt(SPACE.s2));
  let cursor = head.nextRuleY;

  for (const row of rows) {
    const sourceLines = wrapTextToWidth(row.source, F.body, TYPE.tableCell, confidenceCol - sourceCol - pt(12));
    const lines = Math.max(1, sourceLines.length);
    const placed = placeRowBelowRule(cursor, LB.tableRow, { padTop: pt(SPACE.s1), padBottom: pt(SPACE.s1), lines });
    page.drawLine({ start: { x: left, y: cursor }, end: { x: right, y: cursor }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
    page.drawText(row.layer, { x: layerCol, y: placed.baselines[0]!, size: TYPE.tableCell, font: F.body, color: INK });
    sourceLines.forEach((line, li) => {
      page.drawText(line, { x: sourceCol, y: placed.baselines[li]!, size: TYPE.tableCell, font: F.body, color: TOKENS.neutral700 });
    });
    page.drawText(row.confidence, { x: confidenceCol, y: placed.baselines[0]!, size: TYPE.tableCell, font: F.body, color: TOKENS.neutral700 });
    rhythm.row(pageNo, "provenance-row", placed, LB.tableRow, pt(SPACE.s1));
    cursor = placed.nextRuleY;
  }
  page.drawLine({ start: { x: left, y: cursor }, end: { x: right, y: cursor }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
  return cursor;
}

// ─────────────────────────────────────────────────────────────────────────
// Fine print (§8 family).
// ─────────────────────────────────────────────────────────────────────────
function fdFinePrint(
  study: FloodDrainageStudy,
  sheetNo: number,
  imagery?: AerialImageryResult | null,
): string {
  const sentences: string[] = [
    FLOOD_DRAINAGE_DISCLAIMER,
    FLOOD_DRAINAGE_MODEL_BASIS_LINE,
    SITE_PLAN_HONESTY_LINE,
  ];
  if (sheetNo === 1 && imagery) {
    // §17–§19: backdrop language + verbatim provider attribution; the
    // honest unavailable note when the fetch failed (gradient still ships
    // on the paper ground).
    sentences.push(FLOOD_DRAINAGE_BACKDROP_LINE);
    if (imagery.ok) {
      sentences.push(AERIAL_IMAGERY_ATTRIBUTION);
    } else {
      sentences.push(
        `${AERIAL_UNAVAILABLE_NOTE}: ${imagery.reason}. The drawing renders on the paper ground.`,
      );
    }
  }
  if (study.rainfallSource === "default") {
    sentences.push(FLOOD_DRAINAGE_DEFAULT_RAINFALL_NOTE);
  }
  if (study.honestEmpty) {
    sentences.push(study.honestEmpty.reason);
  }
  sentences.push(`· Sheet ${sheetNo} of ${FLOOD_DRAINAGE_TOTAL_SHEETS}`);
  return sentences.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────
// The assembler.
// ─────────────────────────────────────────────────────────────────────────
export async function emitPdfFloodDrainage(
  study: FloodDrainageStudy,
  descriptor: FloodDrainageDescriptor = {},
  options: EmitPdfFloodDrainageOptions = {},
): Promise<PdfFloodDrainageResult> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const F: Fonts = {
    body: await doc.embedFont(loadFont("Barlow-Regular.ttf"), { subset: false }),
    bodyMedium: await doc.embedFont(loadFont("Barlow-Medium.ttf"), { subset: false }),
    display: await doc.embedFont(loadFont("BarlowCondensed-SemiBold.ttf"), { subset: false }),
    displayMedium: await doc.embedFont(loadFont("BarlowCondensed-Medium.ttf"), { subset: false }),
  };

  const marks = new MarkRegistry();
  const rhythm = new RhythmCapture();
  const generatedAt = options.generatedAtIso ?? new Date().toISOString();
  const frame = drawingFrame();
  const rect = frameRect(frame);
  const docId = `FD-${study.parcelNodeId.replace(/:/g, "-")}`;

  // Sheet-1 imagery fetch — started FIRST (aerial-page pattern) so the
  // bounded network wait overlaps the vector work; bounded and never
  // throwing, so a dead endpoint degrades to the honest paper ground.
  const mercBbox: MercatorBbox = computeMercatorBboxFromWgs84Ring(
    study.parcelRingWgs84,
    rect.width / rect.height,
    FD_CONTEXT_PAD_FRACTION,
  );
  const aerialUrl = buildAerialExportUrl(mercBbox, aerialImagePixelSize(mercBbox));
  const aerialPromise = fetchAerialImagery(aerialUrl, {
    fetchImage: options.aerial?.fetchImage,
    timeoutMs: options.aerial?.timeoutMs,
  });
  const toPage = makeWgs84PageTransform(mercBbox, rect);
  const ptsPerMeter = aerialPagePointsPerGroundMeter(mercBbox, rect, study.catchmentBbox);

  let imagery = await aerialPromise;
  let imageryPng: PDFImage | undefined;
  if (imagery.ok) {
    try {
      imageryPng = await doc.embedPng(imagery.bytes);
    } catch (error) {
      imagery = {
        ok: false,
        reason: `imagery decode failed: ${error instanceof Error ? error.message : String(error)}`,
        url: imagery.url,
      };
    }
  }

  // The study's water gradient — decoded from the pinned-contract payload;
  // a decode failure degrades honestly (no gradient composited), never a
  // failed export.
  let gradientPng: PDFImage | undefined;
  if (study.gradient?.pngBase64) {
    try {
      gradientPng = await doc.embedPng(Buffer.from(study.gradient.pngBase64, "base64"));
    } catch {
      gradientPng = undefined;
    }
  }

  // ── SHEET 1 · DRAWING (imagery + water gradient) ───────────────────────
  {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawFdHeader(
      page,
      study,
      descriptor,
      F,
      `${FLOOD_DRAINAGE_KICKER} · SHEET 1 OF ${FLOOD_DRAINAGE_TOTAL_SHEETS}`,
      headerStats(study),
      null,
    );
    marks.once(1, "fd-header", "drawing");
    drawStudyDrawing(page, study, F, frame, marks, toPage, {
      imagery,
      imageryPng,
      gradientPng,
    });
    drawFdFooter(
      page,
      study,
      ptsPerMeter,
      F,
      marks,
      rhythm,
      generatedAt,
      imagery,
      gradientPng !== undefined,
      descriptor.liveViewUrl,
    );
    drawFinePrint(page, 1, fdFinePrint(study, 1, imagery), F, marks);
  }

  // ── SHEET 2 · SUMMARY ──────────────────────────────────────────────────
  {
    const pageNo = 2;
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const ruleY = drawFdHeader(
      page,
      study,
      descriptor,
      F,
      `${FLOOD_DRAINAGE_SUMMARY_KICKER} · SHEET 2 OF ${FLOOD_DRAINAGE_TOTAL_SHEETS}`,
      null,
      [docId, study.parcelNodeId],
    );
    marks.once(pageNo, "fd-header", "summary");

    // MODELED RESULTS.
    let cursor = drawSectionHeading(page, pageNo, "MODELED RESULTS", ruleY, F, rhythm);
    cursor = drawFdKvRow(
      page,
      pageNo,
      study.honestEmpty
        ? { label: "Catchment area", chip: true, grey: study.honestEmpty.reason }
        : {
            label: "Catchment area",
            value: formatSqFt(study.stats.catchmentAreaSqFt),
            grey: formatAcresQualifier(study.stats.catchmentAreaSqFt),
            accentValue: true,
          },
      cursor,
      F,
      rhythm,
    );
    // Headline = parcel-clipped; the whole-region figure rides as the
    // labeled context qualifier only (never the headline).
    const widerQualifier =
      study.stats.pondedAreaModeledRegionSqFt != null &&
      study.stats.pondedAreaModeledRegionSqFt > (study.stats.pondedAreaSqFt ?? 0)
        ? ` · wider modeled area ${(study.stats.pondedAreaModeledRegionSqFt / 43_560).toFixed(1)} acres`
        : "";
    cursor = drawFdKvRow(
      page,
      pageNo,
      study.honestEmpty
        ? { label: "Ponding on parcel", chip: true, grey: study.honestEmpty.reason }
        : study.stats.pondedAreaSqFt == null
          ? {
              label: "Ponding on parcel",
              chip: true,
              grey: FLOOD_DRAINAGE_PONDING_NOT_MODELED_REASON,
            }
          : study.stats.pondedAreaSqFt > 0
            ? {
                label: "Ponding on parcel",
                value: formatSqFt(study.stats.pondedAreaSqFt),
                grey: `at a ${study.rainfallDepthInches} inch design storm${widerQualifier}`,
              }
            : {
                label: "Ponding on parcel",
                value: "None modeled",
                grey: `no modeled ponding intersects the parcel at a ${study.rainfallDepthInches} inch design storm${widerQualifier}`,
              },
      cursor,
      F,
      rhythm,
    );
    cursor = drawFdKvRow(
      page,
      pageNo,
      study.honestEmpty
        ? { label: "Flow exits", chip: true, grey: study.honestEmpty.reason }
        : {
            label: "Flow exits",
            value: String(study.stats.flowExitCount),
            grey:
              study.stats.flowExitCount > 0
                ? "modeled flow paths crossing the parcel boundary"
                : "no concentrated flow path crossing the boundary was traced",
          },
      cursor,
      F,
      rhythm,
    );

    // RAINFALL FORCING.
    cursor = drawSectionHeading(page, pageNo, "RAINFALL FORCING", cursor, F, rhythm);
    const sourceQualifier =
      study.rainfallSource === "noaa-atlas14"
        ? "NOAA Atlas 14 point estimate for this location"
        : study.rainfallSource === "parameter"
          ? "depth supplied by the requesting application"
          : "documented regional default, live estimate unavailable";
    cursor = drawFdKvRow(
      page,
      pageNo,
      {
        label: "Design storm",
        value: `${study.rainfallDepthInches} in · 24-hr · 100-yr`,
        grey: sourceQualifier,
      },
      cursor,
      F,
      rhythm,
    );

    // BRIEFING — the layman paragraph, wrapped (§21 rhythm).
    cursor = drawSectionHeading(page, pageNo, "BRIEFING", cursor, F, rhythm);
    const briefingLines = wrapTextToWidth(
      study.briefing,
      F.body,
      TYPE.rowValue,
      PAGE_WIDTH - MARGIN_X * 2,
    );
    const briefingPlaced = placeRowBelowRule(cursor, LB.kvRow, {
      padTop: pt(SPACE.s2),
      padBottom: pt(SPACE.s2),
      lines: Math.max(1, briefingLines.length),
    });
    briefingLines.forEach((line, li) => {
      page.drawText(line, {
        x: MARGIN_X,
        y: briefingPlaced.baselines[li]!,
        size: TYPE.rowValue,
        font: F.body,
        color: TOKENS.neutral800,
      });
    });
    rhythm.row(pageNo, "briefing-text", briefingPlaced, LB.kvRow, pt(SPACE.s2), { ruleDrawn: false });
    marks.once(pageNo, "briefing", "paragraph");
    cursor = briefingPlaced.nextRuleY;

    // PROVENANCE.
    cursor = drawSectionHeading(page, pageNo, "PROVENANCE", cursor, F, rhythm);
    drawFdProvenanceTable(page, pageNo, fdProvenanceRows(study), cursor, F, rhythm);

    drawFinePrint(page, pageNo, fdFinePrint(study, 2), F, marks);
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return {
    bytes,
    pageCount: doc.getPageCount(),
    honestEmpty: !!study.honestEmpty,
    ...(study.honestEmpty ? { honestEmptyReason: study.honestEmpty.reason } : {}),
    fontNote:
      "Rendered with embedded Barlow (Regular/Medium) and Barlow Condensed (Medium/SemiBold), OFL.",
    marks: marks.marks,
    rhythm: rhythm.rows,
    page1Frame: frame,
    aerial: imagery.ok
      ? { imageryEmbedded: true, sourceUrl: imagery.url }
      : { imageryEmbedded: false, sourceUrl: imagery.url, unavailableReason: imagery.reason },
    gradientComposited: gradientPng !== undefined,
  };
}
