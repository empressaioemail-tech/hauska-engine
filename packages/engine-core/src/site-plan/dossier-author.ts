import type { ParcelTerrainModelAtomInstance } from "@hauska-engine/atoms";

import type { AuthorParcelSitePlanExportOptions } from "./author.js";
import {
  emitPdfDossier,
  type DossierBriefFactInput,
  type DossierBriefSectionInput,
  type DossierContentInput,
  type PdfDossierResult,
} from "./pdf/dossier.js";
import {
  composeParcelReport,
  footprintContradictsAppraisal,
  type ParcelReportModel,
  type ReadableTerrainArtifactStore,
} from "./report-model.js";
import { footprintVerificationLabel } from "./footprint-layer.js";

/**
 * PROPERTY DOSSIER export authoring (2026-07-29; re-cut onto
 * `composeParcelReport` 2026-09-15, P-120/P-221).
 *
 * Composes the one hand-to-client dossier PDF: Standard-styled cover
 * (verdict) + cited brief facts + AI chat summary + owner notes, with the
 * parcel's site-plan sheets appended. Geometry, verdict and brief facts all
 * come from ONE call to `composeParcelReport` — the SAME composition
 * `authorParcelFeasibilityExport` calls — rather than a second, independent
 * geometry compose plus caller-supplied verdict/brief content. This retires
 * P-221's root cause by construction: a subset renderer over an
 * internally-resolved model has no caller-supplied-content gap to be
 * hollow, and X-ray can no longer disagree with Feasibility on a shared fact
 * for the same parcel (P-120's ruling; P-227's confirming read).
 *
 * HONEST-DEGRADE CONTRACT: a missing site-plan capability (unresolvable
 * geometry, no ring, DEM failure — anything `composeParcelReport`'s own
 * geometry composition throws on) NEVER fails the dossier — it is caught
 * inside `composeParcelReport` itself (R2) and reported as
 * `model.geometry.status === "absent"`. The dossier pages still emit, the
 * cover carries the honest reason, and the artifact records
 * `sitePlanAppended: false`.
 */
export interface AuthorParcelPropertyDossierExportOptions
  extends Omit<AuthorParcelSitePlanExportOptions, "descriptor" | "artifactStore"> {
  artifactStore: ReadableTerrainArtifactStore;
  /**
   * Request-carried content this repo genuinely cannot derive from atoms:
   * the AI chat summary and owner notes are user-authored for this session,
   * and address/countyName/liveViewUrl remain caller-forwarded descriptors
   * (same contract as site-plan export). Verdict and brief facts are NO
   * LONGER accepted here (P-120/P-221) — see `composeXrayBrief` below;
   * accepting them again would silently reopen the caller-supplied-content
   * gap this re-cut exists to close.
   */
  content: Pick<DossierContentInput, "address" | "countyName" | "chatSummary" | "notes" | "liveViewUrl">;
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
  /** Site-plan honesty flags (present only when the sheets were appended;
   * read straight off the shared `model.geometry.model` — the same
   * `SitePlanModel` object the appended sheet itself renders from, never a
   * second geometry compose). */
  setbackDegenerate?: boolean;
  setbackDegenerateReason?: string;
  setbackHonestAbsence?: boolean;
  setbackHonestAbsenceReason?: string;
  streetHonestAbsence?: boolean;
  zoningHonestAbsence?: boolean;
  floodZoneHonestUnavailable?: boolean;
}

/**
 * X-RAY'S OWN ALLOW-LIST over the shared `ParcelReportModel` (P-119/P-221).
 *
 * X-ray is a Solo-tier deliverable; Feasibility (the model this function
 * reads) is Studio+-only. Deriving X-ray's content from the same composed
 * model Feasibility uses makes leaking Studio-only content into a Solo
 * document the DEFAULT failure mode unless an explicit allow-list is
 * enforced HERE, at assembly — never left to the renderer, and never left to
 * whatever access tier the request happened to carry (a paying SOLO
 * customer is "paid" on the engine's public-free/public-paid axis too, so
 * `parcelOwnershipEntitledForTier` alone would wrongly admit them).
 *
 * Excluded, unconditionally, and why:
 * - `parcelOwnership` (owner name/mailing address, market/assessed/land/
 *   improvement value, legal description): Studio/Team/Property-Unlock
 *   only, per OPS-16 A-104/A-108/A-109's `callerGrantsOwnerFact` ruling.
 * - `floodplainAcreage`, `firmPanel`, `soil`, `electricProvider`,
 *   `gasProvider`, `dischargePoint`, `drainage`, the generated narrative:
 *   P-120's own text names these as Feasibility's NEW exhibits, added
 *   specifically to deepen Feasibility past what X-ray ever carried.
 * - `terrain`, site-plan CAD (DXF/IFC), terrain export: Studio/Team/
 *   Property-Unlock only (P-119). This file already ships no DXF/IFC; the
 *   `terrain` fact family is dropped too since it is 100% geometry-derived
 *   (report-model.ts's own note) and adds nothing the appended site-plan
 *   sheet doesn't already show.
 * - `hoa`: every parcel in wave 1 carries the identical constant
 *   (`searchStatus: "not-searched"`) — never a real cited fact, so it never
 *   becomes a brief-fact row here. Including it would make a genuinely
 *   hollow parcel unrefusable (an evergreen fact would always keep
 *   `briefFactCount` above zero).
 *
 * A section contributes a fact row ONLY when its state is genuinely
 * `"present"` with real content — an absent section is silently skipped,
 * never a manufactured placeholder chip. This keeps "no brief facts could be
 * derived" a real, still-reachable condition for a parcel whose atoms are
 * genuinely unresolved: the hollow-report refusal this function's caller
 * (`services/engine-api/src/routes/parcel-terrain.ts`) enforces on download
 * must still be able to fire — it becomes unreachable in the NORMAL case,
 * never removed.
 */
export function composeXrayBrief(
  model: ParcelReportModel,
): { verdictLine: string; sections: DossierBriefSectionInput[] } {
  const sections: DossierBriefSectionInput[] = [];

  const zoningFacts: DossierBriefFactInput[] = [];
  if (model.facts.jurisdiction.countyName) {
    zoningFacts.push({ label: "County", value: model.facts.jurisdiction.countyName });
  }
  if (model.facts.jurisdiction.cityLimitsStatus !== "unresolved") {
    zoningFacts.push({
      label: "City limits",
      value: model.facts.jurisdiction.cityName
        ? `${model.facts.jurisdiction.cityLimitsStatus} (${model.facts.jurisdiction.cityName})`
        : model.facts.jurisdiction.cityLimitsStatus,
      source: model.facts.jurisdiction.cityLimitsSourceCitation,
    });
  }
  if (model.geometry.status === "present") {
    if (model.geometry.model.summary.zoningDistrict) {
      zoningFacts.push({ label: "Zoning district", value: model.geometry.model.summary.zoningDistrict });
    }
    zoningFacts.push({
      label: "Lot area",
      value: `${Math.round(model.geometry.model.summary.lotAreaSqFt).toLocaleString("en-US")} sq ft`,
    });
  }
  sections.push({ id: "zoning", title: "Location & Zoning", facts: zoningFacts });

  const flood = model.facts.flood;
  if (flood.status === "present") {
    sections.push({
      id: "flood",
      title: "Flood",
      facts: [
        {
          label: "Special flood hazard area",
          value: flood.inSpecialFloodHazardArea ? "Yes" : "No",
          source: flood.sourceCitation,
          vintage: flood.asOfIso,
        },
        ...(flood.floodZone
          ? [{ label: "Flood zone", value: flood.floodZone, source: flood.sourceCitation, vintage: flood.asOfIso }]
          : []),
      ],
    });
  }

  const footprint = model.facts.footprint;
  if (footprint.status === "present") {
    // P-248 — the count now carries what the count alone hid: the row is a
    // mapped polygon, not a measurement, and an ML-derived footprint has not
    // been surveyed. The value stays the count (the sheet is an X-ray summary)
    // and the verification word rides in the source cell beside the tier.
    const statuses = [...new Set(footprint.footprints.map((f) => f.verificationStatus))];
    const verification =
      statuses.length === 1 && statuses[0]
        ? footprintVerificationLabel(statuses[0])
        : statuses.filter((s): s is string => !!s).length > 0
          ? "verification status varies by structure"
          : undefined;
    sections.push({
      id: "structures",
      title: "Structures on file",
      facts: [
        {
          label: "Mapped footprints",
          value: verification ? `${footprint.footprints.length} · ${verification}` : String(footprint.footprints.length),
          source: footprint.sourceCitation,
          vintage: footprint.asOfIso,
        },
      ],
    });
  }

  const specialDistricts = model.facts.specialDistricts;
  if (specialDistricts.status === "present") {
    sections.push({
      id: "special-districts",
      title: "Special districts",
      facts: specialDistricts.districts
        .filter((d): d is { districtName: string; districtType?: string } => !!d.districtName)
        .map((d) => ({
          label: d.districtType ?? "District",
          value: d.districtName,
          source: specialDistricts.sourceCitation,
          vintage: specialDistricts.asOfIso,
        })),
    });
  }

  const wellsPipelines = model.facts.wellsPipelines;
  if (wellsPipelines.status === "present") {
    const facts: DossierBriefFactInput[] = [];
    if (wellsPipelines.wells.length > 0) {
      facts.push({
        label: "Wells on file",
        value: String(wellsPipelines.wells.length),
        source: wellsPipelines.sourceCitation,
      });
    }
    if (wellsPipelines.nearPipeline !== undefined) {
      facts.push({
        label: "Near pipeline",
        value: wellsPipelines.nearPipeline ? "Yes" : "No",
        source: wellsPipelines.sourceCitation,
      });
    }
    sections.push({ id: "wells-pipelines", title: "Wells & pipelines", facts });
  }

  const utilities = model.facts.utilities;
  if (utilities.status === "present" && utilities.holders.length > 0) {
    sections.push({
      id: "utilities",
      title: "Who serves",
      facts: utilities.holders.map((h) => ({
        label: h.serviceKind,
        value: h.territoryName ?? undefined,
        vintage: utilities.asOfIso,
      })),
    });
  }

  return { verdictLine: model.package.verdict, sections: sections.filter((s) => s.facts.length > 0) };
}

export async function authorParcelPropertyDossierExport(
  options: AuthorParcelPropertyDossierExportOptions,
): Promise<AuthorParcelPropertyDossierExportResult> {
  // 1) The one composition: geometry + every fact family (P-120/P-221). A
  // missing site-plan capability never fails this — it is caught inside
  // composeParcelReport (R2) and reported as model.geometry.status ===
  // "absent". Drainage is never requested here (X-ray's own "Flood &
  // Drainage" menu entry is a SEPARATE report; see flood-drainage-author.ts)
  // — matching this export's existing cheap, fast, 3-4-sheet-snapshot shape.
  const descriptor =
    options.content.address || options.content.countyName
      ? { address: options.content.address, countyName: options.content.countyName }
      : undefined;
  const { model } = await composeParcelReport({ ...options, descriptor });

  // 2) X-ray's own Solo-tier allow-list over the composed model (never the
  // caller, never the renderer — see composeXrayBrief's own doc).
  const xrayBrief = composeXrayBrief(model);

  // Site-plan sheet honesty flags, read off the SAME SitePlanModel object the
  // appended sheet renders from (model.geometry.model) rather than a second
  // geometry compose — structurally identical to what this file read off its
  // own pre-recut composeSitePlanModelForParcel() call.
  const siteHonesty =
    model.geometry.status === "present"
      ? {
          setbackDegenerate: model.geometry.model.setback.degenerate,
          setbackDegenerateReason: model.geometry.model.setback.degenerateReason,
          setbackHonestAbsence: model.geometry.model.setback.honestAbsence,
          setbackHonestAbsenceReason: model.geometry.model.setback.honestAbsenceReason,
          streetHonestAbsence: model.geometry.model.streets.honestAbsence,
          zoningHonestAbsence: model.geometry.model.summary.zoningHonestAbsenceReason !== undefined,
          floodZoneHonestUnavailable: "honestUnavailable" in model.geometry.model.summary.floodZone,
        }
      : undefined;

  // 3) Assemble the dossier (sheets appended when geometry composed).
  const pdf: PdfDossierResult = await emitPdfDossier(
    {
      parcelNodeId: options.parcelNodeId,
      address: options.content.address ?? (model.geometry.status === "present" ? model.geometry.model.summary.address : undefined),
      countyName: options.content.countyName ?? model.facts.jurisdiction.countyName,
      verdictLine: xrayBrief.verdictLine,
      brief: { sections: xrayBrief.sections },
      chatSummary: options.content.chatSummary,
      notes: options.content.notes,
      liveViewUrl: options.content.liveViewUrl,
    },
    model.geometry.status === "present"
      ? {
          sitePlan: {
            model: model.geometry.model,
            // P-248 — the X-ray appends the site plan's drawing sheet, whose
            // legend carries this; the rule stays where it already lives.
            footprintAppraisalConflict: footprintContradictsAppraisal(model),
          },
        }
      : { sitePlanUnavailableReason: model.geometry.reason },
  );

  // 4) Persist bytes + record the artifact on the parcel-terrain-model atom
  // (same recording seam as pdf-site-plan and pdf-feasibility). Coverage is
  // recorded as zero, explicitly labeled, matching the precedent
  // `authorParcelFeasibilityExport` already set when IT was recut onto this
  // same shared composition (2026-09-07) — the shared geometry compose does
  // not expose raw DEM/nodata stats to its callers, so no caller of it
  // fabricates a coverage figure here.
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
  const geometryPresent = model.geometry.status === "present";
  const atom: ParcelTerrainModelAtomInstance =
    existing ?? {
      entityType: "parcel-terrain-model",
      atomDid: `pterrain_dossier_${options.parcelNodeId.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.parse(fetchedAt)}`,
      entityId: options.parcelNodeId,
      parcelNodeId: options.parcelNodeId,
      jurisdictionTenant: "property-spine",
      fetchedAt,
      extractedAt: fetchedAt,
      sourceAdapter: geometryPresent ? "usgs:3dep-dem" : "dossier:no-terrain-resolved",
      sourceUrl: "",
      sourceCitation: geometryPresent ? "USGS 3DEP" : "no terrain data resolved for this export",
      accessPolicy: "public-paid",
      atomTier: "data",
      status: "active",
      contentHash: "",
      reasoningChain: {
        reasoningKind: "derived",
        derivationMethod: "parcel-terrain-mesh-ifc-v1",
        inputAtomRefs: [
          {
            atomDid: geometryPresent ? "composed-site-plan" : "dossier:no-terrain-resolved",
            role: "reference-field",
            citationLabel: "usgs-3dep-dem",
          },
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
        value: geometryPresent ? 0.6 : 0.3,
        kind: "asserted",
        provenance: geometryPresent
          ? "USGS 3DEP DEM field; calibration pending"
          : "dossier-only record; geometry composition failed on this run",
        n: 0,
        intervalWidth: 1,
      },
    };

  atom.artifacts["pdf-dossier"] = {
    format: "pdf-dossier",
    ref,
    byteCount: pdf.bytes.byteLength,
    pageCount: pdf.pageCount,
    dossierPageCount: pdf.dossierPageCount,
    sitePlanAppended: pdf.sitePlanAppended,
    ...(pdf.sitePlanUnavailableReason ? { sitePlanUnavailableReason: pdf.sitePlanUnavailableReason } : {}),
    verdictIncluded: pdf.verdictIncluded,
    briefSectionCount: pdf.briefSectionCount,
    briefFactCount: pdf.briefFactCount,
    chatSummaryIncluded: pdf.chatSummaryIncluded,
    notesIncluded: pdf.notesIncluded,
    ...siteHonesty,
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
    ...siteHonesty,
  };
}
