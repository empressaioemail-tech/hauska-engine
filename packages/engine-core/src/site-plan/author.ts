import {
  fetchUsgs3depDem,
  selectAdaptiveResolutionMeters,
  DEFAULT_TERRAIN_RESOLUTION_METERS,
  type BboxWgs84,
} from "@hauska-engine/adapters";
import { femaNfhlAdapter } from "@hauska-engine/adapters/federal/fema-nfhl";
import type {
  BuildableEnvelopeAtomInstance,
  ParcelTerrainModelAtomInstance,
  SetbackRuleAtomInstance,
  ZoningFactAtomInstance,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { TERRAIN_VERTICAL_DATUM } from "../parcel-terrain/elevation.js";
import { resolveContourSource } from "../parcel-terrain/contour-source.js";
import { buildTerrainMeshGeometry } from "../parcel-terrain/mesh.js";
import { DEFAULT_SKIRT_DEPTH_FEET, type BuildTerrainSolidMassOptions } from "../parcel-terrain/solid-mass.js";
import type { ParcelGeometryResolver, TerrainArtifactStore } from "../parcel-terrain/author.js";
import { parseDemBytes, type ParsedDem } from "../site-topography/index.js";
import { emitDxfSitePlan, emitIfcSitePlan } from "./emitters.js";
import { emitPdfSitePlan } from "./pdf/render.js";
import { resolveAttachingRoadNodes } from "./resolve-attaching-roads.js";
import {
  composeSitePlanModel,
  type EnvelopeOutcomeInput,
  type FloodZoneSummaryInput,
  type SitePlanDescriptorInput,
  type StreetAnchorInput,
  type ZoningSummaryInput,
} from "./site-model.js";
import {
  notSpecifiedAxesFromSetbackTable,
  resolveNotSpecifiedAxes,
} from "./setback-display.js";

/**
 * Best-effort live FEMA NFHL read for the PDF summary block. Any failure
 * (no network egress, upstream error, timeout) degrades to an honest
 * unavailable verdict rather than blocking the export or fabricating a
 * zone — mirrors the street-anchor honest-absence pattern above it.
 */
async function defaultFetchFloodZone(input: { latitude: number; longitude: number }): Promise<FloodZoneSummaryInput> {
  try {
    const result = await femaNfhlAdapter.run({
      parcel: { latitude: input.latitude, longitude: input.longitude },
      jurisdiction: { stateKey: null, localKey: null },
      signal: AbortSignal.timeout(8_000),
    });
    const payload = result.payload as { floodZone?: string | null; inSpecialFloodHazardArea?: boolean };
    return {
      zone: payload.floodZone ?? null,
      inSpecialFloodHazardArea: Boolean(payload.inSpecialFloodHazardArea),
      sourceCitation: result.provider,
      asOfIso: result.snapshotDate,
    };
  } catch (error) {
    return {
      honestUnavailable: true,
      reason: `FEMA NFHL lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Looks up the parcel's zoning-fact atom for the summary block's zoning
 * district field. Honest-absence (never fabricated) when no atom exists or
 * the atom itself carries the fact-level honest-absence verdict.
 */
async function resolveZoningSummary(parcelNodeId: string, storage: StoragePort): Promise<ZoningSummaryInput> {
  const zoningFact = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId)).find(
    (candidate): candidate is ZoningFactAtomInstance => candidate.entityType === "zoning-fact",
  );
  if (!zoningFact) {
    return { honestAbsence: true, reason: "No zoning-fact atom on file for this parcel." };
  }
  if (zoningFact.district) {
    return { district: zoningFact.district };
  }
  return {
    honestAbsence: true,
    reason: zoningFact.absence?.kind ?? "zoning-fact atom carries no district (honest absence).",
  };
}

/**
 * Wraps the (default or caller-supplied) flood-zone lookup so ANY failure —
 * upstream, network, or a broken test stub — degrades to honest-unavailable
 * rather than rejecting the whole export. A missing flood read is never a
 * reason to withhold parcel/setback/terrain data the caller already has.
 */
async function resolveFloodZoneSummary(
  centroid: { latitude: number; longitude: number },
  fetchFloodZone: ((input: { latitude: number; longitude: number }) => Promise<FloodZoneSummaryInput>) | undefined,
): Promise<FloodZoneSummaryInput> {
  try {
    return await (fetchFloodZone ?? defaultFetchFloodZone)(centroid);
  } catch (error) {
    return {
      honestUnavailable: true,
      reason: `Flood-zone lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Best-effort lookup of the parcel's own buildable-envelope atom outcome
 * (a separate reasoning pipeline from this composer's own front-edge-basis
 * heuristic — see `property-reasoning/emit-buildable-envelope.ts`). Absent
 * atom is not an error: the site-plan buildable-area figure and its honesty
 * note stand on the composer's own ring-geometry basis regardless.
 */
async function resolveEnvelopeOutcome(
  parcelNodeId: string,
  storage: StoragePort,
): Promise<EnvelopeOutcomeInput | undefined> {
  const envelope = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId)).find(
    (candidate): candidate is BuildableEnvelopeAtomInstance => candidate.entityType === "buildable-envelope",
  );
  return envelope?.outcome;
}

function centroidOfRing(ringWgs84: Array<[number, number]>): { latitude: number; longitude: number } {
  const n = ringWgs84.length;
  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of ringWgs84) {
    sumLng += lng;
    sumLat += lat;
  }
  return { longitude: sumLng / n, latitude: sumLat / n };
}

export interface AuthorParcelSitePlanExportOptions {
  parcelNodeId: string;
  bboxOverride?: BboxWgs84;
  /** Test/operator override for the parcel boundary ring; production path
   * requires the resolver to supply one (fail closed otherwise). */
  ringOverride?: Array<[number, number]>;
  resolver: ParcelGeometryResolver;
  /**
   * The parcel's setback-rule atom. OPTIONAL: when absent, the export still
   * succeeds — the setback layer is drawn honest-absent (no F/S/R fabricated;
   * the offset ring equals the property line) and the sheet says "setbacks
   * not specified / not verified". A rule that IS present is drawn as before.
   * This never fabricates a setback — absent is honestly labeled absent.
   */
  setback?: SetbackRuleAtomInstance;
  storage: StoragePort;
  artifactStore: TerrainArtifactStore;
  resolutionMeters?: number;
  contourIntervalMeters?: number;
  frontEdgeIndex?: number;
  streetAnchors?: StreetAnchorInput[];
  /**
   * When true (default), load attaching road-nodes from storage when
   * streetAnchors are omitted. Set false in tests that assert honest-absence
   * without seeding road-nodes.
   */
  resolveStreetFromRoadNodes?: boolean;
  skirtDepthFeet?: number;
  fetchDem?: typeof fetchUsgs3depDem;
  parseDem?: (bytes: Uint8Array) => Promise<ParsedDem>;
  /** PDF summary-block-only descriptors (Wave 2). Caller-supplied only. */
  descriptor?: SitePlanDescriptorInput;
  /** Explicit zoning override (test seam); production path looks up the
   * parcel's zoning-fact atom from storage when omitted. */
  zoningOverride?: ZoningSummaryInput;
  /** Explicit flood-zone override (test seam); production path calls the
   * FEMA NFHL adapter when omitted, degrading to honest-unavailable on
   * any failure. */
  floodZoneOverride?: FloodZoneSummaryInput;
  fetchFloodZone?: (input: { latitude: number; longitude: number }) => Promise<FloodZoneSummaryInput>;
  /** Explicit buildable-envelope outcome override (test seam); production
   * path looks up the parcel's buildable-envelope atom from storage when
   * omitted (absence is not an error — see `resolveEnvelopeOutcome`). */
  envelopeOutcomeOverride?: EnvelopeOutcomeInput;
}

export interface AuthorParcelSitePlanExportResult {
  atom: ParcelTerrainModelAtomInstance;
  setbackDegenerate: boolean;
  setbackDegenerateReason?: string;
  /** True when no setback-rule atom existed — layer drawn honest-absent. */
  setbackHonestAbsence: boolean;
  setbackHonestAbsenceReason?: string;
  streetHonestAbsence: boolean;
  zoningHonestAbsence: boolean;
  floodZoneHonestUnavailable: boolean;
  pdfPageCount: number;
}

/**
 * Authors dxf-site-plan / ifc-site-plan artifacts and merges them additively
 * into the parcel's `parcel-terrain-model` atom (creating one if absent).
 * This intentionally does not touch the existing glb/ifc/dxf-3dface/
 * dxf-contour artifacts — Wave 1 extends the terrain-export path, it does
 * not replace it.
 */
export async function authorParcelSitePlanExport(
  options: AuthorParcelSitePlanExportOptions,
): Promise<AuthorParcelSitePlanExportResult> {
  const resolved = options.bboxOverride
    ? { bbox: options.bboxOverride, sourceRef: "request:bbox-override", ring: options.ringOverride }
    : await options.resolver.resolve(options.parcelNodeId);
  if (!resolved) {
    throw new Error(
      `Parcel geometry unavailable for ${options.parcelNodeId}; configure a spine resolver or supply bboxOverride+ringOverride for a test.`,
    );
  }
  const ringWgs84 = options.ringOverride ?? resolved.ring;
  if (!ringWgs84 || ringWgs84.length < 3) {
    throw new Error(
      `Parcel ${options.parcelNodeId} resolver returned no boundary ring; site-plan PROPERTY_LINE ` +
        "refuses to approximate a ring from the bbox rectangle. Wire a ring-capable resolver or supply ringOverride for a test.",
    );
  }

  const resolutionMetersRequested = options.resolutionMeters ?? DEFAULT_TERRAIN_RESOLUTION_METERS;
  const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(resolved.bbox, resolutionMetersRequested);
  const contourIntervalMeters = options.contourIntervalMeters ?? 1;
  const fetchDem = options.fetchDem ?? fetchUsgs3depDem;
  const demFetch = await fetchDem(resolved.bbox, {
    resolutionMeters: resolutionMetersAdapted,
    resolveActualResolution: true,
  });
  const dem = await (options.parseDem ?? parseDemBytes)(demFetch.bytes);
  const mesh = buildTerrainMeshGeometry(dem, resolved.bbox);

  // Authoritative 1-ft contour tier where covered (Bastrop), else honest
  // 3DEP-derived fallback. Mesh Z (above) is untouched — 3DEP only.
  const contourSource = await resolveContourSource({
    dem,
    bbox: resolved.bbox,
    contourIntervalMeters,
  });

  const zoning: ZoningSummaryInput =
    options.zoningOverride ?? (await resolveZoningSummary(options.parcelNodeId, options.storage));
  const centroid = centroidOfRing(ringWgs84);
  const floodZone: FloodZoneSummaryInput = options.floodZoneOverride ?? (await resolveFloodZoneSummary(centroid, options.fetchFloodZone));
  const envelopeOutcome: EnvelopeOutcomeInput | undefined =
    options.envelopeOutcomeOverride ?? (await resolveEnvelopeOutcome(options.parcelNodeId, options.storage));

  // Honest-absent path: NO setback-rule atom for this parcel. The export
  // still succeeds — the setback layer is drawn honest-absent (no F/S/R
  // fabricated) rather than refusing the whole sheet. `notSpecified` /
  // districtCode enrichment only applies when a rule actually exists.
  const setbackHonestAbsence = !options.setback;
  const setbackAtom = options.setback as
    | (SetbackRuleAtomInstance & {
        districtCode?: string;
        fieldProvenance?: unknown;
      })
    | undefined;

  // not_specified ≠ missing: enrich silent axes from fieldProvenance and/or
  // the B3 table so the sheet can label them honestly without refusing export.
  // Contract types may lag the runtime `notSpecified` flag written by emit-setback-rule.
  const districtCode =
    setbackAtom?.districtCode ??
    ("district" in zoning ? zoning.district : undefined);
  const tableAxes = setbackHonestAbsence
    ? undefined
    : notSpecifiedAxesFromSetbackTable(undefined, districtCode);
  const fieldProvenance = setbackAtom?.fieldProvenance as
    | {
        front?: { notSpecified?: boolean };
        side?: { notSpecified?: boolean };
        rear?: { notSpecified?: boolean };
      }
    | undefined;
  const notSpecified = setbackHonestAbsence
    ? undefined
    : resolveNotSpecifiedAxes({
        fieldProvenance,
        tableAxes,
      });

  // Track B1: STREET from attaching road-nodes (centerline + ROW edges).
  // Caller-supplied streetAnchors win; otherwise resolve from ledger.
  let streetAnchors = options.streetAnchors;
  if (
    (!streetAnchors || streetAnchors.length === 0) &&
    options.resolveStreetFromRoadNodes !== false
  ) {
    const resolvedRoads = await resolveAttachingRoadNodes({
      parcelNodeId: options.parcelNodeId,
      ringWgs84,
      storage: options.storage,
    });
    streetAnchors = resolvedRoads.streetAnchors;
  }

  const model = composeSitePlanModel({
    parcelNodeId: options.parcelNodeId,
    bbox: resolved.bbox,
    ringWgs84,
    dem,
    contourIntervalMeters,
    setback: setbackHonestAbsence
      ? {
          // No rule atom: zero inset on every axis (offset ring == property
          // line, nothing fabricated), flagged honest-absent for the legend.
          front: 0,
          side: 0,
          rear: 0,
          sourceCodeAtomRef: {
            atomDid: "no-setback-rule-atom",
            role: "honest-absence",
            entityType: "setback-rule",
          },
          honestAbsence: true,
        }
      : {
          front: options.setback!.front,
          side: options.setback!.side,
          rear: options.setback!.rear,
          sourceCodeAtomRef: options.setback!.sourceCodeAtomRef,
          notSpecified,
        },
    frontEdgeIndex: options.frontEdgeIndex,
    streetAnchors,
    geometrySourceRef: resolved.sourceRef,
    demSourceCitation: TERRAIN_VERTICAL_DATUM.source,
    contourOverride: contourSource.polylines,
    contourSourceCitation:
      contourSource.provenance.tier === "authoritative-1ft"
        ? `${contourSource.provenance.source} (${contourSource.provenance.vintage}, ${contourSource.provenance.intervalLabel})`
        : TERRAIN_VERTICAL_DATUM.source,
    descriptor: options.descriptor,
    zoning,
    floodZone,
    envelopeOutcome,
  });

  const solidMassOptions: BuildTerrainSolidMassOptions = {
    skirtDepthFeet: options.skirtDepthFeet ?? DEFAULT_SKIRT_DEPTH_FEET,
  };

  const dxf = await emitDxfSitePlan(model, mesh);
  const ifc = await emitIfcSitePlan(model, mesh, "USGS 3DEP", solidMassOptions);
  if (ifc.status !== "ok" || !ifc.ifcText) {
    throw new Error(`IFC site-plan emission failed: ${ifc.message ?? "unknown worker error"}`);
  }
  if (!ifc.spatialValidation?.ok) {
    throw new Error(
      `IFC site-plan spatial model incomplete: ${
        (ifc.spatialValidation as { errors?: string[] } | undefined)?.errors?.join("; ") ?? "validation missing"
      }`,
    );
  }

  const existing = (await options.storage.listPropertyAtomsByParcelNodeId(options.parcelNodeId)).find(
    (candidate): candidate is ParcelTerrainModelAtomInstance => candidate.entityType === "parcel-terrain-model",
  );
  const fetchedAt = new Date().toISOString();
  const atom: ParcelTerrainModelAtomInstance = existing ?? {
    entityType: "parcel-terrain-model",
    atomDid: `pterrain_siteplan_${options.parcelNodeId.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.parse(fetchedAt)}`,
    entityId: options.parcelNodeId,
    parcelNodeId: options.parcelNodeId,
    jurisdictionTenant: "property-spine",
    fetchedAt,
    extractedAt: fetchedAt,
    sourceAdapter: "usgs:3dep-dem",
    sourceUrl: demFetch.endpoint,
    sourceCitation: "USGS 3DEP",
    accessPolicy: "public-paid",
    atomTier: "data",
    status: "active",
    contentHash: "",
    reasoningChain: {
      reasoningKind: "derived",
      derivationMethod: "parcel-terrain-mesh-ifc-v1",
      inputAtomRefs: [{ atomDid: resolved.sourceRef, role: "reference-field", citationLabel: "usgs-3dep-dem" }],
    },
    artifacts: {},
    coverage: {
      coverageFraction: 1 - dem.nodataCount / (dem.width * dem.height),
      nodataCount: dem.nodataCount,
      totalCells: dem.width * dem.height,
      resolutionMetersRequested,
      resolutionMetersActual: demFetch.resolutionMetersActual,
      resolutionMetersAdapted,
      touchesNodata: dem.nodataCount > 0,
      contourSource: {
        tier: contourSource.provenance.tier,
        source: contourSource.provenance.source,
        vintage: contourSource.provenance.vintage,
        intervalLabel: contourSource.provenance.intervalLabel,
        polylineCount: contourSource.provenance.polylineCount,
        ...(contourSource.provenance.fallbackReason
          ? { fallbackReason: contourSource.provenance.fallbackReason }
          : {}),
      },
    },
    confidence: {
      value: 0.6,
      kind: "asserted",
      provenance: `USGS 3DEP DEM field; Z=${TERRAIN_VERTICAL_DATUM.summary}; calibration pending`,
      n: 0,
      intervalWidth: 1,
    },
  };

  // When merging into an EXISTING terrain atom, refresh the contour-tier
  // provenance so the atom reflects the source actually drawn this run.
  atom.coverage.contourSource = {
    tier: contourSource.provenance.tier,
    source: contourSource.provenance.source,
    vintage: contourSource.provenance.vintage,
    intervalLabel: contourSource.provenance.intervalLabel,
    polylineCount: contourSource.provenance.polylineCount,
    ...(contourSource.provenance.fallbackReason
      ? { fallbackReason: contourSource.provenance.fallbackReason }
      : {}),
  };

  const dxfRef = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "dxf-site-plan",
    bytes: dxf.bytes,
    contentType: "application/dxf",
  });
  const ifcBytes = new TextEncoder().encode(ifc.ifcText);
  const ifcRef = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "ifc-site-plan",
    bytes: ifcBytes,
    contentType: "application/step",
  });

  const pdf = await emitPdfSitePlan(model);
  const pdfRef = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "pdf-site-plan",
    bytes: pdf.bytes,
    contentType: "application/pdf",
  });

  const zoningHonestAbsence = "honestAbsence" in zoning;
  const floodZoneHonestUnavailable = "honestUnavailable" in floodZone;

  atom.artifacts["dxf-site-plan"] = {
    format: "dxf-site-plan",
    ref: dxfRef,
    byteCount: dxf.bytes.byteLength,
    contourIntervalMeters,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    setbackHonestAbsence,
    setbackHonestAbsenceReason: model.setback.honestAbsenceReason,
    streetHonestAbsence: model.streets.honestAbsence,
  };
  atom.artifacts["ifc-site-plan"] = {
    format: "ifc-site-plan",
    ref: ifcRef,
    byteCount: ifcBytes.byteLength,
    vertexCount: ifc.vertexCount,
    triangleCount: ifc.triangleCount,
    annotationCount: ifc.annotationCount,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    setbackHonestAbsence,
    setbackHonestAbsenceReason: model.setback.honestAbsenceReason,
    streetHonestAbsence: model.streets.honestAbsence,
  };
  atom.artifacts["pdf-site-plan"] = {
    format: "pdf-site-plan",
    ref: pdfRef,
    byteCount: pdf.bytes.byteLength,
    pageCount: pdf.pageCount,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    setbackHonestAbsence,
    setbackHonestAbsenceReason: model.setback.honestAbsenceReason,
    streetHonestAbsence: model.streets.honestAbsence,
    zoningHonestAbsence,
    floodZoneHonestUnavailable,
  };

  await options.storage.writePropertyAtom(atom);

  return {
    atom,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    setbackHonestAbsence,
    setbackHonestAbsenceReason: model.setback.honestAbsenceReason,
    streetHonestAbsence: model.streets.honestAbsence,
    zoningHonestAbsence,
    floodZoneHonestUnavailable,
    pdfPageCount: pdf.pageCount,
  };
}
