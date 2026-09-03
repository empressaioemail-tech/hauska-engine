import type { ParcelTerrainModelAtomInstance } from "@hauska-engine/atoms";

import {
  composeSitePlanModelForParcel,
  type AuthorParcelSitePlanExportOptions,
  type ComposeSitePlanModelForParcelResult,
} from "./author.js";
import {
  emitPdfDossier,
  type DossierContentInput,
  type PdfDossierResult,
} from "./pdf/dossier.js";

/**
 * PROPERTY DOSSIER export authoring (2026-07-29).
 *
 * Composes the one hand-to-client dossier PDF: Standard-styled cover
 * (verdict) + cited brief facts + AI chat summary + owner notes, with the
 * parcel's site-plan sheets appended. The site-plan leg reuses the SAME
 * model-composition path as `authorParcelSitePlanExport`
 * (`composeSitePlanModelForParcel`) — one geometry truth — but skips the
 * DXF/IFC emissions the dossier does not ship, staying inside the site-plan
 * refresh wall-time envelope.
 *
 * HONEST-DEGRADE CONTRACT: a missing site-plan capability (unresolvable
 * geometry, no ring, DEM failure — anything the composition throws on)
 * NEVER fails the dossier. The dossier pages still emit, the cover carries
 * the honest reason, and the artifact records `sitePlanAppended: false`.
 */
export interface AuthorParcelPropertyDossierExportOptions
  extends Omit<AuthorParcelSitePlanExportOptions, "descriptor"> {
  /** Request-carried dossier content (verdict / brief facts / chat summary /
   * notes). Rendered verbatim after server-side sanitization — the engine
   * never fabricates or verifies user-supplied content. */
  content: Omit<DossierContentInput, "parcelNodeId">;
}

export interface AuthorParcelPropertyDossierExportResult {
  atom: ParcelTerrainModelAtomInstance;
  pageCount: number;
  dossierPageCount: number;
  sitePlanAppended: boolean;
  sitePlanUnavailableReason?: string;
  verdictIncluded: boolean;
  briefSectionCount: number;
  briefFactCount: number;
  chatSummaryIncluded: boolean;
  notesIncluded: boolean;
  /** Site-plan honesty flags (present only when the sheets were appended). */
  setbackDegenerate?: boolean;
  setbackDegenerateReason?: string;
  setbackHonestAbsence?: boolean;
  setbackHonestAbsenceReason?: string;
  streetHonestAbsence?: boolean;
  zoningHonestAbsence?: boolean;
  floodZoneHonestUnavailable?: boolean;
}

/** §11-safe honest reason from a composition failure: the machine detail
 * stays out of the sheet; the full error is returned for the API response. */
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

export async function authorParcelPropertyDossierExport(
  options: AuthorParcelPropertyDossierExportOptions,
): Promise<AuthorParcelPropertyDossierExportResult> {
  // 1) Site-plan model composition — best effort, never fatal.
  let composed: ComposeSitePlanModelForParcelResult | undefined;
  let sitePlanUnavailableReason: string | undefined;
  try {
    composed = await composeSitePlanModelForParcel({
      ...options,
      // The appended sheets print the SAME request-carried descriptors the
      // dossier header prints (caller-supplied only, never fabricated).
      descriptor:
        options.content.address || options.content.countyName
          ? { address: options.content.address, countyName: options.content.countyName }
          : undefined,
    });
  } catch (error) {
    composed = undefined;
    sitePlanUnavailableReason = sitePlanUnavailableReasonFromError(error);
  }

  // 2) Assemble the dossier (sheets appended when composition succeeded).
  const pdf: PdfDossierResult = await emitPdfDossier(
    {
      parcelNodeId: options.parcelNodeId,
      ...options.content,
      // The dossier header prefers request-carried descriptors; when absent,
      // fall back to what the composed model already carries (same values the
      // site-plan sheets print) — never a fabricated descriptor.
      address: options.content.address ?? composed?.model.summary.address,
      countyName: options.content.countyName ?? composed?.model.summary.countyName,
    },
    composed
      ? { sitePlan: { model: composed.model } }
      : { sitePlanUnavailableReason },
  );

  // 3) Persist bytes + record the artifact on the parcel-terrain-model atom
  // (same recording seam as pdf-site-plan).
  const ref = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "pdf-dossier",
    bytes: pdf.bytes,
    contentType: "application/pdf",
  });

  const existing = (await options.storage.listPropertyAtomsByParcelNodeId(options.parcelNodeId)).find(
    (candidate): candidate is ParcelTerrainModelAtomInstance =>
      candidate.entityType === "parcel-terrain-model",
  );
  const fetchedAt = new Date().toISOString();
  const atom: ParcelTerrainModelAtomInstance =
    existing ??
    (composed
      ? {
          entityType: "parcel-terrain-model",
          atomDid: `pterrain_dossier_${options.parcelNodeId.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.parse(fetchedAt)}`,
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
            coverageFraction:
              1 - composed.dem.nodataCount / (composed.dem.width * composed.dem.height),
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
        }
      : {
          // Honest dossier-only record: NO terrain was resolved for this
          // parcel (composition failed) and no prior terrain atom exists.
          // Coverage is recorded as zero — explicitly labeled, never a
          // fabricated terrain claim; the atom exists to carry the dossier
          // artifact ref so download stays serviceable.
          entityType: "parcel-terrain-model",
          atomDid: `pterrain_dossier_${options.parcelNodeId.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.parse(fetchedAt)}`,
          entityId: options.parcelNodeId,
          parcelNodeId: options.parcelNodeId,
          jurisdictionTenant: "property-spine",
          fetchedAt,
          extractedAt: fetchedAt,
          sourceAdapter: "dossier:no-terrain-resolved",
          sourceUrl: "",
          sourceCitation: "no terrain data resolved for this export",
          accessPolicy: "public-paid",
          atomTier: "data",
          status: "active",
          contentHash: "",
          reasoningChain: {
            reasoningKind: "derived",
            derivationMethod: "parcel-terrain-mesh-ifc-v1",
            inputAtomRefs: [
              { atomDid: "dossier:no-terrain-resolved", role: "reference-field", citationLabel: "usgs-3dep-dem" },
            ],
          },
          artifacts: {},
          coverage: {
            coverageFraction: 0,
            nodataCount: 0,
            totalCells: 0,
            resolutionMetersRequested: null,
            resolutionMetersActual: null,
            touchesNodata: false,
          },
          confidence: {
            value: 0.3,
            kind: "asserted",
            provenance: "dossier-only record; no terrain data resolved on this run",
            n: 0,
            intervalWidth: 1,
          },
        });

  atom.artifacts["pdf-dossier"] = {
    format: "pdf-dossier",
    ref,
    byteCount: pdf.bytes.byteLength,
    pageCount: pdf.pageCount,
    dossierPageCount: pdf.dossierPageCount,
    sitePlanAppended: pdf.sitePlanAppended,
    ...(pdf.sitePlanUnavailableReason
      ? { sitePlanUnavailableReason: pdf.sitePlanUnavailableReason }
      : {}),
    verdictIncluded: pdf.verdictIncluded,
    briefSectionCount: pdf.briefSectionCount,
    briefFactCount: pdf.briefFactCount,
    chatSummaryIncluded: pdf.chatSummaryIncluded,
    notesIncluded: pdf.notesIncluded,
    ...(composed
      ? {
          setbackDegenerate: composed.model.setback.degenerate,
          setbackDegenerateReason: composed.model.setback.degenerateReason,
          setbackHonestAbsence: composed.setbackHonestAbsence,
          setbackHonestAbsenceReason: composed.model.setback.honestAbsenceReason,
          streetHonestAbsence: composed.model.streets.honestAbsence,
          zoningHonestAbsence: "honestAbsence" in composed.zoning,
          floodZoneHonestUnavailable: "honestUnavailable" in composed.floodZone,
        }
      : {}),
  };

  await options.storage.writePropertyAtom(atom);

  return {
    atom,
    pageCount: pdf.pageCount,
    dossierPageCount: pdf.dossierPageCount,
    sitePlanAppended: pdf.sitePlanAppended,
    sitePlanUnavailableReason: pdf.sitePlanUnavailableReason,
    verdictIncluded: pdf.verdictIncluded,
    briefSectionCount: pdf.briefSectionCount,
    briefFactCount: pdf.briefFactCount,
    chatSummaryIncluded: pdf.chatSummaryIncluded,
    notesIncluded: pdf.notesIncluded,
    ...(composed
      ? {
          setbackDegenerate: composed.model.setback.degenerate,
          setbackDegenerateReason: composed.model.setback.degenerateReason,
          setbackHonestAbsence: composed.setbackHonestAbsence,
          setbackHonestAbsenceReason: composed.model.setback.honestAbsenceReason,
          streetHonestAbsence: composed.model.streets.honestAbsence,
          zoningHonestAbsence: "honestAbsence" in composed.zoning,
          floodZoneHonestUnavailable: "honestUnavailable" in composed.floodZone,
        }
      : {}),
  };
}
