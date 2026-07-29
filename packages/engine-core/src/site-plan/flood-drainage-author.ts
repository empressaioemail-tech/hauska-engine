import type { ParcelTerrainModelAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import type { ParcelGeometryResolver, TerrainArtifactStore } from "../parcel-terrain/author.js";
import {
  runFloodDrainageStudy,
  type FloodDrainageStudy,
  type RunFloodDrainageStudyOptions,
} from "./flood-drainage-study.js";
import {
  emitPdfFloodDrainage,
  type FloodDrainageDescriptor,
  type PdfFloodDrainageResult,
} from "./pdf/flood-drainage.js";

/**
 * FLOOD & DRAINAGE report authoring (2026-07-29, R3).
 *
 * Runs the parcel-scoped drainage study ONCE, renders the Sheet-Standard
 * PDF from that same study, and records BOTH artifacts on the parcel's
 * `parcel-terrain-model` atom (same recording seam as pdf-site-plan /
 * pdf-dossier):
 *
 *   - `pdf-flood-drainage`   — the two-sheet report document.
 *   - `json-flood-drainage-study` — the study payload, cached for the
 *     GET /study route (the PE dock visualization) so refresh computes
 *     once and every consumer reads the SAME result.
 *
 * Honest-empty (flat terrain / DEM void) still authors both artifacts —
 * the sheets carry the honest panel and the artifact records the flag.
 * A geometry/DEM-fetch failure throws (the route returns an honest 422);
 * nothing is fabricated in either direction.
 */
export interface AuthorParcelFloodDrainageReportOptions
  extends Omit<RunFloodDrainageStudyOptions, "resolver"> {
  resolver: ParcelGeometryResolver;
  storage: StoragePort;
  artifactStore: TerrainArtifactStore;
  /** PDF header descriptors — caller-supplied only, never fabricated. */
  descriptor?: FloodDrainageDescriptor;
  /** Test seam for a stable generated stamp. */
  generatedAtIso?: string;
}

export interface AuthorParcelFloodDrainageReportResult {
  atom: ParcelTerrainModelAtomInstance;
  study: FloodDrainageStudy;
  pdf: Omit<PdfFloodDrainageResult, "bytes">;
  pageCount: number;
  honestEmpty: boolean;
  honestEmptyReason?: string;
}

export async function authorParcelFloodDrainageReport(
  options: AuthorParcelFloodDrainageReportOptions,
): Promise<AuthorParcelFloodDrainageReportResult> {
  const { study, dem, demFetch, resolutionMetersRequested, resolutionMetersAdapted, resolvedSourceRef } =
    await runFloodDrainageStudy(options);

  const pdf = await emitPdfFloodDrainage(study, options.descriptor ?? {}, {
    generatedAtIso: options.generatedAtIso,
  });

  const pdfRef = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "pdf-flood-drainage",
    bytes: pdf.bytes,
    contentType: "application/pdf",
  });
  const studyBytes = new TextEncoder().encode(JSON.stringify(study));
  const studyRef = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "json-flood-drainage-study",
    bytes: studyBytes,
    contentType: "application/json",
  });

  const existing = (await options.storage.listPropertyAtomsByParcelNodeId(options.parcelNodeId)).find(
    (candidate): candidate is ParcelTerrainModelAtomInstance =>
      candidate.entityType === "parcel-terrain-model",
  );
  const fetchedAt = new Date().toISOString();
  const atom: ParcelTerrainModelAtomInstance = existing ?? {
    entityType: "parcel-terrain-model",
    atomDid: `pterrain_flood_${options.parcelNodeId.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.parse(fetchedAt)}`,
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
      inputAtomRefs: [
        { atomDid: resolvedSourceRef, role: "reference-field", citationLabel: "usgs-3dep-dem" },
      ],
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
    },
    confidence: {
      value: 0.6,
      kind: "asserted",
      provenance: "USGS 3DEP DEM field; screening-level drainage model; calibration pending",
      n: 0,
      intervalWidth: 1,
    },
  };

  const sharedArtifactFields = {
    ...(study.honestEmpty
      ? { honestEmpty: true, honestEmptyReason: study.honestEmpty.reason }
      : {}),
    rainfallDepthInches: study.rainfallDepthInches,
    rainfallSource: study.rainfallSource,
    computationLibrary: study.computation.library,
    flowExitCount: study.stats.flowExitCount,
  };
  atom.artifacts["pdf-flood-drainage"] = {
    format: "pdf-flood-drainage",
    ref: pdfRef,
    byteCount: pdf.bytes.byteLength,
    pageCount: pdf.pageCount,
    ...sharedArtifactFields,
  };
  atom.artifacts["json-flood-drainage-study"] = {
    format: "json-flood-drainage-study",
    ref: studyRef,
    byteCount: studyBytes.byteLength,
    ...sharedArtifactFields,
  };

  await options.storage.writePropertyAtom(atom);

  const { bytes: _bytes, ...pdfMeta } = pdf;
  return {
    atom,
    study,
    pdf: pdfMeta,
    pageCount: pdf.pageCount,
    honestEmpty: !!study.honestEmpty,
    ...(study.honestEmpty ? { honestEmptyReason: study.honestEmpty.reason } : {}),
  };
}
