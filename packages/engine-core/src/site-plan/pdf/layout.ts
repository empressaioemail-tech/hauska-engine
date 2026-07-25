import type { LocalPoint } from "../ring-geometry.js";
import type { SitePlanModel } from "../site-model.js";

/**
 * Page-space projection derived purely from the shared `SitePlanModel` — the
 * PDF drawing renders the SAME ring/setback/contour/street points every
 * DXF/IFC entity is built from (WDLL 5/6: CAD and PDF cannot diverge). No
 * function in this file re-derives geometry; it only maps the model's
 * local-ENU metre coordinates into a page-space rectangle.
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
 * Fits the model's full drawn extent (ring + setback offset + contour +
 * street + north arrow reach) into `box` with uniform scale (no axis
 * distortion) and 10% margin, centered. Same fit logic regardless of parcel
 * shape or size. Contours are DEM-bbox-derived and can legitimately extend
 * beyond the parcel ring, so they must contribute to these bounds or CONTOUR
 * geometry silently clips/mis-scales relative to the DXF/IFC emitters that
 * draw the same points at full extent (planner HOLD-2, 2026-07-25).
 */
export function computeDrawingTransform(model: SitePlanModel, box: DrawingBox): PdfTransform {
  const northTip: LocalPoint = {
    x: model.north.originLocal.x + model.north.directionLocal.x * model.north.lengthMeters,
    y: model.north.originLocal.y + model.north.directionLocal.y * model.north.lengthMeters,
  };
  const points: LocalPoint[] = [...model.ringLocal, model.north.originLocal, northTip];
  if (model.setback.offsetRingLocal) points.push(...model.setback.offsetRingLocal);
  for (const anchor of model.streets.anchors) points.push(...anchor.pointsLocal);
  // Contours span the DEM bbox, not just the parcel ring — planner HOLD-2
  // (2026-07-25): without this, CONTOUR draws clipped/mis-scaled relative
  // to the exact same points the DXF/IFC emitters place at full DEM extent,
  // breaking the "same layers as CAD" guarantee for this layer specifically.
  for (const contour of model.contours) {
    for (const [x, y] of contour.points) points.push({ x, y });
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);

  const PADDING_FACTOR = 0.9;
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
  dimensions: Array<{ mid: PageXY; lengthFeet: number }>;
  setback: {
    offsetRing: PageXY[] | null;
    labels: Array<{ mid: PageXY; role: string; distanceFt: number; notSpecified?: boolean; text: string }>;
    degenerate: boolean;
    degenerateReason?: string;
  };
  contours: Array<{ elevation: number; points: PageXY[] }>;
  elevationLabels: Array<{ point: PageXY; elevationMeters: number; role: "corner" | "contour" }>;
  streets: {
    honestAbsence: boolean;
    reason?: string;
    anchors: Array<{ name: string; points: PageXY[] }>;
  };
  north: { origin: PageXY; tip: PageXY };
  scaleBar: { start: PageXY; end: PageXY; lengthMeters: number };
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

  const dimensions = model.propertySegments.map((segment) => ({
    mid: projectPoint(transform, { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 }),
    lengthFeet: segment.lengthFeet,
  }));

  const setbackLabels = model.setback.segments.map((segment) => {
    const notSpecified = !!segment.notSpecified;
    const text = notSpecified
      ? `${segment.role.toUpperCase()} not specified — build-to-line governs`
      : `${segment.role.toUpperCase()} ${segment.distanceFt}'`;
    return {
      mid: projectPoint(transform, { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 }),
      role: segment.role,
      distanceFt: segment.distanceFt,
      notSpecified: notSpecified || undefined,
      text,
    };
  });

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

  return {
    transform,
    propertyLine: projectRing(transform, model.ringLocal),
    dimensions,
    setback: {
      offsetRing: model.setback.offsetRingLocal ? projectRing(transform, model.setback.offsetRingLocal) : null,
      labels: setbackLabels,
      degenerate: model.setback.degenerate,
      degenerateReason: model.setback.degenerateReason,
    },
    contours: model.contours.map((polyline) => ({
      elevation: polyline.elevation,
      points: polyline.points.map(([x, y]) => projectPoint(transform, { x, y })),
    })),
    elevationLabels: model.elevationLabels.map((label) => ({
      point: projectPoint(transform, label.point),
      elevationMeters: label.elevationMeters,
      role: label.role,
    })),
    streets: {
      honestAbsence: model.streets.honestAbsence,
      reason: model.streets.reason,
      anchors: model.streets.anchors.map((anchor) => ({
        name: anchor.name,
        points: projectRing(transform, anchor.pointsLocal),
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
