import type { LocalPoint } from "../ring-geometry.js";
import type { SitePlanModel } from "../site-model.js";
import {
  PROPERTY_LINE_TAGS_HONESTY,
  clipPolylineToAabb,
  craftLabelFontSize,
  expandRingAabb,
  estimateTextWidth,
  formatPropertyLineTagDistanceFirst,
  placeNonCollidingEdgeLabels,
  placeNonCollidingPointLabels,
  ringCentroidLocal,
  ringSignedAreaLocal,
  type MeasureTextFn,
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
  /** Elevation labels routed through the shared collision set. */
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
   * Centered BUILDABLE ENVELOPE callout (template gold reference): a
   * condensed-uppercase title over a grey "{sqft} sq ft · {pct}% of lot"
   * qualifier, anchored at the envelope centroid. Null when there is no
   * drawable envelope or the envelope is too narrow for the callout
   * (template rule 9 · suppress under 40 label-widths). The title baseline
   * is `anchor.y`; the qualifier draws one line below.
   */
  envelopeCallout: { anchor: PageXY; qualifier: string | null } | null;
  /** All labels that occupy collision space (tags + setbacks + streets + contours + callout). */
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
 * Streets are context clipped to a parcel+ROW local buffer — never fit drivers.
 * Frontage centerlines (outside the ring, inside ~40 m) survive; distant bad
 * attaches and multi-block OSM tails clip away. Soft page overflow into the
 * sheet margin is preferred over erasing the fronting road.
 */
function declutterStreets(
  model: SitePlanModel,
  transform: PdfTransform,
): {
  honestAbsence: boolean;
  reason?: string;
  anchors: Array<
    SitePlanDrawingLayout["streets"]["anchors"][number] & { _labelPoint?: PageXY; _labelText?: string }
  >;
} {
  const localClip = streetContextClipBox(model);
  const anchors: Array<
    SitePlanDrawingLayout["streets"]["anchors"][number] & { _labelPoint?: PageXY; _labelText?: string }
  > = [];
  for (const anchor of model.streets.anchors) {
    const points = projectStreetPolylineClipped(transform, anchor.pointsLocal, localClip);
    if (!points || points.length < 2) continue;
    const leftEdge = projectStreetPolylineClipped(transform, anchor.leftEdgeLocal, localClip);
    const rightEdge = projectStreetPolylineClipped(transform, anchor.rightEdgeLocal, localClip);
    const name = (anchor.name ?? "").trim();
    const mid = points[Math.floor(points.length / 2)];
    const provenance =
      anchor.rowProvenanceKind != null ? ` (${anchor.rowProvenanceKind})` : "";
    anchors.push({
      name: anchor.name,
      points,
      leftEdge,
      rightEdge,
      rowProvenanceKind: anchor.rowProvenanceKind,
      assumedWidthFt: anchor.assumedWidthFt,
      _labelPoint: mid && name ? mid : undefined,
      _labelText: mid && name ? `${name}${provenance}` : undefined,
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
): {
  contours: Array<{ elevation: number; points: PageXY[] }>;
  elevationCandidates: Array<{ point: PageXY; elevationMeters: number; role: "corner" | "contour" }>;
} {
  // Clip to the same pad band the parcel-primary fit uses (~18%), so decluttered
  // contours stay inside the drawing box rather than spilling past the sheet.
  const clipBox = parcelVicinityClipBox(model);

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
    elevationCandidates: [...cornerLabels, ...sparseContourLabels],
  };
}

/**
 * North arrow anchored top-right INSIDE the drawing box (template rule 9),
 * with its direction taken from the model's north vector projected through the
 * page transform — so a non-axis-aligned local frame still points true north.
 * The model geometry is untouched; this is page-space furniture placement.
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
   * off-sheet (street names on a road that grazes the parcel edge used to
   * spiral off the page). Defaults to the drawing box expanded by a generous
   * margin when omitted.
   */
  sheetBounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Builds the full page-space drawing layout from the shared model. Pure
 * function: same model + same box always yields the same page points,
 * which is what lets a test assert PDF drawing coordinates trace back to
 * the model (WDLL dispatch item 6: "if you can assert drawing coords match
 * model ... do so").
 */
export function buildSitePlanDrawingLayout(
  model: SitePlanModel,
  box: DrawingBox,
  options: BuildLayoutOptions = {},
): SitePlanDrawingLayout {
  const measureText = options.measureText ?? estimateTextWidth;
  const includeLotAreaCallout = options.includeLotAreaCallout !== false;
  const transform = computeDrawingTransform(model, box);
  const ringCcw = ringSignedAreaLocal(model.ringLocal) > 0;
  const occupied: PlacedLabel[] = [];

  const edgeFont = craftLabelFontSize(transform.scale, "edge");
  const setbackFont = craftLabelFontSize(transform.scale, "setback");
  const streetFont = craftLabelFontSize(transform.scale, "street");
  const contourFont = craftLabelFontSize(transform.scale, "contour");
  const calloutFont = craftLabelFontSize(transform.scale, "callout");

  // Sheet clamp: labels may sit in the drawing margins (bearing tags outside
  // the ring), but never off the printable sheet. Default to the box expanded
  // by a generous margin when the caller does not pass an explicit sheet rect.
  const bounds = options.sheetBounds ?? {
    minX: box.x - box.width * 0.35,
    minY: box.y - box.height * 0.2,
    maxX: box.x + box.width * 1.35,
    maxY: box.y + box.height * 1.2,
  };

  const dimensions = model.propertySegments.map((segment) => ({
    mid: projectPoint(transform, { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 }),
    lengthFeet: segment.lengthFeet,
  }));

  // Single shared occupied[] across all label passes — tags, setbacks, streets,
  // contours, and lot-area callout collide with each other (QA2 craft).
  const propertyLineTags = placeNonCollidingEdgeLabels(
    model.propertySegments.map((segment) => ({
      midLocal: { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 },
      a: segment.a,
      b: segment.b,
      text: formatPropertyLineTagDistanceFirst(segment),
      fontSize: edgeFont,
    })),
    (p) => projectPoint(transform, p),
    {
      ringCcw,
      outwardMeters: Math.max(1.2, (1 / transform.scale) * 10),
      pageScale: transform.scale,
      measureText,
      occupied,
      bounds,
    },
  );

  const silentAxes = !!(
    model.setback.notSpecified?.front ||
    model.setback.notSpecified?.side ||
    model.setback.notSpecified?.rear
  );
  // Template rule 4: setback labels print once per unique value per role;
  // identical adjacent values collapse to "<ROLE> <d>' (typ.)". An
  // "unassigned" role (the offset could not classify this edge as front/side/
  // rear) must NEVER be printed as a fabricated FRONT/SIDE/REAR — we honestly
  // label it "SETBACK <d>' (typ.)" and collapse duplicates, rather than
  // inventing an edge role we do not have.
  const seenRoleValue = new Set<string>();
  const setbackLabelItems = model.setback.segments
    .map((segment) => {
      const notSpecified = !!segment.notSpecified;
      const roleUpper = segment.role.toUpperCase();
      let text: string;
      if (notSpecified) {
        text = `${roleUpper} not specified - build-to-line governs`;
      } else if (segment.role === "unassigned") {
        // Honest, un-fabricated label; dedupe identical values so the sheet
        // shows one "SETBACK 5' (typ.)" instead of the same value on 8 edges.
        const key = `setback:${segment.distanceFt}`;
        if (seenRoleValue.has(key)) return null;
        seenRoleValue.add(key);
        text = silentAxes ? model.setback.displayLine : `SETBACK ${segment.distanceFt}' (typ.)`;
      } else {
        // Assigned role: keep the label on each edge (the gold reference shows
        // SIDE on both sides) but mark repeats "(typ.)" per template rule 4.
        const key = `${segment.role}:${segment.distanceFt}`;
        const typ = seenRoleValue.has(key);
        seenRoleValue.add(key);
        text = `${roleUpper} ${segment.distanceFt}'${typ ? " (typ.)" : ""}`;
      }
      if (!text) return null;
      return {
        midLocal: { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 },
        a: segment.a,
        b: segment.b,
        text,
        fontSize: setbackFont,
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
      measureText,
      occupied,
      bounds,
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
  const streetsRaw = declutterStreets(model, transform);

  // Street labels through the same collision set (never bypass). Place
  // one-at-a-time so a drop does not shift labels onto the wrong anchor.
  const streetAnchors = streetsRaw.anchors.map((a) => {
    const { _labelPoint: labelPoint, _labelText: labelText, ...rest } = a;
    if (!labelPoint || !labelText) return rest;
    const placed = placeNonCollidingPointLabels(
      [{ point: labelPoint, text: labelText, fontSize: streetFont }],
      { measureText, occupied, pageScale: transform.scale, bounds },
    );
    return placed[0] ? { ...rest, label: placed[0] } : rest;
  });

  // Contour / corner elevation labels through collision (contour role only drawn).
  const elevationItems = decluttered.elevationCandidates
    .filter((l) => l.role === "contour")
    .map((l) => ({
      point: l.point,
      text: l.elevationMeters.toFixed(1),
      fontSize: contourFont,
    }));
  const elevationLabels = placeNonCollidingPointLabels(elevationItems, {
    measureText,
    occupied,
    pageScale: transform.scale,
    bounds,
  });

  // Centered BUILDABLE ENVELOPE callout — anchored at the envelope centroid
  // (template gold reference 2a), suppressed when the envelope is too narrow
  // for the title (rule 9 · under ~40 label-widths). Reserves a two-line
  // block in the shared collision set so property-line tags never land on it.
  let envelopeCallout: SitePlanDrawingLayout["envelopeCallout"] = null;
  let lotAreaCallout: PlacedLabel | null = null;
  const offsetRingLocal = model.setback.offsetRingLocal;
  if (includeLotAreaCallout && offsetRingLocal && offsetRingLocal.length >= 3) {
    const envCentroid = ringCentroidLocal(offsetRingLocal);
    const anchor = projectPoint(transform, envCentroid);
    // Envelope page-space width at the centroid latitude band.
    const envPage = offsetRingLocal.map((p) => projectPoint(transform, p));
    const envXs = envPage.map((p) => p.x);
    const envWidthPage = Math.max(...envXs) - Math.min(...envXs);
    const titleText = "BUILDABLE ENVELOPE";
    const titleSize = calloutFont + 2.5;
    const titleWidth = measureText(titleText, titleSize);
    // Rule 9: suppress if the envelope is narrower than the callout needs.
    if (envWidthPage >= titleWidth * 1.05) {
      const pct =
        Number.isFinite(model.summary.lotAreaSqFt) && model.summary.lotAreaSqFt > 0 && model.summary.buildableAreaSqFt != null
          ? Math.round((model.summary.buildableAreaSqFt / model.summary.lotAreaSqFt) * 100)
          : null;
      const qualifier =
        model.summary.buildableAreaSqFt != null
          ? `${Math.round(model.summary.buildableAreaSqFt).toLocaleString("en-US")} sq ft${pct != null ? ` · ${pct}% of lot` : ""}`
          : null;
      envelopeCallout = { anchor, qualifier };
      // Reserve the two-line block so tags collide with it.
      const blockH = titleSize + calloutFont + 6;
      occupied.push({
        text: titleText,
        anchor,
        drawAt: { x: anchor.x - titleWidth / 2, y: anchor.y - titleSize },
        box: { x: anchor.x - titleWidth / 2, y: anchor.y - titleSize, width: titleWidth, height: blockH },
        fontSize: titleSize,
      });
    }
  }
  // Fallback lot-area callout (kept for callers/tests that read it) only when
  // no envelope callout was drawn — otherwise the two would overlap.
  if (!envelopeCallout && includeLotAreaCallout && Number.isFinite(model.summary.lotAreaSqFt)) {
    const centroid = ringCentroidLocal(model.ringLocal);
    const placed = placeNonCollidingPointLabels(
      [
        {
          point: projectPoint(transform, centroid),
          text: `${model.summary.lotAreaSqFt.toFixed(0)} sq ft`,
          fontSize: calloutFont,
        },
      ],
      { measureText, occupied, pageScale: transform.scale },
    );
    lotAreaCallout = placed[0] ?? null;
  }

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
