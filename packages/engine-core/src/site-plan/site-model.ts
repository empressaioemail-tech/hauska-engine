import type { BboxWgs84, ParsedDem } from "../site-topography/index.js";
import {
  collectContourPolylines,
  type ContourPolyline2d,
} from "../parcel-terrain/emitters.js";
import { TERRAIN_VERTICAL_DATUM, type TerrainVerticalDatum } from "../parcel-terrain/elevation.js";
import { projectWgs84ToLocalEnu, TERRAIN_MESH_CRS_CONVENTION } from "../parcel-terrain/mesh.js";
import {
  computeSetbackOffset,
  computeSetbackOffsetFromPrimitive,
  dedupeClosingVertex,
  ringSegments,
  type BoundaryEdgeGeometryInput,
  type FrontEdgeBasis,
  type LocalPoint,
  type RingSegment,
  type SetbackAssignment,
  type SetbackOffsetResult,
} from "./ring-geometry.js";
import { anyNotSpecified, formatSetbackSummaryLine } from "./setback-display.js";
import {
  mapBuildableDisplay,
  type BuildableDisplayKind,
} from "./buildable-display-vocab.js";

const METERS_PER_FOOT = 0.3048;

export interface SetbackRuleInput {
  front: number;
  side: number;
  rear: number;
  sourceCodeAtomRef: { atomDid: string; role: string; entityType?: string };
  atomDid?: string;
  /** Silent axes (code silent / build-to-line). Distinct from missing setback data. */
  notSpecified?: { front?: boolean; side?: boolean; rear?: boolean };
  /**
   * True when NO setback-rule atom exists for this parcel at all — a distinct
   * honest state from `notSpecified` (where a rule exists but the code is
   * silent on an axis). The whole sheet still exports: the setback layer is
   * drawn as honest-absent, no F/S/R value is fabricated (all axes inset 0,
   * so the offset ring equals the property line), and the summary/legend say
   * "no setback rule on file — not verified", NEVER a fabricated dimension.
   */
  honestAbsence?: boolean;
  /** Reason surfaced on the sheet when `honestAbsence` is set. */
  honestAbsenceReason?: string;
}

export interface StreetAnchorInput {
  name: string;
  /** Centerline WGS84 [lng, lat] pairs (accurate road-node geometry). */
  points: Array<[number, number]>;
  sourceRef?: string;
  /** Road-node id when this anchor was projected from a ledger road-node. */
  roadNodeId?: string;
  /** ROW left edge from road-node assumed width (v1). */
  leftEdgePoints?: Array<[number, number]>;
  /** ROW right edge from road-node assumed width (v1). */
  rightEdgePoints?: Array<[number, number]>;
  /**
   * ROW provenance kind from the road-node atom (e.g. approximate-assumed-per-class).
   * Drawn edges MUST carry this mark — never silent assumed geometry.
   */
  rowProvenanceKind?: string;
  assumedWidthFt?: number;
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
  | {
      district: string;
      /** True when the district is a fixture/provisional value — the sheet
       * keeps the real value and adds ONE `FIXTURE LABEL` chip (SHEET
       * STANDARD §6); never encode fixture-ness into the district string. */
      fixture?: boolean;
    }
  | { honestAbsence: true; reason: string };

export type FloodZoneSummaryInput =
  | {
      zone: string | null;
      inSpecialFloodHazardArea: boolean;
      sourceCitation: string;
      asOfIso: string;
    }
  | {
      honestUnavailable: true;
      /** SHEET copy (§11): one plain sentence, ≤12 words, no machine codes. */
      reason: string;
      /** Machine detail (upstream error string) — provenance SOURCE column
       * only, never drawn in the summary row (§11). */
      detail?: string;
    };

/** Minimal shape of the buildable-envelope atom's own honest outcome —
 * declared locally rather than imported from `@hauska-engine/atoms` so
 * `engine-core`'s site-plan module doesn't take on that package as a
 * required dependency just for one union type; the `kind`/`reason` fields
 * are structurally identical to `EnvelopeHonestOutcome`. */
export type EnvelopeOutcomeInput =
  | { kind: "buildable"; areaSqFt: number }
  | { kind: "no-buildable-area"; reason: string }
  | { kind: "provisional-front-edge"; reason: string }
  | { kind: "not-applicable"; reason: string };

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
  /**
   * The parcel's STORED boundary primitive (property-boundary-edge atoms:
   * per-edge role + resolved setback + interior inward normal, baked once per
   * ring — S2-U2). When present, the envelope/setback geometry and edge-role
   * labels CONSUME it through the same engine depth-warm uses
   * (`computeSetbackOffsetFromPrimitive`) — one truth by construction. When
   * absent, the composer falls back to `frontEdgeIndex` (resolved anchor) or
   * the honest unresolved-front-edge treatment — never a per-edge guess.
   */
  boundaryEdges?: ReadonlyArray<BoundaryEdgeGeometryInput>;
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
  /**
   * Pre-resolved contour polylines in the local-ENU metre frame (qa/topo-
   * fidelity-1ft). When supplied, the composer draws these instead of deriving
   * contours from the DEM grid — used to serve the authoritative Bastrop 1-ft
   * tier. Omit to keep the DEM-derived behaviour. Elevation is metres NAVD88.
   */
  contourOverride?: ContourPolyline2d[];
  /** Provenance for the contour tier used, surfaced to the summary citation. */
  contourSourceCitation?: string;
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
  /** True when no setback-rule atom exists at all (whole layer honest-absent). */
  honestAbsence?: boolean;
  honestAbsenceReason?: string;
  /** Honest F/S/R summary for PDF (never prints silent axes as real 0 ft). */
  displayLine: string;
  sourceCodeAtomRef: { atomDid: string; role: string; entityType?: string };
  basis: FrontEdgeBasis;
  segments: Array<RingSegment & SetbackAssignment>;
  offsetRingLocal: LocalPoint[] | null;
  degenerate: boolean;
  degenerateReason?: string;
  /** True when a rule exists but no boundary primitive / front-edge anchor
   * resolves the front edge: nothing envelope-shaped is drawn (provisional),
   * distinct from a degenerate (collapsed) offset. */
  frontEdgeUnresolved?: boolean;
  /** Boundary-primitive path: some edge carried a stored setback absence
   * (zero inset there) — envelope drawn but labeled PROVISIONAL. */
  primitiveEdgeAbsence?: boolean;
}

export interface SitePlanStreetAnchorModel {
  name: string;
  /** Centerline in local-ENU metres. */
  pointsLocal: LocalPoint[];
  sourceRef?: string;
  roadNodeId?: string;
  leftEdgeLocal?: LocalPoint[];
  rightEdgeLocal?: LocalPoint[];
  /** Must match road-node row.provenance.kind when edges are drawn. */
  rowProvenanceKind?: string;
  assumedWidthFt?: number;
}

export interface SitePlanStreetModel {
  anchors: SitePlanStreetAnchorModel[];
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
  /** §6: the district keeps its real value and takes a FIXTURE LABEL chip. */
  zoningFixture?: boolean;
  zoningHonestAbsenceReason?: string;
  lotAreaSqFt: number;
  /** Null when the setback offset degenerated (see `buildableAreaHonestNote`). */
  buildableAreaSqFt: number | null;
  buildableAreaHonestNote?: string;
  /**
   * Shared B3 customer vocabulary (same mapper as PE map card / inspect).
   * Prefer warm envelope area when present so PDF cannot say "consumes lot"
   * while the map shows a buildable figure for the same inputs.
   */
  buildableDisplayKind: BuildableDisplayKind;
  buildableAgreementToken: string;
  /** PDF SUMMARY "Buildable Area" value — always from the shared mapper. */
  buildablePdfLabel: string;
  elevationRangeMeters: { min: number; max: number };
  verticalDatumSummary: string;
  floodZone:
    | { zone: string | null; inSpecialFloodHazardArea: boolean; sourceCitation: string; asOfIso: string }
    | { honestUnavailable: true; reason: string; detail?: string };
}

export interface SitePlanModel {
  parcelNodeId: string;
  /**
   * The WGS84 bbox the local-ENU frame is anchored to (origin = SW corner,
   * `projectWgs84ToLocalEnu`). Carried on the model so page-space consumers
   * that need a georeference (the PDF aerial-context page's Web-Mercator
   * imagery alignment) can invert `ringLocal` exactly instead of re-deriving
   * or duplicating the ring.
   */
  bboxWgs84: BboxWgs84;
  ringLocal: LocalPoint[];
  propertySegments: Array<RingSegment & { lengthFeet: number }>;
  setback: SitePlanSetbackModel;
  contours: ContourPolyline2d[];
  /** Contour interval used for this export (legend row text, §5). */
  contourIntervalMeters: number;
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

/**
 * True when the offset ring is geometrically coincident with the property ring
 * (zero inset on every edge). That geometry is NOT a buildable envelope — it
 * is the honest "no setback to apply" case (missing rule atom, or all axes
 * silent at 0 ft). Callers must treat buildable area as absent, never lot area.
 */
function isZeroInsetEnvelope(propertyRing: LocalPoint[], offsetRing: LocalPoint[]): boolean {
  const propertyArea = polygonAreaSqMeters(propertyRing);
  if (!(propertyArea > 0)) return true;
  const offsetArea = polygonAreaSqMeters(offsetRing);
  return Math.abs(offsetArea - propertyArea) / propertyArea < 1e-9;
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
 * Buildable area is a certain, non-provisional figure only when its geometry
 * consumed a fully-resolved truth: the stored boundary primitive with a
 * resolved setback on every edge, or a caller-resolved front-edge anchor —
 * AND no upstream buildable-envelope atom independently flags the parcel
 * provisional. Everything else carries the honesty note (planner HOLD-1,
 * 2026-07-25; build-to-line ruling 2026-07-28 — a degenerate offset is a
 * separate, harder failure already covered by `offsetDegenerateReason`).
 */
function computeBuildableAreaHonestNote(
  offset: Pick<
    SetbackOffsetResult,
    "offsetRing" | "offsetDegenerateReason" | "basis" | "frontEdgeUnresolved" | "primitiveEdgeAbsence"
  >,
  envelopeOutcome: EnvelopeOutcomeInput | undefined,
): string | undefined {
  if (offset.frontEdgeUnresolved) {
    return (
      "Buildable area is provisional pending front-edge resolution: no boundary primitive is on file " +
      "for this parcel and no front-edge anchor is resolved. Setback lines are not drawn rather than " +
      "guessed per edge. Treat any figure as a planning estimate, not a permit-ready boundary."
    );
  }
  if (!offset.offsetRing) {
    return offset.offsetDegenerateReason;
  }
  const envelopeProvisional = envelopeOutcome?.kind === "provisional-front-edge";
  if (offset.basis === "boundary-primitive" && offset.primitiveEdgeAbsence && !envelopeProvisional) {
    return (
      "Buildable area is provisional: one or more boundary edges carry no stated setback " +
      "(build-to-line governs or adjacency unmapped); zero inset was applied on those edges — " +
      "no value was fabricated. Treat this figure as a planning estimate, not a permit-ready boundary."
    );
  }
  if (
    (offset.basis === "front-edge-hint" || offset.basis === "boundary-primitive") &&
    !envelopeProvisional
  ) {
    return undefined;
  }
  const basisNote = envelopeProvisional
    ? offset.basis === "boundary-primitive"
      ? "geometry consumed the stored boundary primitive, but the parcel's buildable-envelope atom independently reports a provisional front edge"
      : "front-edge basis resolved by hint, but the parcel's buildable-envelope atom independently reports a provisional front edge"
    : "front edge unresolved";
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

  // Honest-absent setback (no rule atom at all): force every axis silent so
  // the geometry insets 0 (offset ring == property line, no fabricated
  // setback lines) and the legend labels the whole layer as unverified —
  // NEVER a fabricated F/S/R. Distinct from a per-axis `notSpecified` (a rule
  // exists but the code is silent on that axis).
  const setbackHonestAbsence = inputs.setback.honestAbsence === true;
  const setbackHonestAbsenceReason = setbackHonestAbsence
    ? inputs.setback.honestAbsenceReason ??
      "No setback-rule atom on file for this parcel; setbacks are not specified here and have not been verified."
    : undefined;
  const notSpecified = setbackHonestAbsence
    ? { front: true, side: true, rear: true }
    : inputs.setback.notSpecified;
  // Geometry selection (2026-07-28 architecture directive): the STORED
  // boundary primitive wins whenever it exists — the export consumes the same
  // per-edge role/setback/inward-normal truth depth-warm consumes, through
  // the same offset engine. A caller-resolved front-edge anchor is the only
  // other basis; otherwise the honest unresolved treatment. The retired
  // vertex-count heuristic never runs here.
  const offset: SetbackOffsetResult =
    !setbackHonestAbsence && inputs.boundaryEdges && inputs.boundaryEdges.length > 0
      ? computeSetbackOffsetFromPrimitive({
          ringLocal,
          ringWgs84: inputs.ringWgs84,
          bbox: inputs.bbox,
          boundaryEdges: inputs.boundaryEdges,
        })
      : computeSetbackOffset(
          ringLocal,
          { front: inputs.setback.front, side: inputs.setback.side, rear: inputs.setback.rear },
          inputs.frontEdgeIndex,
          notSpecified,
          { ringWgs84: inputs.ringWgs84, bbox: inputs.bbox },
        );
  const setback: SitePlanSetbackModel = {
    front: inputs.setback.front,
    side: inputs.setback.side,
    rear: inputs.setback.rear,
    notSpecified,
    honestAbsence: setbackHonestAbsence,
    honestAbsenceReason: setbackHonestAbsenceReason,
    displayLine: setbackHonestAbsence
      ? "Setbacks not specified — no setback rule on file for this parcel (not verified)"
      : formatSetbackSummaryLine({
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
    frontEdgeUnresolved: offset.frontEdgeUnresolved,
    primitiveEdgeAbsence: offset.primitiveEdgeAbsence,
  };

  const contours =
    inputs.contourOverride ??
    collectContourPolylines(inputs.dem, inputs.bbox, inputs.contourIntervalMeters);

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
            roadNodeId: anchor.roadNodeId,
            leftEdgeLocal: anchor.leftEdgePoints?.map(([lng, lat]) =>
              projectWgs84ToLocalEnu(lng, lat, inputs.bbox),
            ),
            rightEdgeLocal: anchor.rightEdgePoints?.map(([lng, lat]) =>
              projectWgs84ToLocalEnu(lng, lat, inputs.bbox),
            ),
            rowProvenanceKind: anchor.rowProvenanceKind,
            assumedWidthFt: anchor.assumedWidthFt,
          })),
          honestAbsence: false,
        }
      : {
          anchors: [],
          honestAbsence: true,
          reason:
            "No road-node attaches to this parcel; STREET layer is created empty rather than " +
            "drawing fabricated street geometry.",
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
  const buildableAreaSqFt =
    offset.offsetRing && !isZeroInsetEnvelope(ringLocal, offset.offsetRing)
      ? polygonAreaSqMeters(offset.offsetRing) / SQMETERS_PER_SQFOOT
      : null;

  const zoningDistrict = inputs.zoning && "district" in inputs.zoning ? inputs.zoning.district : undefined;
  const zoningFixture =
    inputs.zoning && "district" in inputs.zoning ? inputs.zoning.fixture === true : false;
  const zoningHonestAbsenceReason =
    inputs.zoning && "honestAbsence" in inputs.zoning ? inputs.zoning.reason : undefined;

  const floodZone: SitePlanSummaryModel["floodZone"] = inputs.floodZone ?? {
    honestUnavailable: true,
    reason: "No flood-zone read attempted for this export.",
  };

  const warmKind = inputs.envelopeOutcome?.kind;
  const warmAreaSqFt =
    warmKind === "buildable" && typeof inputs.envelopeOutcome?.areaSqFt === "number"
      ? inputs.envelopeOutcome.areaSqFt
      : null;
  const honestNote = computeBuildableAreaHonestNote(offset, inputs.envelopeOutcome);
  const buildableVocab = mapBuildableDisplay({
    envelopeStatus:
      buildableAreaSqFt != null || warmAreaSqFt != null
        ? "ok"
        : warmKind === "no-buildable-area" || offset.offsetDegenerate
          ? "no-buildable-area"
          : "ok",
    notSpecifiedAxes: anyNotSpecified(notSpecified),
    buildableAreaSqFt,
    provisional:
      warmKind === "provisional-front-edge" ||
      offset.frontEdgeUnresolved === true ||
      (honestNote != null && buildableAreaSqFt != null),
    warmEnvelopeKind: warmKind,
    warmEnvelopeAreaSqFt: warmAreaSqFt,
    offsetDegenerate: offset.offsetDegenerate,
    offsetDegenerateReason: offset.offsetDegenerateReason,
  });

  const buildablePdfLabel =
    buildableVocab.kind === "provisional" && honestNote
      ? `${
          warmAreaSqFt != null
            ? `${Math.round(warmAreaSqFt).toLocaleString("en-US")} sq ft`
            : buildableAreaSqFt != null
              ? `${Math.round(buildableAreaSqFt).toLocaleString("en-US")} sq ft`
              : "buildable area"
        } (PROVISIONAL — ${honestNote})`
      : buildableVocab.pdfLabel;

  const summary: SitePlanSummaryModel = {
    parcelNodeId: inputs.parcelNodeId,
    countyFips: parseCountyFips(inputs.parcelNodeId),
    countyName: inputs.descriptor?.countyName,
    address: inputs.descriptor?.address,
    zoningDistrict,
    zoningFixture,
    zoningHonestAbsenceReason,
    lotAreaSqFt,
    buildableAreaSqFt,
    buildableAreaHonestNote: honestNote,
    buildableDisplayKind: buildableVocab.kind,
    buildableAgreementToken: buildableVocab.agreementToken,
    buildablePdfLabel,
    elevationRangeMeters: { min: inputs.dem.minElevation, max: inputs.dem.maxElevation },
    verticalDatumSummary: TERRAIN_VERTICAL_DATUM.summary,
    floodZone,
  };

  return {
    parcelNodeId: inputs.parcelNodeId,
    bboxWgs84: inputs.bbox,
    ringLocal,
    propertySegments,
    setback,
    contours,
    contourIntervalMeters: inputs.contourIntervalMeters,
    elevationLabels: [...cornerLabels, ...contourLabels],
    streets,
    north,
    scaleBar,
    verticalDatum: TERRAIN_VERTICAL_DATUM,
    crsConvention: TERRAIN_MESH_CRS_CONVENTION,
    summary,
    citations: {
      propertyLine: inputs.geometrySourceRef ?? "parcel-geometry-ring",
      setback: setbackHonestAbsence
        ? "no setback-rule atom on file (setbacks not verified)"
        : `${inputs.setback.sourceCodeAtomRef.atomDid} (${inputs.setback.sourceCodeAtomRef.role})`,
      contour:
        inputs.contourSourceCitation ?? inputs.demSourceCitation ?? TERRAIN_VERTICAL_DATUM.source,
      zoning: zoningDistrict ? "zoning-fact atom (parcel zoning polygon)" : undefined,
      flood: "zone" in floodZone ? floodZone.sourceCitation : undefined,
    },
  };
}
