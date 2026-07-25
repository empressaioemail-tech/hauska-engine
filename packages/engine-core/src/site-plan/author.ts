import {
  fetchUsgs3depDem,
  selectAdaptiveResolutionMeters,
  type BboxWgs84,
} from "@hauska-engine/adapters";
import { femaNfhlAdapter } from "@hauska-engine/adapters/federal/fema-nfhl";
import type {
  ParcelTerrainModelAtomInstance,
  SetbackRuleAtomInstance,
  ZoningFactAtomInstance,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { TERRAIN_VERTICAL_DATUM } from "../parcel-terrain/elevation.js";
import { buildTerrainMeshGeometry } from "../parcel-terrain/mesh.js";
import { DEFAULT_SKIRT_DEPTH_FEET, type BuildTerrainSolidMassOptions } from "../parcel-terrain/solid-mass.js";
import type { ParcelGeometryResolver, TerrainArtifactStore } from "../parcel-terrain/author.js";
import { parseDemBytes, type ParsedDem } from "../site-topography/index.js";
import { emitDxfSitePlan, emitIfcSitePlan } from "./emitters.js";
import { emitPdfSitePlan } from "./pdf/render.js";
import {
  composeSitePlanModel,
  type FloodZoneSummaryInput,
  type SitePlanDescriptorInput,
  type StreetAnchorInput,
  type ZoningSummaryInput,
} from "./site-model.js";

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
  /** Fail closed if this is missing rather than inventing a setback. */
  setback: SetbackRuleAtomInstance;
  storage: StoragePort;
  artifactStore: TerrainArtifactStore;
  resolutionMeters?: number;
  contourIntervalMeters?: number;
  frontEdgeIndex?: number;
  streetAnchors?: StreetAnchorInput[];
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
}

export interface AuthorParcelSitePlanExportResult {
  atom: ParcelTerrainModelAtomInstance;
  setbackDegenerate: boolean;
  setbackDegenerateReason?: string;
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

  const resolutionMetersRequested = options.resolutionMeters ?? 10;
  const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(resolved.bbox, resolutionMetersRequested);
  const contourIntervalMeters = options.contourIntervalMeters ?? 1;
  const fetchDem = options.fetchDem ?? fetchUsgs3depDem;
  const demFetch = await fetchDem(resolved.bbox, { resolutionMeters: resolutionMetersAdapted });
  const dem = await (options.parseDem ?? parseDemBytes)(demFetch.bytes);
  const mesh = buildTerrainMeshGeometry(dem, resolved.bbox);

  const zoning: ZoningSummaryInput =
    options.zoningOverride ?? (await resolveZoningSummary(options.parcelNodeId, options.storage));
  const centroid = centroidOfRing(ringWgs84);
  const floodZone: FloodZoneSummaryInput = options.floodZoneOverride ?? (await resolveFloodZoneSummary(centroid, options.fetchFloodZone));

  const model = composeSitePlanModel({
    parcelNodeId: options.parcelNodeId,
    bbox: resolved.bbox,
    ringWgs84,
    dem,
    contourIntervalMeters,
    setback: {
      front: options.setback.front,
      side: options.setback.side,
      rear: options.setback.rear,
      sourceCodeAtomRef: options.setback.sourceCodeAtomRef,
    },
    frontEdgeIndex: options.frontEdgeIndex,
    streetAnchors: options.streetAnchors,
    geometrySourceRef: resolved.sourceRef,
    demSourceCitation: TERRAIN_VERTICAL_DATUM.source,
    descriptor: options.descriptor,
    zoning,
    floodZone,
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
      touchesNodata: dem.nodataCount > 0,
    },
    confidence: {
      value: 0.6,
      kind: "asserted",
      provenance: `USGS 3DEP DEM field; Z=${TERRAIN_VERTICAL_DATUM.summary}; calibration pending`,
      n: 0,
      intervalWidth: 1,
    },
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
    streetHonestAbsence: model.streets.honestAbsence,
  };
  atom.artifacts["pdf-site-plan"] = {
    format: "pdf-site-plan",
    ref: pdfRef,
    byteCount: pdf.bytes.byteLength,
    pageCount: pdf.pageCount,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    streetHonestAbsence: model.streets.honestAbsence,
    zoningHonestAbsence,
    floodZoneHonestUnavailable,
  };

  await options.storage.writePropertyAtom(atom);

  return {
    atom,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    streetHonestAbsence: model.streets.honestAbsence,
    zoningHonestAbsence,
    floodZoneHonestUnavailable,
    pdfPageCount: pdf.pageCount,
  };
}
