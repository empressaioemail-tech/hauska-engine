import type { LocalPoint } from "../ring-geometry.js";
import type { PageXY } from "./layout.js";
import {
  formatGisBearing as formatGisBearingShared,
  formatPropertyLineTag as formatPropertyLineTagShared,
  formatPropertyLineTagDistanceFirst as formatPropertyLineTagDistanceFirstShared,
  PROPERTY_LINE_TAGS_HONESTY as PROPERTY_LINE_TAGS_HONESTY_SHARED,
} from "../../geometry/gis-property-line-tags.js";

/**
 * PDF annotation craft helpers — placement only. Geometry still comes from the
 * shared SitePlanModel; nothing here re-derives rings, offsets, or contours.
 *
 * GIS bearing / property-line-tag text lives in geometry/gis-property-line-tags
 * (shared with boundary-edge atoms) — re-exported here so PDF callers keep
 * the same import path without inventing a second formula.
 */

const METERS_PER_FOOT = 0.3048;

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedLabel {
  text: string;
  anchor: PageXY;
  /** Bottom-left-ish draw origin for pdf-lib drawText. */
  drawAt: PageXY;
  box: LabelBox;
  fontSize: number;
  /** When the label was nudged off the edge midpoint, connect with a leader. */
  leader?: { from: PageXY; to: PageXY };
}

export type MeasureTextFn = (text: string, fontSize: number) => number;

/** @see geometry/gis-property-line-tags — shared with boundary-edge atoms. */
export const formatGisBearing = formatGisBearingShared;

/** @see geometry/gis-property-line-tags — shared with boundary-edge atoms. */
export function formatPropertyLineTag(segment: {
  a: LocalPoint;
  b: LocalPoint;
  lengthFeet: number;
}): string {
  return formatPropertyLineTagShared(segment);
}

/**
 * Distance-first tag ("98.3' · N 89°58' W"), the Industry template's gold
 * reference presentation. @see geometry/gis-property-line-tags — same single
 * bearing formula, template display order.
 */
export function formatPropertyLineTagDistanceFirst(segment: {
  a: LocalPoint;
  b: LocalPoint;
  lengthFeet: number;
}): string {
  return formatPropertyLineTagDistanceFirstShared(segment);
}

/** @see geometry/gis-property-line-tags */
export const PROPERTY_LINE_TAGS_HONESTY = PROPERTY_LINE_TAGS_HONESTY_SHARED;

/** Outward unit normal for edge a→b given a CCW ring (interior to the left). */
export function outwardNormal(a: LocalPoint, b: LocalPoint, ringCcw: boolean): LocalPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Left normal of a→b is (-dy, dx); for CCW ring that points inward.
  const inward: LocalPoint = ringCcw
    ? { x: -dy / len, y: dx / len }
    : { x: dy / len, y: -dx / len };
  return { x: -inward.x, y: -inward.y };
}

/**
 * Fallback width estimate when no pdf-lib font is available (tests only).
 * Production placement must pass `font.widthOfTextAtSize` via measureText.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.52;
}

/**
 * Scale-aware annotation font size. Dense / low-scale sheets get smaller type
 * so labels fit; zoomed parcel-primary sheets can use a slightly larger size.
 */
export function craftLabelFontSize(
  pageScale: number,
  kind: "edge" | "setback" | "street" | "contour" | "callout" = "edge",
): number {
  // pageScale = page points per local-ENU metre (parcel-primary fit ≈ 8–45).
  const edge =
    pageScale >= 28 ? 7.5 : pageScale >= 18 ? 6.5 : pageScale >= 11 ? 5.5 : 4.75;
  switch (kind) {
    case "setback":
      return Math.max(4.5, edge - 0.25);
    case "street":
      return Math.max(5, edge);
    case "contour":
      return Math.max(4, edge - 1.5);
    case "callout":
      return Math.max(5.5, Math.min(8, edge + 0.5));
    default:
      return edge;
  }
}

export function boxesOverlap(a: LabelBox, b: LabelBox, pad = 2): boolean {
  return !(
    a.x + a.width + pad < b.x ||
    b.x + b.width + pad < a.x ||
    a.y + a.height + pad < b.y ||
    b.y + b.height + pad < a.y
  );
}

function boxHitsOccupied(box: LabelBox, occupied: readonly PlacedLabel[]): boolean {
  return occupied.some((p) => boxesOverlap(box, p.box));
}

function buildBox(
  drawAt: PageXY,
  width: number,
  height: number,
): LabelBox {
  return { x: drawAt.x, y: drawAt.y, width, height };
}

export interface PlaceLabelsOptions {
  ringCcw: boolean;
  /** Local-ENU metres of outward offset before projection. */
  outwardMeters: number;
  pageScale: number;
  /** Prefer pdf-lib `font.widthOfTextAtSize`. */
  measureText: MeasureTextFn;
  /**
   * Shared collision set across tag / setback / street / contour passes.
   * Newly accepted labels are appended; callers must pass the same array.
   */
  occupied: PlacedLabel[];
  /** Nudge iterations before shrink / leader / drop. Default 12. */
  maxNudgeIterations?: number;
  /** Minimum font size before drop. Default 4. */
  minFontSize?: number;
  /** When set, a placement whose box leaves this rect is rejected (drop over off-sheet). */
  bounds?: LabelBounds;
}

/**
 * Place edge labels at outward offsets from midpoints. Never silently overlaps:
 * nudge → shrink → leader → drop. Dropped labels are omitted from the return
 * (and never added to `occupied`).
 */
export function placeNonCollidingEdgeLabels(
  items: Array<{
    midLocal: LocalPoint;
    a: LocalPoint;
    b: LocalPoint;
    text: string;
    fontSize: number;
  }>,
  project: (p: LocalPoint) => PageXY,
  options: PlaceLabelsOptions,
): PlacedLabel[] {
  const {
    ringCcw,
    outwardMeters,
    pageScale,
    measureText,
    occupied,
    maxNudgeIterations = 12,
    minFontSize = 4,
    bounds,
  } = options;
  const newlyPlaced: PlacedLabel[] = [];

  for (const item of items) {
    if (!item.text) continue;
    const n = outwardNormal(item.a, item.b, ringCcw);
    const edgeMid = project(item.midLocal);
    const result = tryPlaceEdgeLabel(item, n, edgeMid, project, {
      outwardMeters,
      pageScale,
      measureText,
      occupied,
      maxNudgeIterations,
      minFontSize,
      bounds,
    });
    if (result) {
      occupied.push(result);
      newlyPlaced.push(result);
    }
  }

  return newlyPlaced;
}

function tryPlaceEdgeLabel(
  item: {
    midLocal: LocalPoint;
    a: LocalPoint;
    b: LocalPoint;
    text: string;
    fontSize: number;
  },
  n: LocalPoint,
  edgeMid: PageXY,
  project: (p: LocalPoint) => PageXY,
  opts: {
    outwardMeters: number;
    pageScale: number;
    measureText: MeasureTextFn;
    occupied: readonly PlacedLabel[];
    maxNudgeIterations: number;
    minFontSize: number;
    bounds?: LabelBounds;
  },
): PlacedLabel | null {
  const sizes: number[] = [];
  for (let s = item.fontSize; s >= opts.minFontSize - 1e-6; s -= 0.75) {
    sizes.push(Math.round(s * 100) / 100);
  }
  if (sizes.length === 0) sizes.push(opts.minFontSize);

  // Pass 1: nudge at full/shrinking sizes without requiring a leader.
  for (const fontSize of sizes) {
    const placed = nudgeEdgeLabel(item, n, edgeMid, project, fontSize, opts, false);
    if (placed) return placed;
  }

  // Pass 2: leader allowed — place further out and connect to the edge midpoint.
  for (const fontSize of sizes) {
    const placed = nudgeEdgeLabel(item, n, edgeMid, project, fontSize, opts, true);
    if (placed) return placed;
  }

  // Drop — never silent-overlap.
  return null;
}

function nudgeEdgeLabel(
  item: {
    midLocal: LocalPoint;
    text: string;
  },
  n: LocalPoint,
  edgeMid: PageXY,
  project: (p: LocalPoint) => PageXY,
  fontSize: number,
  opts: {
    outwardMeters: number;
    pageScale: number;
    measureText: MeasureTextFn;
    occupied: readonly PlacedLabel[];
    maxNudgeIterations: number;
    bounds?: LabelBounds;
  },
  allowLeader: boolean,
): PlacedLabel | null {
  let offsetM = opts.outwardMeters;
  let alongM = 0;
  const width = opts.measureText(item.text, fontSize);
  const height = fontSize + 1;
  const leaderThresholdM = opts.outwardMeters * 1.35;

  for (let iter = 0; iter < opts.maxNudgeIterations; iter++) {
    const local: LocalPoint = {
      x: item.midLocal.x + n.x * offsetM + -n.y * alongM,
      y: item.midLocal.y + n.y * offsetM + n.x * alongM,
    };
    const anchor = project(local);
    const drawAt = { x: anchor.x - width / 2, y: anchor.y - height / 3 };
    const box = buildBox(drawAt, width, height);
    const needsLeader = offsetM > leaderThresholdM || Math.abs(alongM) > opts.outwardMeters * 0.8;
    if (needsLeader && !allowLeader) {
      offsetM += Math.max(0.6, 4 / opts.pageScale);
      alongM += (iter % 2 === 0 ? 1 : -1) * Math.max(0.4, 3 / opts.pageScale);
      continue;
    }
    if (!boxHitsOccupied(box, opts.occupied) && boxInsideBounds(box, opts.bounds)) {
      const leader = needsLeader || allowLeader
        ? {
            from: edgeMid,
            to: { x: drawAt.x + width / 2, y: drawAt.y + height / 3 },
          }
        : undefined;
      // Only attach leader when we actually left the near-edge band.
      const useLeader = leader && (needsLeader || allowLeader) && offsetM > leaderThresholdM * 0.9;
      return {
        text: item.text,
        anchor,
        drawAt,
        box,
        fontSize,
        leader: useLeader ? leader : undefined,
      };
    }
    offsetM += Math.max(0.6, 4 / opts.pageScale);
    alongM += (iter % 2 === 0 ? 1 : -1) * Math.max(0.4, 3 / opts.pageScale);
  }
  return null;
}

export interface PlacePointLabelItem {
  /** Preferred page-space anchor (e.g. street midpoint, contour mid). */
  point: PageXY;
  text: string;
  fontSize: number;
}

/** Page-space rectangle a label box must stay inside (sheet clamp). */
export interface LabelBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxInsideBounds(box: LabelBox, bounds: LabelBounds | undefined): boolean {
  if (!bounds) return true;
  return (
    box.x >= bounds.minX &&
    box.y >= bounds.minY &&
    box.x + box.width <= bounds.maxX &&
    box.y + box.height <= bounds.maxY
  );
}

/**
 * Place free (non-edge) labels — street names, contour elevations, lot-area
 * callouts — into the shared collision set. Nudge → shrink → drop; never
 * silent-overlap.
 */
export function placeNonCollidingPointLabels(
  items: PlacePointLabelItem[],
  options: {
    measureText: MeasureTextFn;
    occupied: PlacedLabel[];
    pageScale: number;
    maxNudgeIterations?: number;
    minFontSize?: number;
    /** When set, a placement whose box leaves this rect is rejected (drop over off-sheet). */
    bounds?: LabelBounds;
  },
): PlacedLabel[] {
  const {
    measureText,
    occupied,
    pageScale,
    maxNudgeIterations = 12,
    minFontSize = 4,
    bounds,
  } = options;
  const newlyPlaced: PlacedLabel[] = [];
  const step = Math.max(3, 6 / Math.max(pageScale, 0.01));

  for (const item of items) {
    if (!item.text) continue;
    const sizes: number[] = [];
    for (let s = item.fontSize; s >= minFontSize - 1e-6; s -= 0.75) {
      sizes.push(Math.round(s * 100) / 100);
    }
    if (sizes.length === 0) sizes.push(minFontSize);

    let accepted: PlacedLabel | null = null;
    for (const fontSize of sizes) {
      const width = measureText(item.text, fontSize);
      const height = fontSize + 1;
      // Spiral offsets in page points.
      const offsets: Array<[number, number]> = [[0, 0]];
      for (let iter = 1; iter < maxNudgeIterations; iter++) {
        const r = step * iter;
        offsets.push(
          [r, 0],
          [-r, 0],
          [0, r],
          [0, -r],
          [r * 0.7, r * 0.7],
          [-r * 0.7, r * 0.7],
          [r * 0.7, -r * 0.7],
          [-r * 0.7, -r * 0.7],
        );
      }
      for (const [dx, dy] of offsets) {
        const anchor = { x: item.point.x + dx, y: item.point.y + dy };
        const drawAt = { x: anchor.x - width / 2, y: anchor.y - height / 3 };
        const box = buildBox(drawAt, width, height);
        if (!boxHitsOccupied(box, occupied) && boxInsideBounds(box, bounds)) {
          const far = Math.hypot(dx, dy) > step * 1.5;
          accepted = {
            text: item.text,
            anchor,
            drawAt,
            box,
            fontSize,
            leader: far
              ? { from: item.point, to: { x: drawAt.x + width / 2, y: drawAt.y + height / 3 } }
              : undefined,
          };
          break;
        }
      }
      if (accepted) break;
    }
    if (accepted) {
      occupied.push(accepted);
      newlyPlaced.push(accepted);
    }
  }

  return newlyPlaced;
}

/** Clip a polyline to an axis-aligned box in local-ENU metres (Liang-Barsky). */
export function clipPolylineToAabb(
  points: Array<[number, number]>,
  box: { minX: number; maxX: number; minY: number; maxY: number },
): Array<Array<[number, number]>> {
  if (points.length < 2) return [];

  const clips: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];

  const clipSegment = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): Array<[number, number]> | null => {
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const checks: Array<[number, number]> = [
      [-dx, x0 - box.minX],
      [dx, box.maxX - x0],
      [-dy, y0 - box.minY],
      [dy, box.maxY - y0],
    ];
    for (const [p, q] of checks) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
    return [
      [x0 + t0 * dx, y0 + t0 * dy],
      [x0 + t1 * dx, y0 + t1 * dy],
    ];
  };

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const clipped = clipSegment(a[0], a[1], b[0], b[1]);
    if (!clipped) {
      if (current.length >= 2) clips.push(current);
      current = [];
      continue;
    }
    const [c0, c1] = clipped;
    if (current.length === 0) {
      current.push(c0!, c1!);
    } else {
      const last = current[current.length - 1]!;
      if (Math.hypot(last[0] - c0![0], last[1] - c0![1]) > 1e-6) {
        clips.push(current);
        current = [c0!, c1!];
      } else {
        current.push(c1!);
      }
    }
  }
  if (current.length >= 2) clips.push(current);
  return clips;
}

export function ringSignedAreaLocal(ring: LocalPoint[]): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function expandRingAabb(
  ring: LocalPoint[],
  padMeters: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return {
    minX: Math.min(...xs) - padMeters,
    maxX: Math.max(...xs) + padMeters,
    minY: Math.min(...ys) - padMeters,
    maxY: Math.max(...ys) + padMeters,
  };
}

export function feetFromMeters(meters: number): number {
  return meters / METERS_PER_FOOT;
}

/** Centroid of a local-ENU ring (for optional lot-area callout). */
export function ringCentroidLocal(ring: LocalPoint[]): LocalPoint {
  if (ring.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  const n = ring.length > 1 &&
    ring[0]!.x === ring[ring.length - 1]!.x &&
    ring[0]!.y === ring[ring.length - 1]!.y
    ? ring.length - 1
    : ring.length;
  for (let i = 0; i < n; i++) {
    sx += ring[i]!.x;
    sy += ring[i]!.y;
  }
  return { x: sx / Math.max(n, 1), y: sy / Math.max(n, 1) };
}
