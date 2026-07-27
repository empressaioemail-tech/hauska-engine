import type { LocalPoint } from "../ring-geometry.js";
import type { PageXY } from "./layout.js";

/**
 * PDF annotation craft helpers — placement only. Geometry still comes from the
 * shared SitePlanModel; nothing here re-derives rings, offsets, or contours.
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
  /** Top-left-ish draw origin for pdf-lib drawText. */
  drawAt: PageXY;
  box: LabelBox;
}

/** Quadrant bearing from local-ENU segment ( +Y = north, +X = east ). GIS-approx. */
export function formatGisBearing(dxMeters: number, dyMeters: number): string {
  if (!(Math.abs(dxMeters) > 1e-9 || Math.abs(dyMeters) > 1e-9)) {
    return "N 0°00' E";
  }
  // Azimuth from north toward east, degrees [0, 360).
  let az = (Math.atan2(dxMeters, dyMeters) * 180) / Math.PI;
  if (az < 0) az += 360;

  const pad2 = (n: number) => n.toString().padStart(2, "0");
  // Quadrant bearings: due-east = N 90° E; due-west = N 90° W.
  if (az <= 90) {
    const d = Math.floor(az);
    const m = Math.round((az - d) * 60) % 60;
    return `N ${d}°${pad2(m)}' E`;
  }
  if (az < 180) {
    const fromS = 180 - az;
    const d = Math.floor(fromS);
    const m = Math.round((fromS - d) * 60) % 60;
    return `S ${d}°${pad2(m)}' E`;
  }
  if (az < 270) {
    const fromS = az - 180;
    const d = Math.floor(fromS);
    const m = Math.round((fromS - d) * 60) % 60;
    return `S ${d}°${pad2(m)}' W`;
  }
  const fromN = 360 - az;
  const d = Math.floor(fromN);
  const m = Math.round((fromN - d) * 60) % 60;
  return `N ${d}°${pad2(m)}' W`;
}

/**
 * Property-line tag from a GIS ring segment. Always GIS-approximate —
 * callers must surface the honesty note; never present as survey-grade.
 */
export function formatPropertyLineTag(segment: {
  a: LocalPoint;
  b: LocalPoint;
  lengthFeet: number;
}): string {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const bearing = formatGisBearing(dx, dy);
  return `${bearing}  ${segment.lengthFeet.toFixed(1)}'`;
}

export const PROPERTY_LINE_TAGS_HONESTY =
  "Property-line tags: GIS-approximate from county parcel ring — not a boundary survey.";

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

export function estimateTextWidth(text: string, fontSize: number): number {
  // Helvetica approx: ~0.5em average glyph width — good enough for collision boxes.
  return text.length * fontSize * 0.52;
}

function boxesOverlap(a: LabelBox, b: LabelBox, pad = 2): boolean {
  return !(
    a.x + a.width + pad < b.x ||
    b.x + b.width + pad < a.x ||
    a.y + a.height + pad < b.y ||
    b.y + b.height + pad < a.y
  );
}

/**
 * Place labels at outward offsets from edge midpoints, then greedily nudge
 * colliding boxes further outward (and slightly along-edge) until clear or
 * max iterations. Pure craft — does not change model geometry.
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
  options: {
    ringCcw: boolean;
    /** Local-ENU metres of outward offset before projection. */
    outwardMeters: number;
    pageScale: number;
  },
): PlacedLabel[] {
  const { ringCcw, outwardMeters, pageScale } = options;
  const placed: PlacedLabel[] = [];

  for (const item of items) {
    const n = outwardNormal(item.a, item.b, ringCcw);
    let offsetM = outwardMeters;
    let alongM = 0;
    const fontSize = item.fontSize;
    const width = estimateTextWidth(item.text, fontSize);
    const height = fontSize + 1;

    let drawAt: PageXY = { x: 0, y: 0 };
    let box: LabelBox = { x: 0, y: 0, width, height };
    let anchor: PageXY = { x: 0, y: 0 };

    for (let iter = 0; iter < 12; iter++) {
      const local: LocalPoint = {
        x: item.midLocal.x + n.x * offsetM + (-n.y) * alongM,
        y: item.midLocal.y + n.y * offsetM + n.x * alongM,
      };
      anchor = project(local);
      // Center text on the outward anchor.
      drawAt = { x: anchor.x - width / 2, y: anchor.y - height / 3 };
      box = { x: drawAt.x, y: drawAt.y, width, height };
      const hit = placed.some((p) => boxesOverlap(box, p.box));
      if (!hit) break;
      offsetM += Math.max(0.6, 4 / pageScale);
      alongM += (iter % 2 === 0 ? 1 : -1) * Math.max(0.4, 3 / pageScale);
    }

    placed.push({ text: item.text, anchor, drawAt, box });
  }

  return placed;
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
