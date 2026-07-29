import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFPage, type RGB } from "pdf-lib";

import type { GeoJsonFeatureCollection } from "@hauska-engine/adapters/hydrology";

import type { FloodDrainageStudy } from "../flood-drainage-study.js";
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
  drawFilledRing,
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
 * FLOOD & DRAINAGE assembler (2026-07-29, R3 — the FIRST paid report
 * document). Sits beside dossier.ts on the SAME binding SHEET_STANDARD
 * (v1.3): tokens, Barlow faces, §21 line-box rhythm, §6 chips, §12 number
 * form, §11 prose hygiene, §8 fine print, §14 draw-once, §3 frame-clip.
 * ONE document pattern — this reuses the dossier scaffolding style and the
 * render.ts sibling primitives; it never invents a second visual system.
 *
 *   SHEET 1 · DRAWING — parcel ring (heaviest stroke) over the modeled
 *     catchment, drainage-concentration zones and rainfall ponding (subtle
 *     graded fills inside the ONE accent ramp), traced flow lines, flow-exit
 *     arrows, legend / scale bar / north arrow, fine print.
 *   SHEET 2 · SUMMARY — modeled results + rainfall forcing (source honestly
 *     labeled) + the layman briefing + a three-column provenance table +
 *     fine print with the not-an-engineering-study disclaimer.
 *
 * HONEST-EMPTY: a flat-terrain / DEM-void study still ships BOTH sheets —
 * the drawing carries the parcel ring and a centred honest panel (aerial-
 * page pattern), the summary carries UNAVAILABLE chips with the reason.
 * Nothing geometric is ever fabricated.
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

export interface FloodDrainageDescriptor {
  address?: string;
  countyName?: string;
}

export interface EmitPdfFloodDrainageOptions {
  /** Test seam for a stable generated stamp. Defaults to now. */
  generatedAtIso?: string;
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
}

// ─────────────────────────────────────────────────────────────────────────
// Colour roles — the ONE accent ramp, graded subtle → strong (§3/§5).
// ─────────────────────────────────────────────────────────────────────────
const INK = TOKENS.text;
const CATCHMENT_FILL = TOKENS.accent100;
const ZONE_FILL_LOW = TOKENS.accent200;
const ZONE_FILL_HIGH = TOKENS.accent300;
const PONDING_FILL = TOKENS.accent400;
const FLOW_LINE_COLOR = TOKENS.accent500;
const EXIT_ARROW_COLOR = TOKENS.accent700;
const SUPPRESSED = TOKENS.neutral500;

const METERS_PER_DEG_LAT = 110_574;

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
// Projection: WGS84 → local ENU metres (parcel centroid origin) → page.
// Fit is PARCEL-PRIMARY (like the site plan): the ring plus a context pad
// governs scale; catchment context beyond the frame is clipped, never
// allowed to shrink the parcel to a dot.
// ─────────────────────────────────────────────────────────────────────────
interface FdTransform {
  lng0: number;
  lat0: number;
  mLng: number;
  /** Page points per metre. */
  scale: number;
  offsetX: number;
  offsetY: number;
}

function buildTransform(ring: ReadonlyArray<[number, number]>, frame: MarkBbox): FdTransform {
  const lng0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const mLng = METERS_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const local = ring.map(([lng, lat]) => ({
    x: (lng - lng0) * mLng,
    y: (lat - lat0) * METERS_PER_DEG_LAT,
  }));
  const xs = local.map((p) => p.x);
  const ys = local.map((p) => p.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  // Context pad: 0.9× the parcel span each side — the upstream catchment
  // reads around the parcel without the fit losing the parcel itself.
  const pad = span * 0.9;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const frameW = frame.maxX - frame.minX;
  const frameH = frame.maxY - frame.minY;
  const scale = Math.min(frameW / spanX, frameH / spanY) * 0.98;
  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  return {
    lng0,
    lat0,
    mLng,
    scale,
    offsetX: frame.minX + (frameW - drawnW) / 2 - minX * scale,
    offsetY: frame.minY + (frameH - drawnH) / 2 - minY * scale,
  };
}

function project(t: FdTransform, lng: number, lat: number): { x: number; y: number } {
  return {
    x: t.offsetX + (lng - t.lng0) * t.mLng * t.scale,
    y: t.offsetY + (lat - t.lat0) * METERS_PER_DEG_LAT * t.scale,
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

/** Project a GeoJSON Polygon exterior ring, clamped to the frame. Returns
 * null when the polygon lies entirely outside the frame. */
function projectPolygon(
  t: FdTransform,
  frame: MarkBbox,
  coordinates: unknown,
): Array<{ x: number; y: number }> | null {
  const exterior = Array.isArray(coordinates) ? (coordinates as unknown[])[0] : null;
  if (!Array.isArray(exterior) || exterior.length < 3) return null;
  const projected = (exterior as Array<[number, number]>).map(([lng, lat]) => project(t, lng, lat));
  const inside = projected.some(
    (p) => p.x >= frame.minX && p.x <= frame.maxX && p.y >= frame.minY && p.y <= frame.maxY,
  );
  if (!inside) return null;
  return projected.map((p) => clampToFrame(p, frame));
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

/** True when a rainfall feature intersects the parcel (study-side clip tag). */
function pondingFeatureOnParcel(feature: GeoJsonFeatureCollection["features"][number]): boolean {
  return (feature.properties as { onParcel?: boolean } | undefined)?.onParcel === true;
}

/** True when the zones layer carries at least one graded cell to draw. */
function hasGradedZones(study: FloodDrainageStudy): boolean {
  return study.drainageZonesGeoJson.features.some(
    (f) => Number((f.properties as { concentration?: number } | undefined)?.concentration ?? 0) >= 1,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sheet-1 drawing.
// ─────────────────────────────────────────────────────────────────────────
function drawStudyDrawing(
  page: PDFPage,
  study: FloodDrainageStudy,
  F: Fonts,
  frame: MarkBbox,
  marks: MarkRegistry,
): FdTransform {
  const t = buildTransform(study.parcelRingWgs84, frame);

  if (!study.honestEmpty) {
    // 1) CATCHMENT — faintest ramp step, behind everything.
    {
      const drawn: Array<{ x: number; y: number }> = [];
      for (const feature of study.catchmentGeoJson.features) {
        if (feature.geometry.type !== "Polygon") continue;
        const ring = projectPolygon(t, frame, feature.geometry.coordinates);
        if (!ring) continue;
        drawFilledRing(page, ring, CATCHMENT_FILL);
        drawn.push(...ring);
      }
      if (drawn.length > 0) marks.once(1, "catchment-fill", "mask", bboxOf(drawn));
    }

    // 2) DRAINAGE CONCENTRATION — graded by the real flow-vertex density.
    {
      const drawn: Array<{ x: number; y: number }> = [];
      for (const feature of study.drainageZonesGeoJson.features) {
        const concentration = Number(
          (feature.properties as { concentration?: number } | undefined)?.concentration ?? 0,
        );
        if (concentration < 1 || feature.geometry.type !== "Polygon") continue;
        const ring = projectPolygon(t, frame, feature.geometry.coordinates);
        if (!ring) continue;
        drawFilledRing(page, ring, concentration >= 2 ? ZONE_FILL_HIGH : ZONE_FILL_LOW);
        drawn.push(...ring);
      }
      if (drawn.length > 0) marks.once(1, "drainage-zones", "graded", bboxOf(drawn));
    }

    // 3) RAINFALL PONDING — ON-PARCEL FEATURES ONLY (2026-07-29 canary
    // fix). DESIGN CHOICE: far-field ponding across the padded modeled
    // region is NOT drawn at all — at parcel scale it reads as noise, the
    // catchment fill already carries the regional context, and the wider
    // area is disclosed as a labeled qualifier on the summary sheet. The
    // drawing answers "where does water pool HERE".
    if (study.rainfallResultGeoJson) {
      const drawn: Array<{ x: number; y: number }> = [];
      for (const feature of study.rainfallResultGeoJson.features) {
        if (feature.geometry.type !== "Polygon") continue;
        if (!pondingFeatureOnParcel(feature)) continue;
        const ring = projectPolygon(t, frame, feature.geometry.coordinates);
        if (!ring) continue;
        drawFilledRing(page, ring, PONDING_FILL);
        drawn.push(...ring);
      }
      if (drawn.length > 0) marks.once(1, "rainfall-ponding", "mask", bboxOf(drawn));
    }

    // 4) FLOW LINES — clipped hard to the frame (§3 frame-clip).
    study.flowLinesGeoJson.features.forEach((feature, i) => {
      if (feature.geometry.type !== "LineString") return;
      const projected = (feature.geometry.coordinates as Array<[number, number]>).map(
        ([lng, lat]) => {
          const p = project(t, lng, lat);
          return [p.x, p.y] as [number, number];
        },
      );
      const clips = clipPolylineToAabb(projected, frame);
      const pts: Array<{ x: number; y: number }> = [];
      for (const clip of clips) {
        const line = clip.map(([x, y]) => ({ x, y }));
        drawPolyline(page, line, FLOW_LINE_COLOR, 0.7, SETBACK_DASH);
        pts.push(...line);
      }
      if (pts.length > 0) marks.once(1, "flow-line", String(i), bboxOf(pts));
    });
  }

  // 5) PROPERTY LINE — heaviest stroke on the sheet, always drawn (§3).
  const ringPage = study.parcelRingWgs84.map(([lng, lat]) =>
    clampToFrame(project(t, lng, lat), frame),
  );
  if (marks.once(1, "property-line", "ring", bboxOf(ringPage))) {
    drawRing(page, ringPage, INK, STROKE.property);
  }

  // 6) FLOW EXIT ARROWS — outbound bearing at each traced exit (§14 keyed).
  if (!study.honestEmpty) {
    study.flowExits.forEach((exit, i) => {
      const at = project(t, exit.lng, exit.lat);
      if (
        at.x < frame.minX + pt(8) ||
        at.x > frame.maxX - pt(8) ||
        at.y < frame.minY + pt(8) ||
        at.y > frame.maxY - pt(8)
      ) {
        return; // an arrow that would cross the frame is dropped, not clipped ugly
      }
      const rad = (exit.bearingDeg * Math.PI) / 180;
      const ux = Math.sin(rad);
      const uy = Math.cos(rad);
      const len = pt(18);
      const tip = { x: at.x + ux * len, y: at.y + uy * len };
      const px = -uy;
      const py = ux;
      const headLen = pt(6);
      const base = { x: tip.x - ux * headLen, y: tip.y - uy * headLen };
      const leftPt = { x: base.x + px * headLen * 0.45, y: base.y + py * headLen * 0.45 };
      const rightPt = { x: base.x - px * headLen * 0.45, y: base.y - py * headLen * 0.45 };
      if (!marks.once(1, "flow-exit-arrow", String(i), bboxOf([at, tip, leftPt, rightPt]))) return;
      page.drawLine({ start: at, end: base, thickness: 1.1, color: EXIT_ARROW_COLOR });
      const path =
        `M ${tip.x.toFixed(2)} ${tip.y.toFixed(2)} ` +
        `L ${leftPt.x.toFixed(2)} ${leftPt.y.toFixed(2)} ` +
        `L ${rightPt.x.toFixed(2)} ${rightPt.y.toFixed(2)} Z`;
      page.drawSvgPath(path, { color: EXIT_ARROW_COLOR, borderWidth: 0 });
    });
  }

  // 7) HONEST PANEL (aerial-page pattern): centred title + ONE sentence.
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

  // 8) NORTH ARROW — exactly one, top-right inside the frame (§9/§14).
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
      drawNorthArrow(page, { origin, tip }, F.display);
    }
  }

  return t;
}

// ─────────────────────────────────────────────────────────────────────────
// Sheet-1 footer: legend (fixed §5 order, empty rows grey with the reason
// inline) + scale bar + fine print.
// ─────────────────────────────────────────────────────────────────────────
interface FdLegendRow {
  label: string;
  swatch: "line-heavy" | "fill" | "line-dashed" | "arrow";
  color: RGB;
  empty?: boolean;
}

function fdLegendRows(study: FloodDrainageStudy): FdLegendRow[] {
  const empty = !!study.honestEmpty;
  // §5: an empty layer stays LISTED, greys to neutral-500, and carries its
  // reason INLINE on the same row — a populated-looking legend row over a
  // layer that drew nothing (the 2026-07-29 canary smoke) is a defect.
  const zonesEmpty = empty || !hasGradedZones(study);
  const pondingOnParcel =
    !empty &&
    !!study.rainfallResultGeoJson &&
    study.rainfallResultGeoJson.features.some(pondingFeatureOnParcel);
  return [
    { label: "Property line", swatch: "line-heavy", color: INK },
    {
      label: empty ? "Catchment — none modeled" : "Modeled catchment",
      swatch: "fill",
      color: CATCHMENT_FILL,
      empty,
    },
    {
      label: zonesEmpty
        ? empty
          ? "Drainage concentration — none modeled"
          : "Drainage concentration — none at this resolution"
        : "Drainage concentration",
      swatch: "fill",
      color: ZONE_FILL_HIGH,
      empty: zonesEmpty,
    },
    {
      label: pondingOnParcel
        ? `Ponding on parcel at ${study.rainfallDepthInches}" storm`
        : empty || !study.rainfallResultGeoJson
          ? "Ponding — not modeled"
          : "Ponding — none modeled on parcel",
      swatch: "fill",
      color: PONDING_FILL,
      empty: !pondingOnParcel,
    },
    {
      label: empty ? "Flow lines — none traced" : "Traced flow line",
      swatch: "line-dashed",
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
  ];
}

function drawFdLegendSwatch(page: PDFPage, row: FdLegendRow, x: number, y: number): void {
  const w = pt(24);
  const midY = y + pt(3);
  if (row.swatch === "line-heavy") {
    page.drawLine({ start: { x, y: midY }, end: { x: x + w, y: midY }, thickness: STROKE.property, color: row.color });
  } else if (row.swatch === "fill") {
    page.drawRectangle({
      x,
      y: y - pt(1),
      width: w,
      height: pt(8),
      color: row.color,
      borderColor: row.empty ? SUPPRESSED : TOKENS.accent400,
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
  t: FdTransform,
  F: Fonts,
  marks: MarkRegistry,
  rhythm: RhythmCapture,
  generatedAtIso: string,
): void {
  const ruleY = page1FooterRuleYFd();
  drawHairlineRule(page, MARGIN_X, ruleY, PAGE_WIDTH - MARGIN_X * 2, TOKENS.neutral300, 0.7);

  // Legend — column-major, 3 rows per column (§5 fixed order).
  if (marks.once(1, "legend", "legend")) {
    const rows = fdLegendRows(study);
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

  // Scale bar (§9): three segments, unit on the LAST label only.
  if (marks.once(1, "scale-bar", "scale")) {
    const right = PAGE_WIDTH - MARGIN_X;
    const barWidth = pt(120);
    const ptPerFoot = t.scale * 0.3048;
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
function fdFinePrint(study: FloodDrainageStudy, sheetNo: number): string {
  const sentences: string[] = [
    FLOOD_DRAINAGE_DISCLAIMER,
    FLOOD_DRAINAGE_MODEL_BASIS_LINE,
    SITE_PLAN_HONESTY_LINE,
  ];
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
  const docId = `FD-${study.parcelNodeId.replace(/:/g, "-")}`;

  // ── SHEET 1 · DRAWING ──────────────────────────────────────────────────
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
    const t = drawStudyDrawing(page, study, F, frame, marks);
    drawFdFooter(page, study, t, F, marks, rhythm, generatedAt);
    drawFinePrint(page, 1, fdFinePrint(study, 1), F, marks);
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
  };
}
