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
} from "./ring-geometry.js";

const METERS_PER_FOOT = 0.3048;

export interface SetbackRuleInput {
  front: number;
  side: number;
  rear: number;
  sourceCodeAtomRef: { atomDid: string; role: string; entityType?: string };
  atomDid?: string;
}

export interface StreetAnchorInput {
  name: string;
  /** WGS84 [lng, lat] pairs. */
  points: Array<[number, number]>;
  sourceRef?: string;
}

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
  citations: {
    propertyLine: string;
    setback: string;
    contour: string;
  };
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

  const offset = computeSetbackOffset(
    ringLocal,
    { front: inputs.setback.front, side: inputs.setback.side, rear: inputs.setback.rear },
    inputs.frontEdgeIndex,
  );
  const setback: SitePlanSetbackModel = {
    front: inputs.setback.front,
    side: inputs.setback.side,
    rear: inputs.setback.rear,
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
    citations: {
      propertyLine: inputs.geometrySourceRef ?? "parcel-geometry-ring",
      setback: `${inputs.setback.sourceCodeAtomRef.atomDid} (${inputs.setback.sourceCodeAtomRef.role})`,
      contour: inputs.demSourceCitation ?? TERRAIN_VERTICAL_DATUM.source,
    },
  };
}
