import type { BboxWgs84, ParsedDem } from "../site-topography/index.js";
import {
  collectContourPolylines,
  type ContourPolyline2d,
} from "../parcel-terrain/emitters.js";
import { TERRAIN_VERTICAL_DATUM, type TerrainVerticalDatum } from "../parcel-terrain/elevation.js";
import { projectWgs84ToLocalEnu, TERRAIN_MESH_CRS_CONVENTION } from "../parcel-terrain/mesh.js";
import {
  computeSetbackOffset,
  dedupeClosingVertex,
  ringSegments,
  type FrontEdgeBasis,
  type LocalPoint,
  type RingSegment,
  type SetbackAssignment,
  type SetbackOffsetResult,
} from "./ring-geometry.js";
import { formatSetbackSummaryLine } from "./setback-display.js";

const METERS_PER_FOOT = 0.3048;

export interface SetbackRuleInput {
  front: number;
  side: number;
  rear: number;
  sourceCodeAtomRef: { atomDid: string; role: string; entityType?: string };
  atomDid?: string;
  /** Silent axes (code silent / build-to-line). Distinct from missing setback data. */
  notSpecified?: { front?: boolean; side?: boolean; rear?: boolean };
}

export interface StreetAnchorInput {
  name: string;
  /** WGS84 [lng, lat] pairs. */
  points: Array<[number, number]>;
  sourceRef?: string;
}

/** Non-geometry descriptors no atom holds today (address, county name).
 * Optional and caller-supplied only — the composer never fabricates these;
 * the summary falls back to what IS derivable (county FIPS from the
 * parcelNodeId) when absent. */
export interface SitePlanDescriptorInput {
  address?: string;
  countyName?: string;
}

export type ZoningSummaryInput =
  | { district: string }
  | { honestAbsence: true; reason: string };

export type FloodZoneSummaryInput =
  | {
      zone: string | null;
      inSpecialFloodHazardArea: boolean;
      sourceCitation: string;
      asOfIso: string;
    }
  | { honestUnavailable: true; reason: string };

/** Minimal shape of the buildable-envelope atom's own honest outcome —
 * declared locally rather than imported from `@hauska-engine/atoms` so
 * `engine-core`'s site-plan module doesn't take on that package as a
 * required dependency just for one union type; the `kind`/`reason` fields
 * are structurally identical to `EnvelopeHonestOutcome`. */
export type EnvelopeOutcomeInput =
  | { kind: "buildable"; areaSqFt: number }
  | { kind: "no-buildable-area"; reason: string }
  | { kind: "provisional-front-edge"; reason: string };

export interface ComposeSitePlanModelInputs {
  parcelNodeId: string;
  bbox: BboxWgs84;
  /**
   * WGS84 [lng, lat] exterior ring. Required: callers must fail closed
   * before calling this composer when a resolver has no ring (bbox-only
   * geometry is not a valid stand-in for a property boundary).
   */
  ringWgs84: Array<[number, number]>;
  dem: ParsedDem;
  contourIntervalMeters: number;
  setback: SetbackRuleInput;
  /** Segment index (into the property ring) known to face the street, if resolved. */
  frontEdgeIndex?: number;
  streetAnchors?: StreetAnchorInput[];
  /** The resolver's provenance ref for the ring itself (e.g. `txgio-parcel:48029:105129:<vintage>`). */
  geometrySourceRef?: string;
  /** DEM/USGS 3DEP source citation, mirrors the terrain-export atom's sourceCitation. */
  demSourceCitation?: string;
  /** PDF summary-block-only, non-geometry descriptors (Wave 2). Optional;
   * honest fallback when absent — never fabricated. */
  descriptor?: SitePlanDescriptorInput;
  /** Zoning district for the summary block, or an honest-absence verdict
   * (mirrors the zoning-fact atom's own honest-absence shape). */
  zoning?: ZoningSummaryInput;
  /** FEMA flood-zone read for the summary block, or an honest-unavailable
   * verdict (e.g. no live network egress, upstream error). */
  floodZone?: FloodZoneSummaryInput;
  /** The parcel's buildable-envelope atom outcome, if the caller has one on
   * file (planner HOLD 2026-07-25: a `provisional-front-edge` envelope
   * outcome must also trigger the buildable-area honesty note, even on a
   * ring shape whose own offset-basis heuristic happened to resolve). */
  envelopeOutcome?: EnvelopeOutcomeInput;
}

export interface ElevationLabel {
  point: LocalPoint;
  elevationMeters: number;
  role: "corner" | "contour";
}

export interface SitePlanSetbackModel {
  front: number;
  side: number;
  rear: number;
  notSpecified?: { front?: boolean; side?: boolean; rear?: boolean };
  /** Honest F/S/R summary for PDF (never prints silent axes as real 0 ft). */
  displayLine: string;
  sourceCodeAtomRef: { atomDid: string; role: string; entityType?: string };
  basis: FrontEdgeBasis;
  segments: Array<RingSegment & SetbackAssignment>;
  offsetRingLocal: LocalPoint[] | null;
  degenerate: boolean;
  degenerateReason?: string;
}

export interface SitePlanStreetModel {
  anchors: Array<{ name: string; pointsLocal: LocalPoint[]; sourceRef?: string }>;
  honestAbsence: boolean;
  reason?: string;
}

export interface SitePlanNorthModel {
  originLocal: LocalPoint;
  /** Always (0,1) in this engine's local-ENU convention; carried explicitly
   * so emitters never hardcode the assumption. */
  directionLocal: { x: number; y: number };
  lengthMeters: number;
}

/**
 * Non-CAD summary data (PDF sheet only — WDLL 5) computed from the SAME
 * ring/setback/DEM inputs every other field on this model reads. DXF/IFC
 * emitters ignore this block entirely; it exists so the PDF renders off the
 * identical `SitePlanModel` object rather than a second derivation.
 */
export interface SitePlanSummaryModel {
  parcelNodeId: string;
  /** Parsed from the parcelNodeId (`{countyFips}:{propId}`); always available. */
  countyFips: string | null;
  /** Caller-supplied only — never fabricated. Undefined = not on file. */
  countyName?: string;
  address?: string;
  zoningDistrict?: string;
  zoningHonestAbsenceReason?: string;
  lotAreaSqFt: number;
  /** Null when the setback offset degenerated (see `buildableAreaHonestNote`). */
  buildableAreaSqFt: number | null;
  buildableAreaHonestNote?: string;
  elevationRangeMeters: { min: number; max: number };
  verticalDatumSummary: string;
  floodZone:
    | { zone: string | null; inSpecialFloodHazardArea: boolean; sourceCitation: string; asOfIso: string }
    | { honestUnavailable: true; reason: string };
}

export interface SitePlanModel {
  parcelNodeId: string;
  ringLocal: LocalPoint[];
  propertySegments: Array<RingSegment & { lengthFeet: number }>;
  setback: SitePlanSetbackModel;
  contours: ContourPolyline2d[];
  elevationLabels: ElevationLabel[];
  streets: SitePlanStreetModel;
  north: SitePlanNorthModel;
  scaleBar: { lengthMeters: number };
  verticalDatum: TerrainVerticalDatum;
  crsConvention: typeof TERRAIN_MESH_CRS_CONVENTION;
  summary: SitePlanSummaryModel;
  citations: {
    propertyLine: string;
    setback: string;
    contour: string;
    zoning?: string;
    flood?: string;
  };
}

/** Shoelace polygon area in the same local-ENU metre frame as `ringLocal`. */
function polygonAreaSqMeters(ring: LocalPoint[]): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

const SQMETERS_PER_SQFOOT = 0.09290304;

function parseCountyFips(parcelNodeId: string): string | null {
  const match = /^(\d{5}):/.exec(parcelNodeId.trim());
  return match ? match[1]! : null;
}

function sampleDemNearest(
  dem: Pick<ParsedDem, "width" | "height" | "values">,
  bbox: BboxWgs84,
  lng: number,
  lat: number,
): number {
  const dLng = (bbox.eastLng - bbox.westLng) / (dem.width - 1);
  const dLat = (bbox.northLat - bbox.southLat) / (dem.height - 1);
  const xRaw = Math.round((lng - bbox.westLng) / dLng);
  const yRaw = Math.round((bbox.northLat - lat) / dLat);
  const x = Math.min(dem.width - 1, Math.max(0, xRaw));
  const y = Math.min(dem.height - 1, Math.max(0, yRaw));
  return dem.values[y * dem.width + x]!;
}

/**
 * Buildable area is only ever a certain, non-provisional figure when the
 * front edge is a resolved anchor (`front-edge-hint`) AND no upstream
 * buildable-envelope atom has independently flagged the parcel provisional.
 * Every other basis (a geometric heuristic, or a uniform-minimum fallback
 * for an irregular ring) is a planning estimate, not a permit-ready number,
 * and the honesty note must say so even when a numeric area IS drawn
 * (planner HOLD-1, 2026-07-25 — a degenerate offset is a separate, harder
 * failure already covered by `offsetDegenerateReason` below).
 */
function computeBuildableAreaHonestNote(
  offset: Pick<SetbackOffsetResult, "offsetRing" | "offsetDegenerateReason" | "basis">,
  envelopeOutcome: EnvelopeOutcomeInput | undefined,
): string | undefined {
  if (!offset.offsetRing) {
    return offset.offsetDegenerateReason;
  }
  const envelopeProvisional = envelopeOutcome?.kind === "provisional-front-edge";
  if (offset.basis === "front-edge-hint" && !envelopeProvisional) {
    return undefined;
  }
  const basisNote =
    offset.basis === "geometric-heuristic:shortest-edge-pair-south-most"
      ? "front edge assigned by a geometric heuristic (shortest roughly-parallel edge pair, south-most side), not a resolved road-anchor"
      : offset.basis === "unresolved-uniform-min"
        ? "front edge unresolved on this ring shape; the uniform minimum of front/side/rear was applied to every edge as a conservative estimate"
        : "front-edge basis resolved by hint, but the parcel's buildable-envelope atom independently reports a provisional front edge";
  const envelopeNote = envelopeProvisional
    ? ` Buildable-envelope atom outcome: provisional-front-edge (${envelopeOutcome.reason}).`
    : "";
  return (
    `Buildable area is provisional pending front-edge resolution: ${basisNote}.${envelopeNote} ` +
    "Treat this figure as a planning estimate, not a permit-ready boundary."
  );
}

/** Rounds to a "nice" scale-bar length (1/2/5 * 10^n) at or below maxMeters. */
function niceScaleBarLength(maxMeters: number): number {
  if (!(maxMeters > 0)) return 1;
  const steps = [1, 2, 5];
  const exponent = Math.floor(Math.log10(maxMeters));
  for (let e = exponent; e >= exponent - 3; e--) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const candidate = steps[i]! * 10 ** e;
      if (candidate <= maxMeters) return candidate;
    }
  }
  return Math.max(1, Math.round(maxMeters));
}

/**
 * Composes the ONE shared site model — parcel ring, setback offsets,
 * contours/elevations, street anchors (or honest absence), north/scale —
 * that every DXF/IFC(/PDF) emitter reads. No emitter derives geometry of
 * its own; this is the single source of truth guaranteeing CAD and PDF
 * cannot diverge (WDLL item 2).
 */
export function composeSitePlanModel(inputs: ComposeSitePlanModelInputs): SitePlanModel {
  if (inputs.ringWgs84.length < 3) {
    throw new Error(
      `Site-plan model requires a parcel boundary ring (>=3 points); got ${inputs.ringWgs84.length} for ${inputs.parcelNodeId}. ` +
        "Refusing to approximate PROPERTY_LINE from the DEM bbox rectangle.",
    );
  }

  const projectedRing = inputs.ringWgs84.map(([lng, lat]) => projectWgs84ToLocalEnu(lng, lat, inputs.bbox));
  const ringLocal = dedupeClosingVertex(projectedRing);
  const propertySegments = ringSegments(ringLocal).map((segment) => ({
    ...segment,
    lengthFeet: segment.lengthMeters / METERS_PER_FOOT,
  }));

  const notSpecified = inputs.setback.notSpecified;
  const offset = computeSetbackOffset(
    ringLocal,
    { front: inputs.setback.front, side: inputs.setback.side, rear: inputs.setback.rear },
    inputs.frontEdgeIndex,
    notSpecified,
  );
  const setback: SitePlanSetbackModel = {
    front: inputs.setback.front,
    side: inputs.setback.side,
    rear: inputs.setback.rear,
    notSpecified,
    displayLine: formatSetbackSummaryLine({
      front: inputs.setback.front,
      side: inputs.setback.side,
      rear: inputs.setback.rear,
      notSpecified,
    }),
    sourceCodeAtomRef: inputs.setback.sourceCodeAtomRef,
    basis: offset.basis,
    segments: offset.segments,
    offsetRingLocal: offset.offsetRing,
    degenerate: offset.offsetDegenerate,
    degenerateReason: offset.offsetDegenerateReason,
  };

  const contours = collectContourPolylines(inputs.dem, inputs.bbox, inputs.contourIntervalMeters);

  const cornerLabels: ElevationLabel[] = inputs.ringWgs84.map(([lng, lat], i) => ({
    point: ringLocal[Math.min(i, ringLocal.length - 1)]!,
    elevationMeters: sampleDemNearest(inputs.dem, inputs.bbox, lng, lat),
    role: "corner" as const,
  }));
  const contourLabels: ElevationLabel[] = contours
    .filter((polyline) => polyline.points.length > 0)
    .map((polyline) => ({
      point: { x: polyline.points[0]![0], y: polyline.points[0]![1] },
      elevationMeters: polyline.elevation,
      role: "contour" as const,
    }));

  const streetAnchors = inputs.streetAnchors ?? [];
  const streets: SitePlanStreetModel =
    streetAnchors.length > 0
      ? {
          anchors: streetAnchors.map((anchor) => ({
            name: anchor.name,
            pointsLocal: anchor.points.map(([lng, lat]) => projectWgs84ToLocalEnu(lng, lat, inputs.bbox)),
            sourceRef: anchor.sourceRef,
          })),
          honestAbsence: false,
        }
      : {
          anchors: [],
          honestAbsence: true,
          reason:
            "No road-anchor atom is available in hauska-engine for this parcel; STREET layer is created " +
            "empty rather than drawing fabricated street geometry.",
        };

  const xs = ringLocal.map((p) => p.x);
  const ys = ringLocal.map((p) => p.y);
  const extentMeters = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const north: SitePlanNorthModel = {
    originLocal: { x: Math.min(...xs) - extentMeters * 0.15, y: Math.min(...ys) },
    directionLocal: { x: 0, y: 1 },
    lengthMeters: Math.max(1, extentMeters * 0.15),
  };
  const scaleBar = { lengthMeters: niceScaleBarLength(extentMeters * 0.5) };

  const lotAreaSqFt = polygonAreaSqMeters(ringLocal) / SQMETERS_PER_SQFOOT;
  const buildableAreaSqFt = offset.offsetRing
    ? polygonAreaSqMeters(offset.offsetRing) / SQMETERS_PER_SQFOOT
    : null;

  const zoningDistrict = inputs.zoning && "district" in inputs.zoning ? inputs.zoning.district : undefined;
  const zoningHonestAbsenceReason =
    inputs.zoning && "honestAbsence" in inputs.zoning ? inputs.zoning.reason : undefined;

  const floodZone: SitePlanSummaryModel["floodZone"] = inputs.floodZone ?? {
    honestUnavailable: true,
    reason: "No flood-zone read attempted for this export.",
  };

  const summary: SitePlanSummaryModel = {
    parcelNodeId: inputs.parcelNodeId,
    countyFips: parseCountyFips(inputs.parcelNodeId),
    countyName: inputs.descriptor?.countyName,
    address: inputs.descriptor?.address,
    zoningDistrict,
    zoningHonestAbsenceReason,
    lotAreaSqFt,
    buildableAreaSqFt,
    buildableAreaHonestNote: computeBuildableAreaHonestNote(offset, inputs.envelopeOutcome),
    elevationRangeMeters: { min: inputs.dem.minElevation, max: inputs.dem.maxElevation },
    verticalDatumSummary: TERRAIN_VERTICAL_DATUM.summary,
    floodZone,
  };

  return {
    parcelNodeId: inputs.parcelNodeId,
    ringLocal,
    propertySegments,
    setback,
    contours,
    elevationLabels: [...cornerLabels, ...contourLabels],
    streets,
    north,
    scaleBar,
    verticalDatum: TERRAIN_VERTICAL_DATUM,
    crsConvention: TERRAIN_MESH_CRS_CONVENTION,
    summary,
    citations: {
      propertyLine: inputs.geometrySourceRef ?? "parcel-geometry-ring",
      setback: `${inputs.setback.sourceCodeAtomRef.atomDid} (${inputs.setback.sourceCodeAtomRef.role})`,
      contour: inputs.demSourceCitation ?? TERRAIN_VERTICAL_DATUM.source,
      zoning: zoningDistrict ? "zoning-fact atom (parcel zoning polygon)" : undefined,
      flood: "zone" in floodZone ? floodZone.sourceCitation : undefined,
    },
  };
}
