import type { LocalPoint } from "../ring-geometry.js";
import type { SitePlanModel } from "../site-model.js";
import {
  PROPERTY_LINE_TAGS_HONESTY,
  clipPolylineToAabb,
  estimateTextWidth,
  expandRingAabb,
  formatGisBearing,
  outwardNormal,
  placeNonCollidingPointLabels,
  ringSignedAreaLocal,
  type LabelBounds,
  type MeasureTextFn,
  type PlacedLabel,
} from "./annotation-placement.js";
import { REASON, formatFeetPrime, formatMeters, formatSqFt, streetDisplayName } from "./format.js";
import { TYPE, pt } from "./template-tokens.js";

/**
 * Page-space projection derived purely from the shared `SitePlanModel` — the
 * PDF drawing renders the SAME ring/setback/contour/street points every
 * DXF/IFC entity is built from (WDLL 5/6: CAD and PDF cannot diverge). No
 * function in this file re-derives geometry; it only maps the model's
 * local-ENU metre coordinates into a page-space rectangle and applies
 * emit-craft per SHEET STANDARD v1.0 (see SHEET_STANDARD_v1.html):
 *
 * §4  label collision cascade — full tag → distance-only → margin leader →
 *     drop-and-tabulate (sheet-2 segment table, §16);
 * §14 draw-once — every mark keyed by segment id, one tag per segment;
 * §15 degenerate geometry — no envelope, no setback marks, centred callout;
 * §13 no drawing type below the rendered 10 px floor (sizes fixed in TYPE).
 */
export interface PdfTransform {
  /** Page points per local-ENU metre. */
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface PageXY {
  x: number;
  y: number;
}

export interface DrawingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const METERS_PER_FOOT = 0.3048;

export function projectPoint(transform: PdfTransform, point: LocalPoint): PageXY {
  return { x: transform.offsetX + point.x * transform.scale, y: transform.offsetY + point.y * transform.scale };
}

function projectRing(transform: PdfTransform, ring: LocalPoint[]): PageXY[] {
  return ring.map((p) => projectPoint(transform, p));
}

/**
 * Parcel-primary fit (Track B2 / site-plan road regression): scale so
 * PROPERTY_LINE + SETBACK + north/scale dominate the sheet. Streets and
 * contours are clipped to a parcel buffer for PDF craft — they never expand
 * the drawing extent (long OSM ways / bad attaching nodes used to shrink the
 * parcel to a dot). Model geometry is unchanged; CAD emitters still see full
 * DEM contours and full street centerlines.
 */
export function computeDrawingTransform(model: SitePlanModel, box: DrawingBox): PdfTransform {
  const northTip: LocalPoint = {
    x: model.north.originLocal.x + model.north.directionLocal.x * model.north.lengthMeters,
    y: model.north.originLocal.y + model.north.directionLocal.y * model.north.lengthMeters,
  };
  const points: LocalPoint[] = [...model.ringLocal, model.north.originLocal, northTip];
  if (model.setback.offsetRingLocal) points.push(...model.setback.offsetRingLocal);

  // Modest outward pad so dimension tags / north arrow have room without
  // letting DEM-bbox contours or street centerlines dominate the fit.
  const xs0 = points.map((p) => p.x);
  const ys0 = points.map((p) => p.y);
  const spanHint = Math.max(Math.max(...xs0) - Math.min(...xs0), Math.max(...ys0) - Math.min(...ys0), 1);
  const pad = spanHint * 0.18;
  points.push(
    { x: Math.min(...xs0) - pad, y: Math.min(...ys0) - pad },
    { x: Math.max(...xs0) + pad, y: Math.max(...ys0) + pad },
  );

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);

  const PADDING_FACTOR = 0.88;
  const scale = Math.min(box.width / spanX, box.height / spanY) * PADDING_FACTOR;
  const drawnWidth = spanX * scale;
  const drawnHeight = spanY * scale;
  const offsetX = box.x + (box.width - drawnWidth) / 2 - minX * scale;
  const offsetY = box.y + (box.height - drawnHeight) / 2 - minY * scale;
  return { scale, offsetX, offsetY };
}

/** §16 · margin leader: neutral-500 line from segment midpoint to a margin label. */
export interface SegmentLeader {
  /** 1-based segment index (S1..Sn). */
  seg: number;
  from: PageXY;
  to: PageXY;
  label: PlacedLabel;
}

/** §16 · sheet-2 segment table row for a tag that was shortened, moved or dropped. */
export interface SegmentTableRow {
  seg: string;
  bearing: string;
  distance: string;
  disposition: "distance only" | "margin leader" | "dropped";
}

export interface SitePlanDrawingLayout {
  transform: PdfTransform;
  /** Page points per foot at this transform (drawing-unit conversions). */
  ptPerFoot: number;
  propertyLine: PageXY[];
  /** @deprecated length-only midpoints — prefer `propertyLineTags` (B2). */
  dimensions: Array<{ mid: PageXY; lengthFeet: number }>;
  /** GIS-approximate tags, one per segment max, rotated to the segment (§4). */
  propertyLineTags: PlacedLabel[];
  propertyLineTagsHonesty: string;
  /** §16 margin leaders (cascade tier b). */
  segmentLeaders: SegmentLeader[];
  /** §16 sheet-2 rows for every shortened / moved / dropped tag. */
  segmentTable: SegmentTableRow[];
  setback: {
    offsetRing: PageXY[] | null;
    /** §15: false when degenerate or honest-absent — nothing envelope-shaped is drawn. */
    drawEnvelope: boolean;
    labels: PlacedLabel[];
    degenerate: boolean;
    degenerateReason?: string;
    /** Rule on file, front edge unresolved: nothing drawn, provisional (not degenerate). */
    frontEdgeUnresolved?: boolean;
  };
  /** §15 centred degenerate callout (title over ONE plain sentence), else null. */
  degenerateCallout: { anchor: PageXY; title: string; sentence: string; titleSize: number; sentenceSize: number } | null;
  /** Contours clipped to parcel vicinity for PDF readability (same model source). */
  contours: Array<{ elevation: number; points: PageXY[] }>;
  /** Contour elevation labels — one per contour, in the left margin (§4). */
  elevationLabels: PlacedLabel[];
  streets: {
    honestAbsence: boolean;
    reason?: string;
    anchors: Array<{
      name: string;
      points: PageXY[];
      leftEdge?: PageXY[];
      rightEdge?: PageXY[];
      rowProvenanceKind?: string;
      assumedWidthFt?: number;
      /** Collision-placed street name (omitted when dropped). */
      label?: PlacedLabel;
    }>;
  };
  north: { origin: PageXY; tip: PageXY };
  scaleBar: { start: PageXY; end: PageXY; lengthMeters: number };
  /** Optional on-drawing lot-area callout (collision-placed; may be dropped). */
  lotAreaCallout: PlacedLabel | null;
  /**
   * Centred BUILDABLE ENVELOPE callout (§9/§12): condensed-uppercase title
   * over a grey "{sq ft} · {pct}% of lot" qualifier at the envelope centroid.
   * Null when there is no drawable envelope or it is too narrow.
   */
  envelopeCallout: { anchor: PageXY; qualifier: string | null; titleSize: number; qualifierSize: number } | null;
  /** All labels that occupy collision space. */
  allPlacedLabels: PlacedLabel[];
}

function parcelVicinityClipBox(model: SitePlanModel): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const xs = model.ringLocal.map((p) => p.x);
  const ys = model.ringLocal.map((p) => p.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  // Same pad band as parcel-primary fit (~15–18%): context geometry stays
  // inside the sheet without expanding the transform.
  return expandRingAabb(model.ringLocal, span * 0.15);
}

function streetContextClipBox(model: SitePlanModel): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const xs = model.ringLocal.map((p) => p.x);
  const ys = model.ringLocal.map((p) => p.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  // Frontage centerlines sit outside the parcel ring (ROW). Clip to a local
  // buffer wide enough for that context; never the full multi-block OSM way.
  return expandRingAabb(model.ringLocal, Math.max(span * 0.5, 40));
}

interface LocalClipBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * §3 (v1.2) frame clip: context layers are confined to the drawing frame.
 * The page transform is affine and axis-aligned (positive scale, no
 * rotation), so the page-space frame rect maps EXACTLY to a local-ENU AABB —
 * intersecting each context layer's local clip box with that AABB guarantees
 * every projected point lands inside the frame, with no page-space pass.
 * Returns null when the boxes do not overlap (nothing survives the clip).
 */
function intersectClipBoxes(a: LocalClipBox, b: LocalClipBox): LocalClipBox | null {
  const minX = Math.max(a.minX, b.minX);
  const maxX = Math.min(a.maxX, b.maxX);
  const minY = Math.max(a.minY, b.minY);
  const maxY = Math.min(a.maxY, b.maxY);
  if (minX >= maxX || minY >= maxY) return null;
  return { minX, maxX, minY, maxY };
}

/** The page-space frame (label bounds) inverted into local-ENU metres. */
function frameToLocal(bounds: LabelBounds, transform: PdfTransform): LocalClipBox {
  return {
    minX: (bounds.minX - transform.offsetX) / transform.scale,
    maxX: (bounds.maxX - transform.offsetX) / transform.scale,
    minY: (bounds.minY - transform.offsetY) / transform.scale,
    maxY: (bounds.maxY - transform.offsetY) / transform.scale,
  };
}

function longestClippedPart(parts: Array<Array<[number, number]>>): Array<[number, number]> | null {
  let best: Array<[number, number]> | null = null;
  let bestLen = 0;
  for (const part of parts) {
    if (part.length < 2) continue;
    let len = 0;
    for (let i = 0; i < part.length - 1; i++) {
      const a = part[i]!;
      const b = part[i + 1]!;
      len += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (len > bestLen) {
      bestLen = len;
      best = part;
    }
  }
  return best;
}

function projectClippedLocalPolyline(
  transform: PdfTransform,
  points: LocalPoint[] | undefined,
  clipBox: { minX: number; maxX: number; minY: number; maxY: number },
): PageXY[] | undefined {
  if (!points || points.length < 2) return undefined;
  const tuples: Array<[number, number]> = points.map((p) => [p.x, p.y]);
  const longest = longestClippedPart(clipPolylineToAabb(tuples, clipBox));
  if (!longest) return undefined;
  return longest.map(([x, y]) => projectPoint(transform, { x, y }));
}

/** Street polylines use the wider ROW context clip (not the tight contour pad). */
function projectStreetPolylineClipped(
  transform: PdfTransform,
  points: LocalPoint[] | undefined,
  localClip: { minX: number; maxX: number; minY: number; maxY: number },
): PageXY[] | undefined {
  return projectClippedLocalPolyline(transform, points, localClip);
}

/**
 * Streets are context clipped to a parcel+ROW local buffer INTERSECTED with
 * the drawing frame (§3 v1.2) — never fit drivers, never over the header or
 * furniture. Frontage centerlines (outside the ring, inside ~40 m) survive;
 * distant bad attaches, multi-block OSM tails, and any portion outside the
 * frame clip away. §11 (v1.2): a road labels ONLY when it has a display name,
 * and the label is the NAME ALONE — the centerline / ROW-assumed qualifier
 * lives in the legend row, and machine road-node ids never print. At most
 * one label per named road, anchored on the visible (in-frame) portion of
 * its centerline, so a label can never sit outside the frame. Unnamed roads
 * still draw — honest context geometry, no label.
 */
function declutterStreets(
  model: SitePlanModel,
  transform: PdfTransform,
  frameLocal: LocalClipBox,
): {
  honestAbsence: boolean;
  reason?: string;
  anchors: Array<
    SitePlanDrawingLayout["streets"]["anchors"][number] & { _labelPoint?: PageXY; _labelText?: string }
  >;
} {
  const localClip = intersectClipBoxes(streetContextClipBox(model), frameLocal);
  const anchors: Array<
    SitePlanDrawingLayout["streets"]["anchors"][number] & { _labelPoint?: PageXY; _labelText?: string }
  > = [];
  const labeledNames = new Set<string>();
  for (const anchor of model.streets.anchors) {
    if (!localClip) continue;
    const points = projectStreetPolylineClipped(transform, anchor.pointsLocal, localClip);
    if (!points || points.length < 2) continue;
    const leftEdge = projectStreetPolylineClipped(transform, anchor.leftEdgeLocal, localClip);
    const rightEdge = projectStreetPolylineClipped(transform, anchor.rightEdgeLocal, localClip);
    // §11 (v1.2): display name or NO label. The visible-midpoint anchor keeps
    // the label on the in-frame portion of the centerline.
    const displayName = streetDisplayName(anchor.name);
    const labelKey = displayName?.toUpperCase();
    const wantsLabel = !!labelKey && !labeledNames.has(labelKey);
    const mid = points[Math.floor(points.length / 2)];
    if (wantsLabel && mid) labeledNames.add(labelKey!);
    anchors.push({
      name: anchor.name,
      points,
      leftEdge,
      rightEdge,
      rowProvenanceKind: anchor.rowProvenanceKind,
      assumedWidthFt: anchor.assumedWidthFt,
      _labelPoint: wantsLabel && mid ? mid : undefined,
      _labelText: wantsLabel && mid ? labelKey : undefined,
    });
  }
  return {
    honestAbsence: model.streets.honestAbsence,
    reason: model.streets.reason,
    anchors,
  };
}

function declutterContours(
  model: SitePlanModel,
  transform: PdfTransform,
  frameLocal: LocalClipBox,
): {
  contours: Array<{ elevation: number; points: PageXY[] }>;
  /** Leftmost projected point per labeled elevation (§4: left-margin labels). */
  leftmostByElevation: Map<number, PageXY>;
} {
  // Clip to the parcel-vicinity pad band INTERSECTED with the drawing frame
  // (§3 v1.2): decluttered contours can never spill past the frame into the
  // header or the furniture band.
  const clipBox = intersectClipBoxes(parcelVicinityClipBox(model), frameLocal);

  const contours: Array<{ elevation: number; points: PageXY[] }> = [];
  const leftmostByElevation = new Map<number, PageXY>();
  if (!clipBox) return { contours, leftmostByElevation };

  // Prefer every-other unique elevation so labels stay sparse on the sheet.
  const uniqueElevations = [...new Set(model.contours.map((c) => c.elevation))].sort((a, b) => a - b);
  const labeledElevations = new Set(uniqueElevations.filter((_, i) => i % 2 === 0).slice(0, 5));

  for (const polyline of model.contours) {
    const clippedParts = clipPolylineToAabb(polyline.points, clipBox);
    for (const part of clippedParts) {
      if (part.length < 2) continue;
      const projected = part.map(([x, y]) => projectPoint(transform, { x, y }));
      contours.push({ elevation: polyline.elevation, points: projected });
      if (labeledElevations.has(polyline.elevation)) {
        let leftmost = projected[0]!;
        for (const p of projected) if (p.x < leftmost.x) leftmost = p;
        const existing = leftmostByElevation.get(polyline.elevation);
        if (!existing || leftmost.x < existing.x) leftmostByElevation.set(polyline.elevation, leftmost);
      }
    }
  }

  return { contours, leftmostByElevation };
}

/**
 * North arrow anchored top-right INSIDE the drawing box (§9), with its
 * direction taken from the model's north vector projected through the page
 * transform — so a non-axis-aligned local frame still points true north.
 */
function northArrowTopRight(
  model: SitePlanModel,
  transform: PdfTransform,
  box: DrawingBox,
): { origin: PageXY; tip: PageXY } {
  const originLocal = model.north.originLocal;
  const tipLocal: LocalPoint = {
    x: originLocal.x + model.north.directionLocal.x,
    y: originLocal.y + model.north.directionLocal.y,
  };
  const pOrigin = projectPoint(transform, originLocal);
  const pTip = projectPoint(transform, tipLocal);
  let dx = pTip.x - pOrigin.x;
  let dy = pTip.y - pOrigin.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const arrowLen = Math.min(box.width, box.height) * 0.09;
  // Top-right corner, inset from the box edges.
  const inset = arrowLen + 8;
  const tip: PageXY = { x: box.x + box.width - inset, y: box.y + box.height - inset + arrowLen };
  const origin: PageXY = { x: tip.x - dx * arrowLen, y: tip.y - dy * arrowLen };
  return { origin, tip };
}

export interface BuildLayoutOptions {
  /**
   * Prefer pdf-lib `font.widthOfTextAtSize`. Defaults to Helvetica-ish estimate
   * for pure unit tests; production emit must pass measured widths.
   */
  measureText?: MeasureTextFn;
  /** When true (default), place an on-drawing lot-area callout if it clears. */
  includeLotAreaCallout?: boolean;
  /**
   * Page-space rectangle every label box must stay inside — the printable
   * sheet. A placement that would leave it is dropped rather than drawn
   * off-sheet. Defaults to the drawing box expanded by a modest margin.
   */
  sheetBounds?: LabelBounds;
}

// ─────────────────────────────────────────────────────────────────────────
// Rotated edge-label placement (§4): the label runs along the segment,
// centred on the midpoint, offset along the normal. The collision box is the
// AABB of the rotated rect. Font size is FIXED (§13 floor) — the cascade
// changes the label's FORM, never shrinks it below the floor.
// ─────────────────────────────────────────────────────────────────────────
interface RotatedPlacementCandidate {
  drawAt: PageXY;
  anchor: PageXY;
  box: { x: number; y: number; width: number; height: number };
  rotationDeg: number;
}

function rotatedEdgeCandidate(
  midPage: PageXY,
  dirPage: { x: number; y: number },
  normalPage: { x: number; y: number },
  offsetPts: number,
  width: number,
  fontSize: number,
): RotatedPlacementCandidate {
  // Normalize direction; keep text upright.
  let angle = Math.atan2(dirPage.y, dirPage.x);
  if (angle > Math.PI / 2) angle -= Math.PI;
  else if (angle <= -Math.PI / 2) angle += Math.PI;
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const v = { x: -Math.sin(angle), y: Math.cos(angle) };
  const h = fontSize;
  const center = { x: midPage.x + normalPage.x * offsetPts, y: midPage.y + normalPage.y * offsetPts };
  const drawAt = {
    x: center.x - u.x * (width / 2) - v.x * (h / 3),
    y: center.y - u.y * (width / 2) - v.y * (h / 3),
  };
  const corners = [
    drawAt,
    { x: drawAt.x + u.x * width, y: drawAt.y + u.y * width },
    { x: drawAt.x + u.x * width + v.x * h, y: drawAt.y + u.y * width + v.y * h },
    { x: drawAt.x + v.x * h, y: drawAt.y + v.y * h },
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const box = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
  return { drawAt, anchor: center, box, rotationDeg: (angle * 180) / Math.PI };
}

function boxFree(
  box: { x: number; y: number; width: number; height: number },
  occupied: readonly PlacedLabel[],
  bounds: LabelBounds,
  pad = 2,
): boolean {
  if (
    box.x < bounds.minX ||
    box.y < bounds.minY ||
    box.x + box.width > bounds.maxX ||
    box.y + box.height > bounds.maxY
  ) {
    return false;
  }
  return !occupied.some(
    (p) =>
      !(
        box.x + box.width + pad < p.box.x ||
        p.box.x + p.box.width + pad < box.x ||
        box.y + box.height + pad < p.box.y ||
        p.box.y + p.box.height + pad < box.y
      ),
  );
}

function segmentsIntersect(a1: PageXY, a2: PageXY, b1: PageXY, b2: PageXY): boolean {
  const d = (p: PageXY, q: PageXY, r: PageXY): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Builds the full page-space drawing layout from the shared model. Pure
 * function: same model + same box always yields the same page points.
 */
export function buildSitePlanDrawingLayout(
  model: SitePlanModel,
  box: DrawingBox,
  options: BuildLayoutOptions = {},
): SitePlanDrawingLayout {
  const measureText = options.measureText ?? estimateTextWidth;
  const includeLotAreaCallout = options.includeLotAreaCallout !== false;
  const transform = computeDrawingTransform(model, box);
  const ptPerFoot = transform.scale * METERS_PER_FOOT;
  const ringCcw = ringSignedAreaLocal(model.ringLocal) > 0;
  const occupied: PlacedLabel[] = [];

  // Sheet clamp: labels may sit in the drawing margins (bearing tags outside
  // the ring), but never off the printable sheet.
  const bounds: LabelBounds = options.sheetBounds ?? {
    minX: box.x - box.width * 0.35,
    minY: box.y - box.height * 0.2,
    maxX: box.x + box.width * 1.35,
    maxY: box.y + box.height * 1.2,
  };

  const dimensions = model.propertySegments.map((segment) => ({
    mid: projectPoint(transform, { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 }),
    lengthFeet: segment.lengthFeet,
  }));

  // ── §4 + §16: property-line tag cascade, keyed by segment id (§14) ──────
  const tagFont = TYPE.drawingTag;
  const propertyLineTags: PlacedLabel[] = [];
  const segmentTable: SegmentTableRow[] = [];
  const leaderRequests: Array<{ seg: number; midPage: PageXY; distanceText: string; bearing: string }> = [];
  const ringPage = projectRing(transform, model.ringLocal);

  model.propertySegments.forEach((segment, i) => {
    const segNo = i + 1;
    const midLocal = { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
    const midPage = projectPoint(transform, midLocal);
    const aPage = projectPoint(transform, segment.a);
    const bPage = projectPoint(transform, segment.b);
    const dirPage = { x: bPage.x - aPage.x, y: bPage.y - aPage.y };
    const edgeLenPage = Math.hypot(dirPage.x, dirPage.y);
    const n = outwardNormal(segment.a, segment.b, ringCcw);
    const bearing = formatGisBearing(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
    const distanceText = formatFeetPrime(segment.lengthFeet, 1);
    const fullText = `${distanceText} · ${bearing}`;

    const forms: Array<{ text: string; disposition: SegmentTableRow["disposition"] | null }> = [
      { text: fullText, disposition: null },
      { text: distanceText, disposition: "distance only" },
    ];

    for (const form of forms) {
      const width = measureText(form.text, tagFont);
      // A form must fit along its edge to be centred on it (§4).
      if (width > edgeLenPage * 0.95) continue;
      let placed: PlacedLabel | null = null;
      for (const k of [0.9, 1.6, 2.4]) {
        const cand = rotatedEdgeCandidate(midPage, dirPage, n, tagFont * k, width, tagFont);
        if (boxFree(cand.box, occupied, bounds)) {
          placed = {
            text: form.text,
            anchor: cand.anchor,
            drawAt: cand.drawAt,
            box: cand.box,
            fontSize: tagFont,
            rotationDeg: cand.rotationDeg,
            textWidth: width,
            seg: segNo,
          };
          break;
        }
      }
      if (placed) {
        occupied.push(placed);
        propertyLineTags.push(placed);
        if (form.disposition) {
          segmentTable.push({ seg: `S${segNo}`, bearing, distance: distanceText, disposition: form.disposition });
        }
        return;
      }
    }
    // Tier (b): request a margin leader; resolved after all segments so
    // same-side leaders stack in midpoint order and never cross (§16).
    leaderRequests.push({ seg: segNo, midPage, distanceText, bearing });
  });

  // ── §16 margin leaders ──────────────────────────────────────────────────
  const segmentLeaders: SegmentLeader[] = [];
  const leaderFont = TYPE.drawingLeader;
  const boxCenterX = box.x + box.width / 2;
  for (const side of ["left", "right"] as const) {
    const requests = leaderRequests
      .filter((r) => (side === "left" ? r.midPage.x <= boxCenterX : r.midPage.x > boxCenterX))
      .sort((a, b) => a.midPage.y - b.midPage.y);
    for (const req of requests) {
      const text = `S${req.seg} · ${req.distanceText}`;
      const width = measureText(text, leaderFont);
      const h = leaderFont + 1;
      const x = side === "left" ? bounds.minX : bounds.maxX - width;
      let placed: PlacedLabel | null = null;
      for (let step = 0; step < 14 && !placed; step++) {
        const dy = (step % 2 === 0 ? 1 : -1) * Math.ceil(step / 2) * (h + 4);
        const y = Math.min(Math.max(req.midPage.y - h / 3 + dy, bounds.minY), bounds.maxY - h);
        const cand = { x, y, width, height: h };
        if (!boxFree(cand, occupied, bounds)) continue;
        const to: PageXY =
          side === "left" ? { x: x + width + 2, y: y + h / 3 } : { x: x - 2, y: y + h / 3 };
        // Leaders never cross the ring (§16) — check against every ring edge
        // except the one the midpoint sits on.
        let crosses = false;
        for (let e = 0; e < ringPage.length; e++) {
          if (e === req.seg - 1) continue;
          const p1 = ringPage[e]!;
          const p2 = ringPage[(e + 1) % ringPage.length]!;
          if (segmentsIntersect(req.midPage, to, p1, p2)) {
            crosses = true;
            break;
          }
        }
        // Leaders never cross each other (§16).
        if (!crosses) {
          for (const other of segmentLeaders) {
            if (segmentsIntersect(req.midPage, to, other.from, other.to)) {
              crosses = true;
              break;
            }
          }
        }
        if (crosses) continue;
        placed = {
          text,
          anchor: { x: x + width / 2, y: y + h / 3 },
          drawAt: { x, y },
          box: cand,
          fontSize: leaderFont,
          textWidth: width,
          seg: req.seg,
        };
        occupied.push(placed);
        segmentLeaders.push({ seg: req.seg, from: req.midPage, to, label: placed });
        segmentTable.push({
          seg: `S${req.seg}`,
          bearing: req.bearing,
          distance: req.distanceText,
          disposition: "margin leader",
        });
      }
      if (!placed) {
        // Tier (c): drop from the drawing, tabulate on sheet 2 (§16 — a
        // dropped tag with no table row is a defect).
        segmentTable.push({
          seg: `S${req.seg}`,
          bearing: req.bearing,
          distance: req.distanceText,
          disposition: "dropped",
        });
      }
    }
  }

  // ── Setback layer (§4, §15) ─────────────────────────────────────────────
  const degenerate = model.setback.degenerate;
  const honestAbsence = model.setback.honestAbsence === true;
  const drawEnvelope = !!model.setback.offsetRingLocal && !degenerate && !honestAbsence;

  const setbackFont = TYPE.drawingSetback;
  const setbackLabels: PlacedLabel[] = [];
  if (drawEnvelope) {
    const seenRoleValue = new Set<string>();
    for (const segment of model.setback.segments) {
      // §11: no machine tokens on the sheet — side_corner reads "SIDE (CORNER)".
      const roleUpper = segment.role === "side_corner" ? "SIDE (CORNER)" : segment.role.toUpperCase();
      let text: string;
      if (segment.notSpecified) {
        const key = `ns:${segment.role}`;
        if (seenRoleValue.has(key)) continue;
        seenRoleValue.add(key);
        text = `${roleUpper} NOT SPECIFIED`;
      } else if (segment.role === "unassigned") {
        const key = `setback:${segment.distanceFt}`;
        const typ = seenRoleValue.has(key);
        seenRoleValue.add(key);
        if (typ) continue; // one label per unique value (§4)
        text = `SETBACK ${formatFeetPrime(segment.distanceFt)} (TYP.)`;
      } else {
        const key = `${segment.role}:${segment.distanceFt}`;
        const typ = seenRoleValue.has(key);
        seenRoleValue.add(key);
        text =
          segment.role === "front"
            ? `FRONT SETBACK ${formatFeetPrime(segment.distanceFt)}`
            : `${roleUpper} ${formatFeetPrime(segment.distanceFt)}${typ ? " (TYP.)" : ""}`;
      }

      const midLocal = { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
      const midPage = projectPoint(transform, midLocal);
      const aPage = projectPoint(transform, segment.a);
      const bPage = projectPoint(transform, segment.b);
      const dirPage = { x: bPage.x - aPage.x, y: bPage.y - aPage.y };
      const edgeLenPage = Math.hypot(dirPage.x, dirPage.y);
      // §4: suppress any label on an edge shorter than 3× the label (height).
      if (edgeLenPage < setbackFont * 3) continue;
      const width = measureText(text, setbackFont);
      if (width > edgeLenPage * 0.95) continue;
      const outward = outwardNormal(segment.a, segment.b, ringCcw);
      const inward = { x: -outward.x, y: -outward.y };
      // §4: the label must clear the dash it labels — if the ring-to-envelope
      // gap is narrower than the label, place it inside the envelope.
      const gapPts = (segment.notSpecified ? 0 : segment.distanceFt) * ptPerFoot;
      const offsetPts = gapPts < setbackFont * 1.6 ? gapPts + setbackFont * 1.4 : gapPts / 2;
      let placed: PlacedLabel | null = null;
      for (const extra of [0, setbackFont, setbackFont * 2]) {
        const cand = rotatedEdgeCandidate(midPage, dirPage, inward, offsetPts + extra, width, setbackFont);
        if (boxFree(cand.box, occupied, bounds)) {
          placed = {
            text,
            anchor: cand.anchor,
            drawAt: cand.drawAt,
            box: cand.box,
            fontSize: setbackFont,
            rotationDeg: cand.rotationDeg,
            textWidth: width,
            seg: undefined,
          };
          break;
        }
      }
      if (placed) {
        occupied.push(placed);
        setbackLabels.push(placed);
      }
    }
  }

  // Same origin + +x direction the DXF worker draws the scale bar with.
  const scaleBarStart: LocalPoint = {
    x: model.north.originLocal.x,
    y: model.north.originLocal.y - model.north.lengthMeters * 0.5,
  };
  const scaleBarEnd: LocalPoint = {
    x: scaleBarStart.x + model.scaleBar.lengthMeters,
    y: scaleBarStart.y,
  };

  // §3 (v1.2): every context layer clips to the drawing frame. `bounds` IS
  // the frame (render passes the exact frame rect as sheetBounds).
  const frameLocal = frameToLocal(bounds, transform);
  const decluttered = declutterContours(model, transform, frameLocal);
  const streetsRaw = declutterStreets(model, transform, frameLocal);

  // ── §15 degenerate / unresolved callout — reserved BEFORE street and
  // contour labels so the centred honest statement is never overprinted ────
  const ringCentroid = ringCentroidLocalPts(model.ringLocal);
  const calloutTitleSize = Math.min(Math.max(5.6 * ptPerFoot, 11), 16);
  // §13 type band + §3 frame clip (v1.2): the qualifier/sentence is CAPPED at
  // a 13px body size — on a tiny high-scale parcel the uncapped 3.1·ptPerFoot
  // grew past 30 pt and the centred §15 sentence bled through both margins.
  const calloutQualifierSize = Math.min(Math.max(3.1 * ptPerFoot, TYPE.drawingContour), pt(13));

  let degenerateCallout: SitePlanDrawingLayout["degenerateCallout"] = null;
  let envelopeCallout: SitePlanDrawingLayout["envelopeCallout"] = null;
  let lotAreaCallout: PlacedLabel | null = null;

  const frontEdgeUnresolved = model.setback.frontEdgeUnresolved === true;
  if (degenerate || frontEdgeUnresolved) {
    const anchor = projectPoint(transform, ringCentroid);
    // §15 family: nothing envelope-shaped is drawn; the centred callout says
    // why in ONE plain sentence. Degenerate (offset collapsed) and unresolved
    // (front edge not resolved; nothing guessed) are distinct honest states.
    const title = degenerate ? "NO BUILDABLE ENVELOPE" : "SETBACKS NOT DRAWN";
    degenerateCallout = {
      anchor,
      title,
      sentence: degenerate ? REASON.setbacksConsumeLot : REASON.frontEdgeUnresolved,
      titleSize: calloutTitleSize,
      sentenceSize: calloutQualifierSize,
    };
    const titleWidth = measureText(title, calloutTitleSize);
    occupied.push({
      text: title,
      anchor,
      drawAt: { x: anchor.x - titleWidth / 2, y: anchor.y - calloutTitleSize },
      box: {
        x: anchor.x - titleWidth / 2,
        y: anchor.y - calloutTitleSize - calloutQualifierSize - 6,
        width: titleWidth,
        height: calloutTitleSize + calloutQualifierSize + 10,
      },
      fontSize: calloutTitleSize,
      textWidth: titleWidth,
    });
  }

  // Street labels through the same collision set (never bypass). §11 (v1.2):
  // the label anchors along the VISIBLE (frame-clipped) portion of the
  // centerline — candidate points at fractions of the clipped polyline, so a
  // road crowded at its midpoint still labels where it has room, always
  // inside the frame.
  const streetAnchors = streetsRaw.anchors.map((a) => {
    const { _labelPoint: labelPoint, _labelText: labelText, ...rest } = a;
    if (!labelPoint || !labelText) return rest;
    const candidates = [0.5, 0.35, 0.65, 0.2, 0.8, 0.08, 0.92].map((f) =>
      pointAlongPolyline(rest.points, f),
    );
    for (const candidate of candidates) {
      const placed = placeNonCollidingPointLabels(
        [{ point: candidate, text: labelText, fontSize: TYPE.drawingStreet }],
        { measureText, occupied, pageScale: transform.scale, bounds, minFontSize: TYPE.drawingStreet },
      );
      if (placed[0]) return { ...rest, label: placed[0] };
    }
    // Last resort before dropping a NAMED road's label (a named road with an
    // in-frame stub must label): widen the spiral search around the visible
    // run's midpoint. The label rides a paper halo at draw time, and streets
    // place before contour labels in the shared collision set — dropping is
    // the final fallback only.
    const lastResort = placeNonCollidingPointLabels(
      [{ point: pointAlongPolyline(rest.points, 0.5), text: labelText, fontSize: TYPE.drawingStreet }],
      {
        measureText,
        occupied,
        pageScale: transform.scale,
        bounds,
        minFontSize: TYPE.drawingStreet,
        maxNudgeIterations: 28,
      },
    );
    if (lastResort[0]) return { ...rest, label: lastResort[0] };
    return rest;
  });

  // Contour labels: one per contour, in the LEFT MARGIN (§4), formatted with
  // a space and "m" (§12), through the shared collision set.
  const contourFont = TYPE.drawingContour;
  const elevationItems = [...decluttered.leftmostByElevation.entries()].map(([elevation, leftmost]) => {
    const text = formatMeters(elevation);
    const width = measureText(text, contourFont);
    return {
      point: { x: bounds.minX + width / 2 + 2, y: leftmost.y },
      text,
      fontSize: contourFont,
    };
  });
  const elevationLabels = placeNonCollidingPointLabels(elevationItems, {
    measureText,
    occupied,
    pageScale: transform.scale,
    bounds,
    minFontSize: contourFont,
  });

  // ── §9 envelope callout (drawable case; §15 callout reserved above) ─────
  if (!degenerateCallout && includeLotAreaCallout && drawEnvelope && model.setback.offsetRingLocal!.length >= 3) {
    const offsetRingLocal = model.setback.offsetRingLocal!;
    const envCentroid = ringCentroidLocalPts(offsetRingLocal);
    const anchor = projectPoint(transform, envCentroid);
    const envPage = offsetRingLocal.map((p) => projectPoint(transform, p));
    const envXs = envPage.map((p) => p.x);
    const envWidthPage = Math.max(...envXs) - Math.min(...envXs);
    const titleText = "BUILDABLE ENVELOPE";
    const titleWidth = measureText(titleText, calloutTitleSize);
    // §9: suppress if the envelope is narrower than the callout needs.
    if (envWidthPage >= titleWidth * 1.05) {
      const pct =
        Number.isFinite(model.summary.lotAreaSqFt) &&
        model.summary.lotAreaSqFt > 0 &&
        model.summary.buildableAreaSqFt != null
          ? Math.round((model.summary.buildableAreaSqFt / model.summary.lotAreaSqFt) * 100)
          : null;
      const qualifier =
        model.summary.buildableAreaSqFt != null
          ? `${formatSqFt(model.summary.buildableAreaSqFt)}${pct != null ? ` · ${pct}% of lot` : ""}`
          : null;
      envelopeCallout = { anchor, qualifier, titleSize: calloutTitleSize, qualifierSize: calloutQualifierSize };
      const blockH = calloutTitleSize + calloutQualifierSize + 6;
      occupied.push({
        text: titleText,
        anchor,
        drawAt: { x: anchor.x - titleWidth / 2, y: anchor.y - calloutTitleSize },
        box: { x: anchor.x - titleWidth / 2, y: anchor.y - calloutTitleSize, width: titleWidth, height: blockH },
        fontSize: calloutTitleSize,
        textWidth: titleWidth,
      });
    }
  }
  // Fallback lot-area callout (kept for callers/tests that read it) only when
  // no envelope/degenerate callout was drawn (§12: thousands separator).
  if (!envelopeCallout && !degenerateCallout && includeLotAreaCallout && Number.isFinite(model.summary.lotAreaSqFt)) {
    const placed = placeNonCollidingPointLabels(
      [
        {
          point: projectPoint(transform, ringCentroid),
          text: formatSqFt(model.summary.lotAreaSqFt),
          fontSize: calloutQualifierSize,
        },
      ],
      { measureText, occupied, pageScale: transform.scale, minFontSize: calloutQualifierSize },
    );
    lotAreaCallout = placed[0] ?? null;
  }

  return {
    transform,
    ptPerFoot,
    propertyLine: ringPage,
    dimensions,
    propertyLineTags,
    propertyLineTagsHonesty: PROPERTY_LINE_TAGS_HONESTY,
    segmentLeaders,
    segmentTable,
    setback: {
      offsetRing: model.setback.offsetRingLocal ? projectRing(transform, model.setback.offsetRingLocal) : null,
      drawEnvelope,
      labels: setbackLabels,
      degenerate,
      degenerateReason: model.setback.degenerateReason,
      frontEdgeUnresolved,
    },
    degenerateCallout,
    contours: decluttered.contours,
    elevationLabels,
    streets: {
      honestAbsence: streetsRaw.honestAbsence,
      reason: streetsRaw.reason,
      anchors: streetAnchors,
    },
    north: northArrowTopRight(model, transform, box),
    scaleBar: {
      start: projectPoint(transform, scaleBarStart),
      end: projectPoint(transform, scaleBarEnd),
      lengthMeters: model.scaleBar.lengthMeters,
    },
    lotAreaCallout,
    envelopeCallout,
    allPlacedLabels: [...occupied],
  };
}

/** Point at fraction `f` (0..1) of a polyline's arc length (page space). */
function pointAlongPolyline(points: PageXY[], f: number): PageXY {
  if (points.length === 1) return points[0]!;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(len);
    total += len;
  }
  if (total <= 0) return points[0]!;
  let target = Math.min(Math.max(f, 0), 1) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i]! || i === lengths.length - 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const t = lengths[i]! > 0 ? target / lengths[i]! : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    target -= lengths[i]!;
  }
  return points[points.length - 1]!;
}

/** Centroid of a local-ENU ring (closing vertex tolerated). */
function ringCentroidLocalPts(ring: LocalPoint[]): LocalPoint {
  if (ring.length === 0) return { x: 0, y: 0 };
  const closed =
    ring.length > 1 && ring[0]!.x === ring[ring.length - 1]!.x && ring[0]!.y === ring[ring.length - 1]!.y;
  const n = closed ? ring.length - 1 : ring.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += ring[i]!.x;
    sy += ring[i]!.y;
  }
  return { x: sx / Math.max(n, 1), y: sy / Math.max(n, 1) };
}
