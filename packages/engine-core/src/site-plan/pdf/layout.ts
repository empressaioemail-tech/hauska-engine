import type { LocalPoint } from "../ring-geometry.js";
import type { SitePlanModel } from "../site-model.js";
import {
  PROPERTY_LINE_TAGS_HONESTY,
  clipPolylineToAabb,
  expandRingAabb,
  formatPropertyLineTag,
  placeNonCollidingEdgeLabels,
  ringSignedAreaLocal,
  type PlacedLabel,
} from "./annotation-placement.js";

/**
 * Page-space projection derived purely from the shared `SitePlanModel` — the
 * PDF drawing renders the SAME ring/setback/contour/street points every
 * DXF/IFC entity is built from (WDLL 5/6: CAD and PDF cannot diverge). No
 * function in this file re-derives geometry; it only maps the model's
 * local-ENU metre coordinates into a page-space rectangle and applies
 * emit-craft (label placement, contour declutter for readability).
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

export function projectPoint(transform: PdfTransform, point: LocalPoint): PageXY {
  return { x: transform.offsetX + point.x * transform.scale, y: transform.offsetY + point.y * transform.scale };
}

function projectRing(transform: PdfTransform, ring: LocalPoint[]): PageXY[] {
  return ring.map((p) => projectPoint(transform, p));
}

/**
 * Parcel-primary fit (Track B2 design pass): scale so PROPERTY_LINE + SETBACK
 * + STREET + north/scale dominate the sheet. Contours are decluttered (clipped
 * to a parcel buffer) rather than allowed to shrink the parcel into spaghetti.
 * Model geometry is unchanged — CAD emitters still see full DEM contours.
 */
export function computeDrawingTransform(model: SitePlanModel, box: DrawingBox): PdfTransform {
  const northTip: LocalPoint = {
    x: model.north.originLocal.x + model.north.directionLocal.x * model.north.lengthMeters,
    y: model.north.originLocal.y + model.north.directionLocal.y * model.north.lengthMeters,
  };
  const points: LocalPoint[] = [...model.ringLocal, model.north.originLocal, northTip];
  if (model.setback.offsetRingLocal) points.push(...model.setback.offsetRingLocal);
  for (const anchor of model.streets.anchors) {
    points.push(...anchor.pointsLocal);
    if (anchor.leftEdgeLocal) points.push(...anchor.leftEdgeLocal);
    if (anchor.rightEdgeLocal) points.push(...anchor.rightEdgeLocal);
  }

  // Modest outward pad so dimension tags / north arrow have room without
  // letting DEM-bbox contours dominate the fit (pre-B2 failure mode).
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

export interface SitePlanDrawingLayout {
  transform: PdfTransform;
  propertyLine: PageXY[];
  /** @deprecated length-only midpoints — prefer `propertyLineTags` (B2). */
  dimensions: Array<{ mid: PageXY; lengthFeet: number }>;
  /** GIS-approximate bearing + distance tags with non-colliding placement. */
  propertyLineTags: PlacedLabel[];
  propertyLineTagsHonesty: string;
  setback: {
    offsetRing: PageXY[] | null;
    labels: PlacedLabel[];
    degenerate: boolean;
    degenerateReason?: string;
  };
  /** Contours clipped to parcel vicinity for PDF readability (same model source). */
  contours: Array<{ elevation: number; points: PageXY[] }>;
  elevationLabels: Array<{ point: PageXY; elevationMeters: number; role: "corner" | "contour" }>;
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
    }>;
  };
  north: { origin: PageXY; tip: PageXY };
  scaleBar: { start: PageXY; end: PageXY; lengthMeters: number };
}

function declutterContours(
  model: SitePlanModel,
  transform: PdfTransform,
): {
  contours: Array<{ elevation: number; points: PageXY[] }>;
  elevationLabels: SitePlanDrawingLayout["elevationLabels"];
} {
  const span = (() => {
    const xs = model.ringLocal.map((p) => p.x);
    const ys = model.ringLocal.map((p) => p.y);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  })();
  // Clip to the same pad band the parcel-primary fit uses (~18%), so decluttered
  // contours stay inside the drawing box rather than spilling past the sheet.
  const clipBox = expandRingAabb(model.ringLocal, span * 0.15);

  const contours: Array<{ elevation: number; points: PageXY[] }> = [];
  const contourLabelCandidates: Array<{ point: PageXY; elevationMeters: number; role: "contour" }> = [];

  // Prefer every-other unique elevation so labels stay sparse on the sheet.
  const uniqueElevations = [...new Set(model.contours.map((c) => c.elevation))].sort((a, b) => a - b);
  const labeledElevations = new Set(
    uniqueElevations.filter((_, i) => i % 2 === 0).slice(0, 5),
  );

  for (const polyline of model.contours) {
    const clippedParts = clipPolylineToAabb(polyline.points, clipBox);
    for (const part of clippedParts) {
      if (part.length < 2) continue;
      const projected = part.map(([x, y]) => projectPoint(transform, { x, y }));
      contours.push({ elevation: polyline.elevation, points: projected });
      if (labeledElevations.has(polyline.elevation) && part.length > 0) {
        const mid = part[Math.floor(part.length / 2)]!;
        contourLabelCandidates.push({
          point: projectPoint(transform, { x: mid[0], y: mid[1] }),
          elevationMeters: polyline.elevation,
          role: "contour",
        });
      }
    }
  }

  // One label per elevation max.
  const seenElev = new Set<number>();
  const sparseContourLabels = contourLabelCandidates.filter((l) => {
    if (seenElev.has(l.elevationMeters)) return false;
    seenElev.add(l.elevationMeters);
    return true;
  });

  const cornerLabels = model.elevationLabels
    .filter((l) => l.role === "corner")
    .map((label) => ({
      point: projectPoint(transform, label.point),
      elevationMeters: label.elevationMeters,
      role: "corner" as const,
    }));

  return {
    contours,
    elevationLabels: [...cornerLabels, ...sparseContourLabels],
  };
}

/**
 * Builds the full page-space drawing layout from the shared model. Pure
 * function: same model + same box always yields the same page points,
 * which is what lets a test assert PDF drawing coordinates trace back to
 * the model (WDLL dispatch item 6: "if you can assert drawing coords match
 * model ... do so").
 */
export function buildSitePlanDrawingLayout(model: SitePlanModel, box: DrawingBox): SitePlanDrawingLayout {
  const transform = computeDrawingTransform(model, box);
  const ringCcw = ringSignedAreaLocal(model.ringLocal) > 0;

  const dimensions = model.propertySegments.map((segment) => ({
    mid: projectPoint(transform, { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 }),
    lengthFeet: segment.lengthFeet,
  }));

  const propertyLineTags = placeNonCollidingEdgeLabels(
    model.propertySegments.map((segment) => ({
      midLocal: { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 },
      a: segment.a,
      b: segment.b,
      text: formatPropertyLineTag(segment),
      fontSize: 7,
    })),
    (p) => projectPoint(transform, p),
    { ringCcw, outwardMeters: Math.max(1.2, (1 / transform.scale) * 10), pageScale: transform.scale },
  );

  const silentAxes = !!(
    model.setback.notSpecified?.front ||
    model.setback.notSpecified?.side ||
    model.setback.notSpecified?.rear
  );
  const setbackLabelItems = model.setback.segments
    .map((segment, index) => {
      const notSpecified = !!segment.notSpecified;
      let text: string;
      if (notSpecified) {
        text = `${segment.role.toUpperCase()} not specified — build-to-line governs`;
      } else if (segment.role === "unassigned" && silentAxes) {
        text = index === 0 ? model.setback.displayLine : "";
      } else {
        text = `${segment.role.toUpperCase()} ${segment.distanceFt}'`;
      }
      if (!text) return null;
      return {
        midLocal: { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 },
        a: segment.a,
        b: segment.b,
        text,
        fontSize: 7,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  // Setback labels sit inward (toward envelope) so they don't collide with
  // outward property-line tags — invert ringCcw for inward placement.
  const setbackLabels = placeNonCollidingEdgeLabels(
    setbackLabelItems,
    (p) => projectPoint(transform, p),
    {
      ringCcw: !ringCcw,
      outwardMeters: Math.max(0.8, (1 / transform.scale) * 8),
      pageScale: transform.scale,
    },
  );

  const northTip: LocalPoint = {
    x: model.north.originLocal.x + model.north.directionLocal.x * model.north.lengthMeters,
    y: model.north.originLocal.y + model.north.directionLocal.y * model.north.lengthMeters,
  };
  // Same origin + +x direction the DXF worker draws the scale bar with
  // (`request.scaleBar.origin` / `lengthMeters` in emitters.ts) — kept in
  // sync by construction, not re-derived independently.
  const scaleBarStart: LocalPoint = {
    x: model.north.originLocal.x,
    y: model.north.originLocal.y - model.north.lengthMeters * 0.5,
  };
  const scaleBarEnd: LocalPoint = {
    x: scaleBarStart.x + model.scaleBar.lengthMeters,
    y: scaleBarStart.y,
  };

  const decluttered = declutterContours(model, transform);

  return {
    transform,
    propertyLine: projectRing(transform, model.ringLocal),
    dimensions,
    propertyLineTags,
    propertyLineTagsHonesty: PROPERTY_LINE_TAGS_HONESTY,
    setback: {
      offsetRing: model.setback.offsetRingLocal ? projectRing(transform, model.setback.offsetRingLocal) : null,
      labels: setbackLabels,
      degenerate: model.setback.degenerate,
      degenerateReason: model.setback.degenerateReason,
    },
    contours: decluttered.contours,
    elevationLabels: decluttered.elevationLabels,
    streets: {
      honestAbsence: model.streets.honestAbsence,
      reason: model.streets.reason,
      anchors: model.streets.anchors.map((anchor) => ({
        name: anchor.name,
        points: projectRing(transform, anchor.pointsLocal),
        leftEdge: anchor.leftEdgeLocal
          ? projectRing(transform, anchor.leftEdgeLocal)
          : undefined,
        rightEdge: anchor.rightEdgeLocal
          ? projectRing(transform, anchor.rightEdgeLocal)
          : undefined,
        rowProvenanceKind: anchor.rowProvenanceKind,
        assumedWidthFt: anchor.assumedWidthFt,
      })),
    },
    north: { origin: projectPoint(transform, model.north.originLocal), tip: projectPoint(transform, northTip) },
    scaleBar: {
      start: projectPoint(transform, scaleBarStart),
      end: projectPoint(transform, scaleBarEnd),
      lengthMeters: model.scaleBar.lengthMeters,
    },
  };
}
