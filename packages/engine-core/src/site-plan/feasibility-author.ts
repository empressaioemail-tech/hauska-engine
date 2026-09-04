import type { ParcelTerrainModelAtomInstance } from "@hauska-engine/atoms";

import {
  composeSitePlanModelForParcel,
  type AuthorParcelSitePlanExportOptions,
  type ComposeSitePlanModelForParcelResult,
} from "./author.js";
import { composeFeasibilityModel, type WhoServesResolver } from "./feasibility-model.js";
import { emitPdfFeasibility, type PdfFeasibilityResult } from "./pdf/feasibility.js";

/**
 * FEASIBILITY STUDY export authoring (P-32 wave 1, 2026-09-04).
 *
 * Same shape as `authorParcelPropertyDossierExport`: composes the site-plan
 * model (one geometry truth, shared with every other report), then the
 * Feasibility model (this report's own direct atom reads), then the PDF,
 * then persists bytes + a record onto the SAME `parcel-terrain-model` atom
 * every report type reuses — never a second entity type.
 *
 * HONEST-DEGRADE CONTRACT, same as the dossier: a missing site-plan
 * capability never fails the report. A missing who-serves centroid or a
 * failing who-serves read never fails the report either (feasibility-model's
 * own contract) — the utilities section ships honest-absent instead.
 */
export interface AuthorParcelFeasibilityExportOptions
  extends Omit<AuthorParcelSitePlanExportOptions, "descriptor"> {
  descriptor?: { address?: string; countyName?: string };
  whoServes?: WhoServesResolver;
  /** Parcel centroid for the who-serves point read. Derived from the ring
   * when omitted and a ring is available; the read is skipped (honest
   * absence) when neither is supplied. */
  centroidOverride?: { latitude: number; longitude: number };
  floodStudyAvailable?: boolean;
  liveViewUrl?: string;
  narrativeOverride?: { text: string; generatedBy: string; generatedAt: string };
}

export interface AuthorParcelFeasibilityExportResult {
  atom: ParcelTerrainModelAtomInstance;
  pageCount: number;
  feasibilityPageCount: number;
  sitePlanAppended: boolean;
  sitePlanUnavailableReason?: string;
  sectionCount: number;
  openItemCount: number;
  narrativeIsDeterministicSkeleton: boolean;
}

function sitePlanUnavailableReasonFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/geometry unavailable|no boundary ring|resolver/i.test(message)) {
    return "parcel geometry could not be resolved for this parcel";
  }
  if (/dem|elevation|3dep/i.test(message)) {
    return "terrain elevation data could not be fetched for this parcel";
  }
  return "site-plan authoring failed for this parcel";
}

function centroidOfRing(ringWgs84: ReadonlyArray<[number, number]>): { latitude: number; longitude: number } {
  const n = ringWgs84.length;
  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of ringWgs84) {
    sumLng += lng;
    sumLat += lat;
  }
  return { longitude: sumLng / n, latitude: sumLat / n };
}

export async function authorParcelFeasibilityExport(
  options: AuthorParcelFeasibilityExportOptions,
): Promise<AuthorParcelFeasibilityExportResult> {
  // 1) Site-plan model composition — best effort, never fatal. Same pattern
  // as the dossier author.
  let composed: ComposeSitePlanModelForParcelResult | undefined;
  let sitePlanUnavailableReason: string | undefined;
  try {
    composed = await composeSitePlanModelForParcel({
      ...options,
      descriptor: options.descriptor,
    });
  } catch (error) {
    composed = undefined;
    sitePlanUnavailableReason = sitePlanUnavailableReasonFromError(error);
  }

  if (!composed) {
    // The Feasibility model REQUIRES a SitePlanModel (it reads
    // summary/setback fields directly, unlike the dossier which degrades to
    // a cover-only page). Fail closed with the honest reason rather than
    // emit a report with fabricated geometry-derived fields.
    throw new Error(
      `Feasibility report requires a resolvable site plan; none was available: ${sitePlanUnavailableReason}`,
    );
  }

  // 2) Centroid for the who-serves read: caller override, else derived from
  // the resolved ring, never fabricated.
  const centroid =
    options.centroidOverride ??
    (options.ringOverride ? centroidOfRing(options.ringOverride) : undefined);

  // 3) Feasibility model composition (direct atom reads).
  const model = await composeFeasibilityModel({
    parcelNodeId: options.parcelNodeId,
    storage: options.storage,
    sitePlan: composed.model,
    centroid,
    whoServes: options.whoServes,
    floodStudyAvailable: options.floodStudyAvailable,
  });

  // 4) Assemble the PDF.
  const pdf: PdfFeasibilityResult = await emitPdfFeasibility(model, {
    sitePlan: { model: composed.model },
    liveViewUrl: options.liveViewUrl,
    narrativeOverride: options.narrativeOverride,
  });

  // 5) Persist bytes + record on the shared parcel-terrain-model atom.
  const ref = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "pdf-feasibility",
    bytes: pdf.bytes,
    contentType: "application/pdf",
  });

  const existing = (await options.storage.listPropertyAtomsByParcelNodeId(options.parcelNodeId)).find(
    (candidate): candidate is ParcelTerrainModelAtomInstance => candidate.entityType === "parcel-terrain-model",
  );
  const fetchedAt = new Date().toISOString();
  const atom: ParcelTerrainModelAtomInstance =
    existing ?? {
      entityType: "parcel-terrain-model",
      atomDid: `pterrain_feasibility_${options.parcelNodeId.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.parse(fetchedAt)}`,
      entityId: options.parcelNodeId,
      parcelNodeId: options.parcelNodeId,
      jurisdictionTenant: "property-spine",
      fetchedAt,
      extractedAt: fetchedAt,
      sourceAdapter: "usgs:3dep-dem",
      sourceUrl: composed.demFetch.endpoint,
      sourceCitation: "USGS 3DEP",
      accessPolicy: "public-paid",
      atomTier: "data",
      status: "active",
      contentHash: "",
      reasoningChain: {
        reasoningKind: "derived",
        derivationMethod: "parcel-terrain-mesh-ifc-v1",
        inputAtomRefs: [
          { atomDid: composed.resolvedSourceRef, role: "reference-field", citationLabel: "usgs-3dep-dem" },
        ],
      },
      artifacts: {},
      coverage: {
        coverageFraction: 1 - composed.dem.nodataCount / (composed.dem.width * composed.dem.height),
        nodataCount: composed.dem.nodataCount,
        totalCells: composed.dem.width * composed.dem.height,
        resolutionMetersRequested: composed.resolutionMetersRequested,
        resolutionMetersActual: composed.demFetch.resolutionMetersActual,
        resolutionMetersAdapted: composed.resolutionMetersAdapted,
        touchesNodata: composed.dem.nodataCount > 0,
      },
      confidence: {
        value: 0.6,
        kind: "asserted",
        provenance: "USGS 3DEP DEM field; calibration pending",
        n: 0,
        intervalWidth: 1,
      },
    };

  atom.artifacts["pdf-feasibility"] = {
    format: "pdf-feasibility",
    ref,
    byteCount: pdf.bytes.byteLength,
    pageCount: pdf.pageCount,
    sitePlanAppended: pdf.sitePlanAppended,
    ...(pdf.sitePlanUnavailableReason ? { sitePlanUnavailableReason: pdf.sitePlanUnavailableReason } : {}),
    feasibilitySectionCount: pdf.sectionCount,
    feasibilityOpenItemCount: pdf.openItemCount,
    feasibilitySupersededRunNoted: model.dataQuality.supersededNotes.length > 0,
    narrativeGrounded: pdf.narrativeGrounded,
    narrativeIsDeterministicSkeleton: pdf.narrativeIsDeterministicSkeleton,
    whoServesMeasured: model.utilities.status === "present",
  };

  await options.storage.writePropertyAtom(atom);

  return {
    atom,
    pageCount: pdf.pageCount,
    feasibilityPageCount: pdf.feasibilityPageCount,
    sitePlanAppended: pdf.sitePlanAppended,
    sitePlanUnavailableReason: pdf.sitePlanUnavailableReason,
    sectionCount: pdf.sectionCount,
    openItemCount: pdf.openItemCount,
    narrativeIsDeterministicSkeleton: pdf.narrativeIsDeterministicSkeleton,
  };
}
