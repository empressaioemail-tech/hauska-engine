import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFPage, type PDFImage } from "pdf-lib";

import type { ParcelReportModel } from "../report-model.js";
import type { SitePlanModel } from "../site-model.js";
import { FEASIBILITY_MANIFEST, manifestIncludes, type ReportManifest } from "../report-manifest.js";
import {
  AERIAL_IMAGERY_ATTRIBUTION,
  AERIAL_NOT_A_SURVEY_LINE,
  AERIAL_UNAVAILABLE_NOTE,
  aerialImagePixelSize,
  buildAerialExportUrl,
  computeAerialMercatorBbox,
  fetchAerialImagery,
  makeAerialOverlayTransform,
  type AerialImageryResult,
  type MercatorBbox,
  type PageRect,
} from "./aerial.js";
import {
  emitPdfFloodDrainage,
  type PdfFloodDrainageResult,
} from "./flood-drainage.js";
import { REASON, countyDisplayName } from "./format.js";
import { RhythmCapture, placeRowBelowRule, type RhythmRow } from "./line-box.js";
import { SITE_PLAN_HONESTY_LINE } from "./provenance.js";
import {
  DOSSIER_COMPILATION_LINE,
  DOSSIER_NOT_LEGAL_ADVICE,
  DOSSIER_VERDICT_ABSENT_REASON,
  DOSSIER_VERDICT_QUALIFIER,
  contentFloorY,
  drawBriefFactRow,
  drawDossierHeader,
  planBriefPages,
  planTextPages,
  sanitizeDossierContent,
  wrapUserText,
  type DossierBriefSectionInput,
  type PlannedPage,
} from "./dossier.js";
import {
  LB,
  MARGIN_BOTTOM,
  MARGIN_X,
  MarkRegistry,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  countSitePlanSheets,
  drawFinePrint,
  drawSectionHeading,
  emitPdfSitePlan,
  headerRuleY,
  loadFont,
  wrapTextToWidth,
  type Fonts,
  type EmitPdfSitePlanOptions,
  type PdfSitePlanResult,
  type SheetMark,
} from "./render.js";
import { SPACE, STROKE, TOKENS, TYPE, pt } from "./template-tokens.js";

/**
 * FEASIBILITY STUDY assembler (P-32 wave 1, 2026-09-04; re-cut onto
 * `ParcelReportModel` 2026-09-07, R5).
 *
 * Sibling document to `dossier.ts` (X-ray): same SHEET_STANDARD_v1 tokens,
 * same fonts, same honest-absence chip vocabulary — reuses `dossier.ts`'s own
 * grouped-fact-page pagination/drawing (`planBriefPages`, `drawBriefFactRow`,
 * `drawDossierHeader`, `sanitizeDossierContent`) rather than re-deriving it,
 * per the architecture note those exports carry.
 *
 * R5: this now renders from `ParcelReportModel` (the one composition every
 * report product reads, `report-model.ts`) rather than a feasibility-only
 * `FeasibilityModel`. The verdict headline, deterministic narrative skeleton,
 * open items and data-quality note are no longer computed here — they are
 * `model.package.*`, computed once across every section by the composer, per
 * R5's own requirement ("computed across all sections rather than one
 * product's slice"). This file only renders. `manifest` gates whether the
 * package layer draws at all (`manifestIncludes(manifest, "package")`) —
 * FEASIBILITY_MANIFEST is the only manifest with a real renderer behind it
 * this round (R6/R7 wire X-Ray/Site Plan/Flood), but the gate is a genuine
 * conditional, not a decorative parameter.
 *
 * A caller-supplied `narrativeOverride` (e.g. a separately-generated LLM
 * narrative) renders instead of `model.package.narrativeSkeleton` when
 * present — this assembler never calls an LLM itself.
 */

const FEASIBILITY_KICKER = "SMART SITE FEASIBILITY STUDY";
const FEASIBILITY_VERDICT_HEADING = "WHAT CAN BE BUILT";

/** The formal binding-constraint derivation — which single rule governs, and
 * by how much — is R-04's remaining scope and is not on `ParcelReportModel`.
 * Declared here rather than left blank: a cover that silently omits the
 * governing rule reads as though nothing binds the envelope. */
export const BINDING_CONSTRAINT_NOT_YET_DERIVED =
  "Which single rule governs this envelope is not yet derived; the zoning district and setbacks above are the inputs that shaped it.";
const FEASIBILITY_NARRATIVE_HEADING = "NARRATIVE";
const FEASIBILITY_OPEN_ITEMS_HEADING = "Open items";
export const FEASIBILITY_NOT_LEGAL_ADVICE = DOSSIER_NOT_LEGAL_ADVICE;
export const FEASIBILITY_NARRATIVE_DISCLOSURE =
  "Narrative is a deterministic summary of the sections above unless a generated narrative was supplied; either way it is not verified against outside sources.";
export const FEASIBILITY_GIS_REFERENCE_NOTE =
  "County GIS reference sheets are not included: every fact above carries its own source citation natively.";
/** item 14: distinct from dossier.ts's own `DOSSIER_FACT_VALUE_ABSENT_REASON`
 * ("No value carried in the brief for this fact.") — that phrase describes a
 * CALLER choosing not to send an optional field, which is not what an absent
 * fact here means. Every Feasibility absence is the engine looking for a
 * real atom and finding none; this assembler's own generic line says so. */
export const FEASIBILITY_FACT_VALUE_ABSENT_REASON = "No matching record was found for this fact.";

/**
 * Customer-facing labels for `OpenItem.section`.
 *
 * `composePackageLayer` keys open items by MODEL field name (`specialDistricts`,
 * `wellsPipelines`, `hoa`, `parcelOwnership`, …) because that is what the
 * composer iterates. Those are internal identifiers and printing them in the
 * open-items table put raw camelCase keys in front of a buyer.
 *
 * The map lives HERE rather than on the model because it is presentation: the
 * composer's key is the correct join value, and `report-model.ts` is another
 * lane's file. An unmapped key falls back to the raw key rather than to a
 * placeholder — a wrong-looking label is visible and gets fixed, whereas a
 * silent "Other" would hide a section nobody labeled.
 */
const OPEN_ITEM_SECTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  geometry: "Site geometry",
  jurisdiction: "City limits and ETJ",
  parcelOwnership: "Parcel and ownership",
  flood: "Flood",
  specialDistricts: "Special districts",
  wellsPipelines: "Wells and pipelines",
  utilities: "Utilities",
  footprint: "Existing structures",
  drainage: "Drainage study",
  hoa: "HOA and recorded restrictions",
});

export function openItemSectionLabel(section: string): string {
  return OPEN_ITEM_SECTION_LABELS[section] ?? section;
}

/** Row label for a fact's rendered `consequence`. Phrased as the reader's
 * question, not as a data-model field name. */
export const CONSEQUENCE_ROW_LABEL = "What this means";

// ─────────────────────────────────────────────────────────────────────────
// ParcelReportModel → the grouped-fact section shape `planBriefPages` and
// `drawBriefFactRow` already know how to paginate and draw.
// ─────────────────────────────────────────────────────────────────────────

function factOrChip(
  label: string,
  value: string | number | undefined | null,
  opts: { source?: string; vintage?: string; absentReason?: string } = {},
) {
  if (value === undefined || value === null || value === "") {
    return { label, value: undefined, source: opts.absentReason, vintage: undefined };
  }
  return { label, value: String(value), source: opts.source, vintage: opts.vintage };
}

export function feasibilityModelToBriefSections(model: ParcelReportModel): DossierBriefSectionInput[] {
  const sections: DossierBriefSectionInput[] = [];
  const facts = model.facts;

  sections.push({
    id: "jurisdiction",
    title: "Location and jurisdiction",
    facts: [
      factOrChip("County", countyDisplayName(facts.jurisdiction.countyName) ?? countyDisplayName(facts.jurisdiction.countyFips), {
        absentReason: REASON.noCountyName,
      }),
      // ONE row, and a real absence. This was two rows both printing the
      // pseudo-value "Unresolved" — a non-empty string, so `factOrChip`
      // rendered it as a FINDING and silently dropped the reason. Two
      // identical negatives stacked, neither saying why. City limits and ETJ
      // come from the same missing adapter and fail together, so they are one
      // fact with one reason and one consequence.
      factOrChip("City limits and ETJ", undefined, {
        absentReason:
          "No city-limits or ETJ boundary source is wired for this county yet, so annexation status is unverified.",
      }),
      factOrChip(
        CONSEQUENCE_ROW_LABEL,
        "Which authority reviews a permit here is not established. Confirm with the county and with any city whose ETJ may reach this parcel before assuming a review path.",
      ),
    ],
  });

  const po = facts.parcelOwnership;
  sections.push({
    id: "parcel-ownership",
    title: "Parcel and ownership",
    facts:
      po.status === "present"
        ? [
            factOrChip("Legal description", po.legalDescription, { source: po.sourceCitation, vintage: po.asOfIso }),
            factOrChip("Land use", po.landUseLabel ?? po.landUseCode, { source: po.sourceCitation, vintage: po.asOfIso }),
            factOrChip("Owner", po.ownerName, {
              source: po.sourceCitation,
              vintage: po.absenteeOwner ? "mailing differs from situs" : po.asOfIso,
            }),
            factOrChip("Market value", po.marketValue != null ? `$${po.marketValue.toLocaleString()}` : undefined, { source: po.sourceCitation, vintage: po.asOfIso }),
            factOrChip("Assessed value", po.assessedValue != null ? `$${po.assessedValue.toLocaleString()}` : undefined, { source: po.sourceCitation, vintage: po.asOfIso }),
            factOrChip("Year built", po.yearBuilt, { source: po.sourceCitation, vintage: po.asOfIso }),
            factOrChip("Living area", po.livingAreaSqft != null ? `${po.livingAreaSqft.toLocaleString()} sq ft` : undefined, { source: po.sourceCitation, vintage: po.asOfIso }),
          ]
        : [factOrChip("Parcel and ownership", undefined, { absentReason: po.reason })],
  });

  sections.push(
    model.geometry.status === "present"
      ? {
          id: "zoning-envelope",
          title: "Zoning, setbacks, buildable envelope",
          facts: (() => {
            const sp = model.geometry.model.summary;
            return [
              factOrChip("Zoning district", sp.zoningDistrict, { absentReason: sp.zoningHonestAbsenceReason }),
              factOrChip("Lot area", `${sp.lotAreaSqFt.toLocaleString()} sq ft`),
              factOrChip("Buildable area", sp.buildablePdfLabel, { vintage: sp.buildableAreaHonestNote }),
              factOrChip(
                // Matches the existing row-label convention in dossier.ts/render.ts
                // (item 14): the label carries the axis order so the bare number
                // triplet never needs the site-plan drawing to decode it.
                "Setbacks F / S / R",
                model.geometry.model.setback.honestAbsence ? undefined : model.geometry.model.setback.displayLine,
                { absentReason: model.geometry.model.setback.honestAbsenceReason },
              ),
            ];
          })(),
        }
      : {
          id: "zoning-envelope",
          title: "Zoning, setbacks, buildable envelope",
          // R2: a geometry composition failure degrades this section to a
          // declared absence — it no longer takes the whole document down.
          facts: [factOrChip("Zoning, setbacks, buildable envelope", undefined, { absentReason: model.geometry.reason })],
        },
  );

  const flood = facts.flood;
  const drainage = model.drainage;
  const dp = facts.dischargePoint;
  sections.push({
    id: "flood",
    title: "Flood and drainage",
    facts: [
      ...(flood.status === "present"
        ? [
            factOrChip("Flood zone", flood.floodZone ?? (flood.inSpecialFloodHazardArea ? "In SFHA" : "Zone X (outside mapped hazard)")),
            // A parcel outside the special flood hazard area HAS no base
            // flood elevation — FEMA does not publish one there. Rendering
            // that as an UNAVAILABLE chip turned a correct null into an
            // apparent gap, and put a fifth "we don't know" on a sheet where
            // the honest answer was "none applies".
            flood.baseFloodElevation != null
              ? factOrChip("Base flood elevation", `${flood.baseFloodElevation} ft`)
              : flood.inSpecialFloodHazardArea === false
                ? factOrChip("Base flood elevation", "None applies", {
                    source: "FEMA publishes no base flood elevation outside a special flood hazard area",
                  })
                : factOrChip("Base flood elevation", undefined),
          ]
        : [factOrChip("Flood and drainage", undefined, { absentReason: flood.reason })]),
      // R3: this used to be a caller-supplied boolean nothing checked. It is
      // now the REAL parcel-scoped drainage study, present or absent with a
      // reason — never a fabricated "on file".
      factOrChip("Site-specific drainage study", drainage.status === "present" ? "On file" : undefined, {
        source: drainage.status === "present" ? `${drainage.study.rainfallSource} rainfall, ${drainage.study.demProvenance.resolutionMeters} m DEM` : undefined,
        vintage: drainage.status === "present" ? drainage.study.generatedAt.slice(0, 10) : undefined,
        absentReason: drainage.status === "absent" ? drainage.reason : undefined,
      }),
      ...(drainage.status === "present"
        ? [
            factOrChip("Modeled catchment", `${Math.round(drainage.study.stats.catchmentAreaSqFt).toLocaleString()} sq ft`),
            factOrChip(
              "Modeled ponding on parcel",
              drainage.study.stats.pondedAreaSqFt != null ? `${Math.round(drainage.study.stats.pondedAreaSqFt).toLocaleString()} sq ft` : undefined,
              { absentReason: drainage.study.stats.pondedAreaSqFt == null ? "Rainfall ponding was not computed on this run." : undefined },
            ),
            factOrChip("Modeled flow exits", String(drainage.study.stats.flowExitCount)),
            factOrChip("Design storm", `${drainage.study.rainfallDepthInches} in (${drainage.study.rainfallSource})`),
          ]
        : []),
      // item 19 — independent of flood-hazard-fact presence: this comes
      // from the D8 flow model + county hydrography, not the atom above.
      factOrChip(
        "Named downstream discharge point",
        dp.status === "present" ? dp.point.name : undefined,
        {
          source: dp.status === "present" ? dp.point.sourceUrl : undefined,
          vintage:
            dp.status === "present"
              ? `${Math.round(dp.point.distanceMeters)} m from modeled exit`
              : undefined,
          absentReason: dp.status === "absent" ? dp.reason : undefined,
        },
      ),
    ],
  });

  const sd = facts.specialDistricts;
  sections.push({
    id: "special-districts",
    title: "Special districts",
    facts:
      sd.status === "present"
        ? sd.districts.map((d) => factOrChip(d.districtType ?? "District", d.districtName))
        : [factOrChip("Special districts", undefined, { absentReason: sd.reason })],
  });

  const wp = facts.wellsPipelines;
  sections.push({
    id: "wells-pipelines",
    title: "Wells and pipelines",
    facts:
      wp.status === "present"
        ? [
            ...wp.wells.map((w, i) => factOrChip(`Well ${i + 1}`, [w.wellType, w.wellStatus].filter(Boolean).join(" · ") || "on file")),
            ...(wp.nearPipeline
              ? [factOrChip("Nearby pipeline", wp.pipelineOperatorName ?? "unnamed operator", {
                  vintage: wp.nearestPipelineDistanceMeters != null ? `${Math.round(wp.nearestPipelineDistanceMeters)} m` : undefined,
                })]
              : []),
          ]
        : [factOrChip("Wells and pipelines", undefined, { absentReason: wp.reason })],
  });

  // P-120 R-05: the five families R-04 composes. Until this landed the model
  // paid three live outbound reads and the sheet showed none of them, which is
  // the whole reason the 2026-09-08 canary was 13x slower for no visible gain.
  sections.push({
    id: "floodplain-acreage",
    title: "Floodplain acreage in tract",
    facts:
      facts.floodplainAcreage.status === "present"
        ? [
            factOrChip(
              "Parcel area",
              `${facts.floodplainAcreage.parcelAcres.toFixed(2)} acres`,
            ),
            factOrChip(
              "Inside the special flood hazard area",
              `${facts.floodplainAcreage.sfhaAcres.toFixed(2)} acres`,
            ),
            factOrChip(
              "Mapped flood zones intersecting",
              String(facts.floodplainAcreage.zones.length),
            ),
          ]
        : [
            factOrChip("Floodplain acreage in tract", undefined, {
              absentReason: facts.floodplainAcreage.reason,
            }),
          ],
  });

  sections.push({
    id: "firm-panel",
    title: "FIRM panel",
    facts:
      facts.firmPanel.status === "present"
        ? facts.firmPanel.panels.map((panel) =>
            factOrChip("Panel", panel.firmPan, {
              source: panel.dfirmId ?? undefined,
              vintage: panel.effectiveDate ?? undefined,
            }),
          )
        : [factOrChip("FIRM panel", undefined, { absentReason: facts.firmPanel.reason })],
  });

  sections.push({
    id: "soil",
    title: "Soil",
    facts:
      facts.soil.status === "present"
        ? [
            factOrChip("Map unit", facts.soil.muname),
            factOrChip("Hydrologic soil group", facts.soil.hydrologicSoilGroup),
            factOrChip("Drainage class", facts.soil.drainageClass),
            factOrChip(
              "Slope",
              facts.soil.slopePercentRounded == null
                ? undefined
                : `${facts.soil.slopePercentRounded}%`,
            ),
          ]
        : [factOrChip("Soil", undefined, { absentReason: facts.soil.reason })],
  });

  sections.push({
    id: "service-providers",
    title: "Electric and gas service",
    facts: [
      ...(facts.electricProvider.status === "present"
        ? facts.electricProvider.ambiguous
          ? [
              // A disclosed ambiguity, never silently resolved to one name.
              factOrChip(
                "Electric territory",
                `${facts.electricProvider.candidates.length} overlapping territories — not resolved`,
                { source: facts.electricProvider.sourceCitation },
              ),
            ]
          : facts.electricProvider.candidates.map((c) =>
              factOrChip("Electric provider", c.name ?? undefined, {
                source: facts.electricProvider.status === "present"
                  ? facts.electricProvider.sourceCitation
                  : undefined,
              }),
            )
        : [
            factOrChip("Electric provider", undefined, {
              absentReason: facts.electricProvider.reason,
            }),
          ]),
      ...(facts.gasProvider.status === "absent"
        ? [factOrChip("Gas provider", undefined, { absentReason: facts.gasProvider.reason })]
        : []),
    ],
  });

  sections.push({
    id: "terrain",
    title: "Terrain and site conditions",
    // R2: terrain is derived entirely from geometry, so its absence is a
    // declared consequence of a geometry failure, never a crash.
    facts:
      facts.terrain.status === "present"
        ? [
            factOrChip(
              "Elevation range",
              `${facts.terrain.elevationRangeMeters.min.toFixed(1)}–${facts.terrain.elevationRangeMeters.max.toFixed(1)} m`,
            ),
          ]
        : [factOrChip("Terrain and site conditions", undefined, { absentReason: facts.terrain.reason })],
  });

  const util = facts.utilities;
  sections.push({
    id: "utilities",
    title: "Utilities who-serves",
    facts:
      util.status === "present"
        ? [
            ...util.holders.map((h) => factOrChip(h.serviceKind, h.territoryName ?? "territory holder on file")),
            factOrChip("Residual", util.residual),
          ]
        : [factOrChip("Utilities who-serves", undefined, { absentReason: util.reason })],
  });

  sections.push({
    id: "hoa",
    title: "HOA and recorded restrictions",
    facts: [
      factOrChip(
        "Recorded restrictions",
        facts.hoa.mountedDocumentCitation ? "Cited from a mounted document" : undefined,
        {
          source: facts.hoa.mountedDocumentCitation,
          absentReason: facts.hoa.mountedDocumentCitation
            ? undefined
            : "Not searched. Mount a recorded document (e.g. a CC&R) in Smart Files to cite it here.",
        },
      ),
    ],
  });

  const fp = facts.footprint;
  const contradiction = footprintContradictsAppraisal(model) ? improvementEvidence(model) : null;
  sections.push({
    id: "footprint",
    title: "Existing structures",
    facts:
      fp.status === "present"
        ? fp.footprints.map((f, i) => factOrChip(`Structure ${i + 1}`, f.structureRole ?? f.footprintId, { source: f.sourceTier }))
        : contradiction
          ? [
              // NOT an absence chip. A gray UNAVAILABLE here reads as
              // "checked and clear", which is the opposite of what the two
              // sources together support.
              factOrChip("Existing structures", "Sources disagree — appraisal records say improved", {
                source: fp.reason,
              }),
              factOrChip("Appraisal record", contradiction.summary, {
                source: "county appraisal roll (cad_property)",
              }),
            ]
          : [factOrChip("Existing structures", undefined, { absentReason: fp.reason })],
  });

  if (model.package.dataQuality.supersededNotes.length > 0) {
    sections.push({
      id: "data-quality",
      title: "Data quality",
      facts: model.package.dataQuality.supersededNotes.map((note, i) => factOrChip(`Note ${i + 1}`, note)),
    });
  }

  sections.push({
    id: "open-items",
    title: FEASIBILITY_OPEN_ITEMS_HEADING,
    facts:
      model.package.openItems.length > 0
        ? model.package.openItems.map((item) =>
            factOrChip(openItemSectionLabel(item.section), item.actionSentence),
          )
        : [factOrChip("Open items", "None — every section above resolved to a fact.")],
  });

  return attachConsequences(sections, model);
}

/**
 * Append each section's `consequence` as its own closing row.
 *
 * `FeasibilityFactState` carries `consequence` on BOTH its present and absent
 * branches — "what this fact means for someone deciding whether to build
 * here" — and `report-model.ts` populates it. Nothing rendered it, so the
 * document printed the finding and stopped, which is the "atom facts on a
 * page" failure the operator named.
 *
 * Emitted as a normal fact row rather than by extending `DossierBriefFactInput`
 * with a `consequence` field, because `pdf/dossier.ts` is another lane's file;
 * a row needs no shared-type change and paginates through the existing
 * `planBriefPages` path unmodified.
 *
 * A section whose state carries no consequence gets no row — an empty
 * "What this means" would be worse than its absence.
 */
function attachConsequences(
  sections: DossierBriefSectionInput[],
  model: ParcelReportModel,
): DossierBriefSectionInput[] {
  const facts = model.facts;
  const bySectionId: Readonly<Record<string, { consequence?: string } | undefined>> = {
    "parcel-ownership": facts.parcelOwnership,
    flood: facts.flood,
    "special-districts": facts.specialDistricts,
    "wells-pipelines": facts.wellsPipelines,
    "floodplain-acreage": facts.floodplainAcreage,
    "firm-panel": facts.firmPanel,
    soil: facts.soil,
    "service-providers": facts.electricProvider,
    terrain: facts.terrain,
    utilities: facts.utilities,
    footprint: facts.footprint,
  };
  return sections.map((section) => {
    // The footprint consequence is REFUSED when a second source contradicts
    // it. `report-model.ts` writes "The site reads as unimproved, so
    // redevelopment is unlikely to require demolition" whenever the
    // building-footprint layer returns nothing — a confident negative
    // inference from one layer's miss. On a parcel whose appraisal record
    // carries a year built and a living area, that sentence is false, and it
    // points a reader toward demolishing a building the same document
    // describes three sheets earlier.
    //
    // Refused here rather than corrected upstream because the composer cannot
    // be edited from this lane; the override is stated, not silent.
    if (section.id === "footprint" && footprintContradictsAppraisal(model)) {
      return {
        ...section,
        facts: [
          ...section.facts,
          factOrChip(
            CONSEQUENCE_ROW_LABEL,
            `Sources disagree. The building-footprint layer maps no structure, while county appraisal records carry ${improvementEvidence(model)!.summary}. Do not treat this parcel as vacant: confirm what is standing with a site visit or survey before any demolition, valuation or yield assumption.`,
          ),
        ],
      };
    }
    const consequence = bySectionId[section.id]?.consequence;
    if (!consequence) return section;
    return {
      ...section,
      facts: [...section.facts, factOrChip(CONSEQUENCE_ROW_LABEL, consequence)],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// The assembler.
// ─────────────────────────────────────────────────────────────────────────

export interface EmitPdfFeasibilityOptions {
  sitePlan?: { model: SitePlanModel; aerial?: EmitPdfSitePlanOptions["aerial"] };
  sitePlanUnavailableReason?: string;
  liveViewUrl?: string;
  /** Header fallback when `model.geometry` is absent (R2) — the site-plan
   * geometry composition is unavailable, so there is no `model.geometry.
   * model.summary.address/countyName` to print. Caller-supplied, never
   * fabricated, same convention `dossier-author.ts` already uses for its own
   * geometry-absent case. Ignored when geometry is present. */
  descriptorOverride?: { address?: string; countyName?: string };
  /** Caller-supplied, already-generated narrative (e.g. LLM output from a
   * separate route) — rendered verbatim, labeled, never fabricated or
   * verified here. Absent = `model.package.narrativeSkeleton` renders
   * instead, which is a complete, valid document on its own (item 7's own
   * check). */
  narrativeOverride?: { text: string; generatedBy: string; generatedAt: string };
  generatedAtIso?: string;
}

export interface PdfFeasibilityResult {
  bytes: Uint8Array;
  pageCount: number;
  feasibilityPageCount: number;
  sitePlanAppended: boolean;
  sitePlanUnavailableReason?: string;
  sectionCount: number;
  openItemCount: number;
  narrativeGrounded: boolean;
  narrativeIsDeterministicSkeleton: boolean;
  /** Backfill worklist: every fact family that resolved to nothing, with
   * which kind of nothing. See `absentFactFamilies`. */
  absentFields: ReadonlyArray<AbsentFactFamily>;
  /** Address-first file name (no extension) for whoever serves these bytes.
   * Returned rather than imposed: engine-api's download route uses it, and
   * PE's BFF sets its own Content-Disposition, so the customer-visible name
   * only changes once hauska-map adopts this too. */
  suggestedFileBaseName: string;
  marks: ReadonlyArray<SheetMark>;
  rhythm: ReadonlyArray<RhythmRow>;
  sitePlan?: Omit<PdfSitePlanResult, "bytes">;
}

// ─────────────────────────────────────────────────────────────────────────
// Page 1 answers four questions and nothing else: what can be built, what
// binds it, what is genuinely unknown, what to do first. The helpers below
// derive those four answers from the model. None of them fabricates: where
// the model does not carry a value the helper returns undefined and the
// cover renders a declared absence naming what is missing.
// ─────────────────────────────────────────────────────────────────────────

const METRES_TO_FEET = 3.280839895;

/** Envelope extent in feet from the OFFSET ring's bounding box.
 *
 * A "roughly W by H" pad is only honest if it comes from real geometry.
 * Deriving one from area alone (picking any rectangle whose product matches)
 * would be an invented shape presented as a measurement, so this returns
 * undefined when there is no offset ring to measure. */
export function envelopeExtentFeet(
  offsetRingLocal: ReadonlyArray<{ x: number; y: number }> | null | undefined,
): { widthFt: number; depthFt: number } | undefined {
  if (!offsetRingLocal || offsetRingLocal.length < 3) return undefined;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of offsetRingLocal) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const widthFt = Math.round((maxX - minX) * METRES_TO_FEET);
  const depthFt = Math.round((maxY - minY) * METRES_TO_FEET);
  if (widthFt <= 0 || depthFt <= 0) return undefined;
  return { widthFt, depthFt };
}

/**
 * "What can be built", as a measurement a reader can picture.
 *
 * The same square footage stated three ways: the number, its share of the
 * lot, and the envelope's real extent on the ground. `buildablePdfLabel` is
 * the shared B3 vocabulary and stays verbatim so this document cannot
 * disagree with the map card about the same parcel.
 */
export function buildableAnswer(sp: SitePlanModel["summary"], setback: SitePlanModel["setback"]): {
  headline: string;
  picture?: string;
} {
  const sqFt = sp.buildableAreaSqFt;
  if (sqFt == null) {
    return {
      headline: `Buildable area could not be determined${
        sp.buildableAreaHonestNote ? `: ${sp.buildableAreaHonestNote}` : "."
      }`,
    };
  }
  const parts: string[] = [];
  if (sp.lotAreaSqFt > 0) {
    parts.push(`${Math.round((sqFt / sp.lotAreaSqFt) * 100)}% of the ${Math.round(sp.lotAreaSqFt).toLocaleString("en-US")} sq ft lot`);
  }
  const extent = envelopeExtentFeet(setback.offsetRingLocal);
  if (extent) {
    parts.push(`an envelope roughly ${extent.widthFt.toLocaleString("en-US")} by ${extent.depthFt.toLocaleString("en-US")} ft at its widest`);
  }
  return {
    headline: `${sp.buildablePdfLabel} of buildable area`,
    picture: parts.length > 0 ? parts.join(", ") : undefined,
  };
}

/**
 * "What binds it" — the rule that produced the envelope.
 *
 * The formal binding-constraint derivation (which single rule is actually
 * governing, and by how much) is R-04's remaining scope and is not on the
 * model. Rather than invent one, this states the two inputs that DID shape
 * the envelope and says plainly that the governing rule is not yet
 * identified, which is a declared absence rather than a silent one.
 */
export function bindingAnswer(sp: SitePlanModel["summary"], setback: SitePlanModel["setback"]): string[] {
  const lines: string[] = [];
  lines.push(`Zoning: ${sp.zoningDistrict ?? sp.zoningHonestAbsenceReason ?? "not on file"}`);
  lines.push(
    setback.honestAbsence
      ? `Setbacks: ${setback.honestAbsenceReason ?? "no setback rule is on file for this parcel"}`
      : `Setbacks: ${setback.displayLine}`,
  );
  return lines;
}

/** "What is genuinely unknown" — named, never counted. A count tells a
 * reader how much is missing; the names tell them whether the missing part
 * matters to their decision. */
export function unknownsAnswer(model: ParcelReportModel): string {
  const names = model.package.openItems.map((i) => openItemSectionLabel(i.section));
  const unique = [...new Set(names)];
  if (unique.length === 0) return "Nothing outstanding — every section resolved to a fact.";
  return unique.join(" · ");
}

/** "What to do first" — the first open item's action sentence, verbatim.
 *
 * Contact, portal and login-required fields are NOT on `OpenItem` (it carries
 * `section` and `actionSentence` only), so this renders the action and does
 * not invent a phone number or a portal URL. Widening the work plan is a
 * model change and belongs with whoever owns `report-model.ts`. */
export function firstActionAnswer(model: ParcelReportModel): string | undefined {
  return model.package.openItems[0]?.actionSentence;
}

/**
 * Every fact family that resolved to nothing on this run, with WHICH KIND of
 * nothing — the backfill worklist.
 *
 * Derived from the model's fact states, never from the rendered rows. A row
 * is a presentation artifact: it can be merged, suppressed or relabelled by
 * this file, and a backfill driven off it would inherit those decisions.
 *
 * `kind` is what makes the list actionable rather than a pile of gaps:
 *   clear             the source ran and found nothing. NOT a backfill target
 *                     — there is nothing to acquire.
 *   out-of-scope      the family was not requested this run. Fix by asking
 *                     for it, not by acquiring anything.
 *   failed-this-run   the read broke. Retry.
 *   blocked-at-source no acquisition path exists. Needs a ruling, not a job.
 *   not-applicable    the question does not apply to this parcel.
 *
 * Only `failed-this-run` and `out-of-scope` are jobs. Reporting all five as
 * one undifferentiated gap count is how a backfill ends up chasing families
 * that were already answered.
 */
export interface AbsentFactFamily {
  section: string;
  label: string;
  kind: string;
  reason: string;
  /** True when this absence is a genuine acquisition or retry target. */
  actionable: boolean;
}

const ABSENT_FAMILY_LABELS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["parcelOwnership", "Parcel and ownership"],
  ["flood", "Flood"],
  ["specialDistricts", "Special districts"],
  ["wellsPipelines", "Wells and pipelines"],
  ["terrain", "Terrain"],
  ["utilities", "Utilities"],
  ["footprint", "Existing structures"],
  ["dischargePoint", "Downstream discharge point"],
  ["floodplainAcreage", "Floodplain acreage in tract"],
  ["firmPanel", "FIRM panel"],
  ["soil", "Soil"],
  ["electricProvider", "Electric provider"],
  ["gasProvider", "Gas provider"],
]);

export function absentFactFamilies(model: ParcelReportModel): AbsentFactFamily[] {
  const facts = model.facts as unknown as Record<
    string,
    { status?: string; kind?: string; reason?: string } | undefined
  >;
  const out: AbsentFactFamily[] = [];
  for (const [key, label] of ABSENT_FAMILY_LABELS) {
    const state = facts[key];
    if (!state || state.status !== "absent") continue;
    const kind = state.kind ?? "unknown";
    out.push({
      section: key,
      label,
      kind,
      reason: state.reason ?? "",
      actionable: kind === "failed-this-run" || kind === "out-of-scope",
    });
  }
  if (model.drainage.status === "absent") {
    out.push({
      section: "drainage",
      label: "Drainage study",
      // ParcelDrainageState has no `kind` — it predates the absence taxonomy,
      // so this cannot be classified without guessing, and is reported as
      // unclassified rather than defaulted into a bucket.
      kind: "unclassified",
      reason: model.drainage.reason,
      actionable: false,
    });
  }
  return out;
}

/**
 * File-safe document name, address first.
 *
 * `48021_27895_feasibility_study.pdf` names the document by an internal key.
 * A buyer with six of these in a downloads folder cannot tell them apart, and
 * the parcel node id is the one identifier they never typed. The address is
 * what they searched for.
 *
 * The parcel id is kept as a SUFFIX rather than dropped: addresses are not
 * unique and not stable, so the key still has to be in the name to keep two
 * reports from colliding.
 */
export function feasibilityDocumentBaseName(model: ParcelReportModel): string {
  const address =
    model.geometry.status === "present" ? model.geometry.model.summary.address : undefined;
  const key = model.parcelNodeId.replace(/:/g, "_");
  const slug = (address ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? `${slug}_${key}_feasibility_study` : `${key}_feasibility_study`;
}

export const FEASIBILITY_AERIAL_KICKER = "AERIAL CONTEXT";
export const FEASIBILITY_HOW_TO_READ_KICKER = "HOW TO READ THIS";

/**
 * Aerial caption, written from the footprint and envelope the model already
 * carries.
 *
 * An uncaptioned aerial is a picture; the reader has to work out what it
 * implies. Where a structure covers most of the buildable envelope the
 * redevelopment question is demolition or reuse, not infill, and that is the
 * single most decision-relevant sentence on the page.
 *
 * Every branch is derived. When the footprint family is absent the caption
 * says so and stops, rather than implying a vacant lot — "no structure on
 * file" and "no structure on the ground" are different claims.
 */
export function aerialCaption(model: ParcelReportModel): string {
  const footprint = model.facts.footprint;
  const improvement = improvementEvidence(model);

  if (footprint.status === "present") {
    const n = footprint.footprints.length;
    const structures = `${n} mapped structure${n === 1 ? "" : "s"}`;
    return improvement
      ? `${structures} on this parcel. County appraisal records carry ${improvement.summary}. Redevelopment here means demolition or reuse, not building on open ground.`
      : `${structures} on this parcel. The footprint layer carries no floor area, so how much of the envelope is already occupied is not established here.`;
  }

  // The footprint layer found nothing. That is only "unimproved" if no OTHER
  // source says otherwise — and the CAD parcel roll is a genuinely separate
  // derivation, so it can contradict this one.
  if (improvement) {
    return `The building-footprint layer maps no structure here, but county appraisal records carry ${improvement.summary}. Two independent sources disagree, and the imagery is the tiebreaker. Treat this site as improved until a survey settles it; do NOT read the footprint gap as an empty lot.`;
  }
  return `No existing-structure record is on file for this parcel (${footprint.reason}), so the imagery below has not been reconciled against a mapped footprint. Read it as context, not as confirmation that the site is clear.`;
}

/**
 * CAD-side evidence that this parcel is improved.
 *
 * `FootprintFacts` carries a LIST of mapped structures and no area at all, so
 * a footprint miss says only that one GIS layer has no polygon here. The CAD
 * parcel roll is derived from a different source entirely — an appraisal
 * record — and a year built or a living area on it is direct evidence of a
 * building.
 *
 * This is the second derivation that makes the improved/unimproved check
 * meaning shaped rather than presence shaped: no single upstream can satisfy
 * both sides, because the footprint layer and the appraisal roll are not the
 * same party.
 */
export function improvementEvidence(
  model: ParcelReportModel,
): { summary: string; yearBuilt?: number; livingAreaSqft?: number } | null {
  const po = model.facts.parcelOwnership;
  if (po.status !== "present") return null;
  const { yearBuilt, livingAreaSqft } = po;
  const hasArea = typeof livingAreaSqft === "number" && livingAreaSqft > 0;
  const hasYear = typeof yearBuilt === "number" && yearBuilt > 0;
  if (!hasArea && !hasYear) return null;
  const parts: string[] = [];
  if (hasArea) parts.push(`${Math.round(livingAreaSqft!).toLocaleString("en-US")} sq ft of living area`);
  if (hasYear) parts.push(`a structure built in ${yearBuilt}`);
  return {
    summary: parts.join(" and "),
    ...(hasYear ? { yearBuilt } : {}),
    ...(hasArea ? { livingAreaSqft } : {}),
  };
}

/** True when the footprint layer reports nothing AND the appraisal roll says
 * the parcel is improved. Named because three places must react to it. */
export function footprintContradictsAppraisal(model: ParcelReportModel): boolean {
  return model.facts.footprint.status !== "present" && improvementEvidence(model) !== null;
}

interface FeasibilityAerialContext {
  imagery: Promise<AerialImageryResult>;
  mercBbox: MercatorBbox;
  rect: PageRect;
  toPage: (point: { x: number; y: number }) => { x: number; y: number };
}

/** Starts the bounded imagery fetch and fixes the page geometry. Never
 * throws and never blocks the document: a failed fetch renders the honest
 * paper ground with the reason, exactly as the site-plan aerial sheet does. */
function prepareFeasibilityAerial(
  sitePlan: SitePlanModel,
  aerialOptions: EmitPdfSitePlanOptions["aerial"],
): FeasibilityAerialContext {
  const rect: PageRect = {
    x: MARGIN_X,
    y: MARGIN_BOTTOM + pt(96),
    width: PAGE_WIDTH - MARGIN_X * 2,
    height: headerRuleY() - (MARGIN_BOTTOM + pt(96)) - pt(56),
  };
  const mercBbox = computeAerialMercatorBbox(sitePlan.ringLocal, sitePlan.bboxWgs84, rect.width / rect.height);
  const imagery = fetchAerialImagery(buildAerialExportUrl(mercBbox, aerialImagePixelSize(mercBbox)), {
    fetchImage: aerialOptions?.fetchImage,
    timeoutMs: aerialOptions?.timeoutMs,
  });
  return {
    imagery,
    mercBbox,
    rect,
    toPage: makeAerialOverlayTransform(mercBbox, rect, sitePlan.bboxWgs84),
  };
}

/**
 * Which sheets of the real Flood & Drainage deliverable this document carries,
 * and which layers those sheets draw.
 *
 * The four flood ids are independent, not a single on/off. `flood-cover`
 * selects the summary sheet; `catchment`, `ponding` and `flow-paths` each
 * select one drawing LAYER, and the drawing sheet comes across when any of
 * them is asked for. That is what makes the violation test hold per id:
 * dropping `ponding` alone removes the modeled-water raster and changes the
 * rendered bytes, without removing the sheet.
 *
 * Returns an empty plan when no drainage study is on file — the honest
 * absence is already reported by the flood section's own row, and an empty
 * flood sheet would be worse than none.
 */
export function floodSheetPlan(
  manifest: ReportManifest,
  model: ParcelReportModel,
): { localPages: number[]; layers: { catchment: boolean; ponding: boolean; flowPaths: boolean } } {
  const empty = { localPages: [], layers: { catchment: false, ponding: false, flowPaths: false } };
  if (model.drainage.status !== "present") return empty;
  const layers = {
    catchment: manifestIncludes(manifest, "catchment"),
    ponding: manifestIncludes(manifest, "ponding"),
    flowPaths: manifestIncludes(manifest, "flow-paths"),
  };
  const wantsDrawing = layers.catchment || layers.ponding || layers.flowPaths;
  const wantsCover = manifestIncludes(manifest, "flood-cover");
  const localPages = [...(wantsDrawing ? [1] : []), ...(wantsCover ? [2] : [])];
  if (localPages.length === 0) return empty;
  return { localPages, layers };
}

interface ResolvedFeasibilityAerial extends FeasibilityAerialContext {
  png?: PDFImage;
  unavailableReason?: string;
}

async function resolveFeasibilityAerial(
  doc: PDFDocument,
  ctx: FeasibilityAerialContext,
): Promise<ResolvedFeasibilityAerial> {
  const imagery = await ctx.imagery;
  if (!imagery.ok) return { ...ctx, unavailableReason: imagery.reason };
  try {
    return { ...ctx, png: await doc.embedPng(imagery.bytes) };
  } catch (error) {
    return { ...ctx, unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}

/** Page 2: the aerial, the parcel ring over it, and a caption that says what
 * the picture means for a build decision. */
function drawFeasibilityAerialPage(
  page: PDFPage,
  pageNo: number,
  model: ParcelReportModel,
  aerial: ResolvedFeasibilityAerial | null,
  F: Fonts,
  marks: MarkRegistry,
  rhythm: RhythmCapture,
  ruleY: number,
): void {
  const cursor = drawSectionHeading(page, pageNo, "THE SITE TODAY", ruleY, F, rhythm);
  const rect = aerial?.rect ?? {
    x: MARGIN_X,
    y: MARGIN_BOTTOM + pt(96),
    width: PAGE_WIDTH - MARGIN_X * 2,
    height: cursor - (MARGIN_BOTTOM + pt(96)) - pt(12),
  };

  if (aerial?.png) {
    page.drawImage(aerial.png, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    marks.once(pageNo, "imagery", "raster");
  } else {
    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      color: TOKENS.neutral100,
      borderColor: TOKENS.neutral300,
      borderWidth: 0.7,
    });
    const why = aerial?.unavailableReason
      ? `${AERIAL_UNAVAILABLE_NOTE}: ${aerial.unavailableReason}`
      : AERIAL_UNAVAILABLE_NOTE;
    page.drawText(why.slice(0, 140), {
      x: rect.x + pt(10),
      y: rect.y + rect.height / 2,
      size: TYPE.rowValue,
      font: F.body,
      color: TOKENS.neutral600,
    });
  }

  // The parcel ring over the imagery, so the reader can see which land is
  // theirs. Drawn from the same `ringLocal` the site-plan drawing uses.
  if (aerial && model.geometry.status === "present") {
    const ring = model.geometry.model.ringLocal;
    if (ring.length >= 3) {
      const pts = ring.map((p) => aerial.toPage(p));
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        page.drawLine({ start: a, end: b, thickness: 1.8, color: TOKENS.accent700 });
      }
      marks.once(pageNo, "parcel-ring", "outline");
    }
  }

  const caption = aerialCaption(model);
  const captionLines = wrapTextToWidth(caption, F.body, TYPE.rowValue, PAGE_WIDTH - MARGIN_X * 2);
  const placed = placeRowBelowRule(rect.y - pt(10), LB.kvRow, {
    padTop: pt(SPACE.s1),
    padBottom: pt(SPACE.s1),
    lines: Math.max(1, captionLines.length),
  });
  captionLines.forEach((line, li) => {
    page.drawText(line, { x: MARGIN_X, y: placed.baselines[li]!, size: TYPE.rowValue, font: F.body, color: TOKENS.text });
  });
  rhythm.row(pageNo, "aerial-caption", placed, LB.kvRow, pt(SPACE.s1));
  marks.once(pageNo, "aerial-caption", "text");
}

/**
 * The standing explanation, said once.
 *
 * These five sentences used to repeat on every sheet. Text that appears on
 * all seven pages is text a reader learns to skip, which cost the one
 * parcel-specific fine-print line its audience too. Said once, on a sheet
 * whose whole job is to be read once, it can carry more than it did.
 */
export const HOW_TO_READ_ROWS: ReadonlyArray<{ label: string; body: string }> = Object.freeze([
  {
    label: "What this is",
    body: "A compilation of public records and modeled results for one parcel, assembled automatically. It is not a survey, not an engineering study, and not legal advice.",
  },
  {
    label: "Where a fact is missing",
    body: "An UNAVAILABLE chip means this report looked and did not find a record. It never means the answer is no. The reason next to the chip says which of those two applies.",
  },
  {
    label: "Checked and clear",
    body: "Where a source ran and found nothing, the report says so in those words. That is a finding, not a gap, and it is stated differently from a record that was never located.",
  },
  {
    label: "What this means",
    body: "Each section closes with the consequence of its finding for a build decision. Where a section has no consequence line, the finding did not change what a builder would do.",
  },
  {
    label: "Sources and dates",
    body: "Every value carries its source and the date that source was current. A value with no date is a value whose vintage the source did not publish.",
  },
  {
    label: "Before you rely on it",
    body: "Resolve the open items on sheet 1 first. They are ordered so the item most likely to change the answer comes first.",
  },
]);

function drawHowToReadPage(
  page: PDFPage,
  pageNo: number,
  F: Fonts,
  marks: MarkRegistry,
  rhythm: RhythmCapture,
  ruleY: number,
): void {
  let cursor = drawSectionHeading(page, pageNo, "HOW TO READ THIS REPORT", ruleY, F, rhythm);
  const valueColWidth = PAGE_WIDTH - MARGIN_X - (MARGIN_X + pt(200));
  for (const row of HOW_TO_READ_ROWS) {
    cursor = drawBriefFactRow(
      page,
      pageNo,
      {
        label: row.label,
        valueLines: wrapTextToWidth(row.body, F.body, TYPE.rowValue, valueColWidth),
        greyLines: [],
        chip: false,
      },
      cursor,
      F,
      rhythm,
    );
  }
  page.drawLine({
    start: { x: MARGIN_X, y: cursor },
    end: { x: PAGE_WIDTH - MARGIN_X, y: cursor },
    thickness: STROKE.rowRule,
    color: TOKENS.neutral200,
  });
  const closing = [DOSSIER_COMPILATION_LINE, SITE_PLAN_HONESTY_LINE, FEASIBILITY_NOT_LEGAL_ADVICE, FEASIBILITY_GIS_REFERENCE_NOTE].join(" ");
  const closingLines = wrapTextToWidth(closing, F.body, TYPE.rowQualifier, PAGE_WIDTH - MARGIN_X * 2);
  const placed = placeRowBelowRule(cursor, LB.subline, {
    padTop: pt(SPACE.s2),
    padBottom: pt(SPACE.s1),
    lines: Math.max(1, closingLines.length),
  });
  closingLines.forEach((line, li) => {
    page.drawText(line, { x: MARGIN_X, y: placed.baselines[li]!, size: TYPE.rowQualifier, font: F.body, color: TOKENS.neutral600 });
  });
  rhythm.row(pageNo, "how-to-read-closing", placed, LB.subline, pt(SPACE.s2), { ruleDrawn: false });
  marks.once(pageNo, "how-to-read", "sheet");
}

export async function emitPdfFeasibility(
  model: ParcelReportModel,
  options: EmitPdfFeasibilityOptions = {},
  manifest: ReportManifest = FEASIBILITY_MANIFEST,
): Promise<PdfFeasibilityResult> {
  const includePackage = manifestIncludes(manifest, "package");
  const briefSections = feasibilityModelToBriefSections(model);
  const verdictLine = includePackage ? model.package.verdict : undefined;
  const narrativeText = includePackage ? options.narrativeOverride?.text ?? model.package.narrativeSkeleton : undefined;
  const openItemCount = includePackage ? model.package.openItems.length : 0;

  const headerAddress = model.geometry.status === "present" ? model.geometry.model.summary.address : options.descriptorOverride?.address;
  const headerCountyName = model.geometry.status === "present" ? model.geometry.model.summary.countyName : options.descriptorOverride?.countyName;

  const content = sanitizeDossierContent({
    parcelNodeId: model.parcelNodeId,
    address: headerAddress,
    countyName: headerCountyName,
    verdictLine,
    liveViewUrl: options.liveViewUrl,
    brief: { sections: briefSections },
    notes: narrativeText,
  });

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const F: Fonts = {
    body: await doc.embedFont(loadFont("Barlow-Regular.ttf"), { subset: false }),
    bodyMedium: await doc.embedFont(loadFont("Barlow-Medium.ttf"), { subset: false }),
    display: await doc.embedFont(loadFont("BarlowCondensed-SemiBold.ttf"), { subset: false }),
    displayMedium: await doc.embedFont(loadFont("BarlowCondensed-Medium.ttf"), { subset: false }),
  };

  // ── Sheet plan ────────────────────────────────────────────────────────
  // Page order is the operator's: cover, then the aerial, then the drawing,
  // then the facts, then the flood deliverable, then how to read it.
  //
  // EVERY id is consulted. Before this, `manifestIncludes` was called once
  // (for "package") and the other nine ids were inert — cover, fact-digest
  // and drawing rendered only because they were hardcoded, so removing an id
  // from FEASIBILITY_MANIFEST changed nothing. The manifest was the control
  // and it enforced nothing.
  const includeCover = manifestIncludes(manifest, "cover");
  const includeAerial = manifestIncludes(manifest, "aerial") && model.geometry.status === "present";
  const includeDrawing = manifestIncludes(manifest, "drawing") && !!options.sitePlan;
  const includeSummary = manifestIncludes(manifest, "summary") && !!options.sitePlan;
  const includeFactDigest = manifestIncludes(manifest, "fact-digest");

  const coverAnswers = {
    buildable:
      model.geometry.status === "present"
        ? buildableAnswer(model.geometry.model.summary, model.geometry.model.setback)
        : { headline: `Buildable area could not be determined: ${model.geometry.reason}` },
    binds:
      model.geometry.status === "present"
        ? bindingAnswer(model.geometry.model.summary, model.geometry.model.setback)
        : [`Zoning: not established — ${model.geometry.reason}`],
    unknowns: unknownsAnswer(model),
    firstAction: firstActionAnswer(model),
  };

  const briefPlanned = includeFactDigest
    ? planBriefPages(content, F, FEASIBILITY_FACT_VALUE_ABSENT_REASON)
    : [];
  const narrativeLines = content.notes ? wrapUserText(content.notes, F) : [];
  const notesPlanned = narrativeLines.length > 0 ? planTextPages("notes", narrativeLines) : [];

  // The site plan is rendered with EVERY sheet ("all") rather than
  // "drawing-only". That single change is what fixes the dangling reference:
  // the drawing's fine print points at a segment table that lives on the
  // SUMMARY sheet, and "drawing-only" excluded exactly that sheet, so the
  // pointer had no target in this document. The mode is
  // "drawing-and-summary" rather than "all" because Feasibility draws its own
  // captioned aerial: asking for "all" would pay for a second Esri imagery
  // fetch on a customer-facing synchronous path and then discard the sheet.
  const sitePlanSheetTotal =
    options.sitePlan && (includeDrawing || includeSummary)
      ? await countSitePlanSheets(options.sitePlan.model)
      : 0;
  // countSitePlanSheets reports drawing + summary(1..n) + aerial.
  const sitePlanSummaryCount = Math.max(0, sitePlanSheetTotal - 2);
  const sitePlanCopyCount = (includeDrawing ? 1 : 0) + (includeSummary ? sitePlanSummaryCount : 0);

  const floodSheets = floodSheetPlan(manifest, model);

  const coverCount = includeCover ? 1 : 0;
  const aerialCount = includeAerial ? 1 : 0;
  const howToCount = 1;
  const total =
    coverCount +
    aerialCount +
    sitePlanCopyCount +
    briefPlanned.length +
    notesPlanned.length +
    floodSheets.localPages.length +
    howToCount;

  const sitePlanStartAt = coverCount + aerialCount + 1;
  const sitePlanRender: Promise<PdfSitePlanResult> | null =
    options.sitePlan && sitePlanCopyCount > 0
      ? emitPdfSitePlan(options.sitePlan.model, {
          numbering: { startAt: sitePlanStartAt, total },
          sheets: "drawing-and-summary",
          aerial: options.sitePlan.aerial,
        })
      : null;

  const floodStartAt = sitePlanStartAt + sitePlanCopyCount;
  const floodRender: Promise<PdfFloodDrainageResult> | null =
    floodSheets.localPages.length > 0 && model.drainage.status === "present"
      ? emitPdfFloodDrainage(
          model.drainage.study,
          { address: headerAddress, countyName: headerCountyName, liveViewUrl: options.liveViewUrl },
          {
            generatedAtIso: options.generatedAtIso,
            aerial: options.sitePlan?.aerial,
            numbering: { startAt: floodStartAt, total },
            layers: {
              catchment: floodSheets.layers.catchment,
              ponding: floodSheets.layers.ponding,
              flowPaths: floodSheets.layers.flowPaths,
            },
          },
        )
      : null;

  const marks = new MarkRegistry();
  const rhythm = new RhythmCapture();
  const generatedAt = options.generatedAtIso ?? new Date().toISOString();
  const stamp = `generated ${generatedAt.slice(0, 16).replace("T", " ")}Z`;
  const docId = `FS-${model.parcelNodeId.replace(/:/g, "-")}`;
  const rightMeta = [docId, model.parcelNodeId];

  const briefPages = briefPlanned.length;

  // Aerial imagery for the Feasibility-owned page 2 — started here so the
  // bounded fetch overlaps the site-plan render, the same overlap the
  // site-plan and flood sheets already use.
  const aerialContext =
    includeAerial && model.geometry.status === "present"
      ? prepareFeasibilityAerial(model.geometry.model, options.sitePlan?.aerial)
      : null;

  type FeasibilitySheet =
    | { kind: "aerial" }
    | { kind: "how-to-read" }
    | { kind: "dossier"; planned: PlannedPage };

  const sheetPlan: FeasibilitySheet[] = [
    ...(includeCover ? [{ kind: "dossier" as const, planned: { kind: "cover" } as PlannedPage }] : []),
    ...(includeAerial ? [{ kind: "aerial" as const }] : []),
  ];
  // Site-plan sheets are copied in, not drawn here, so they occupy
  // `sitePlanCopyCount` positions between the aerial and the facts.
  const afterSitePlan: FeasibilitySheet[] = [
    ...briefPlanned.map((planned) => ({ kind: "dossier" as const, planned })),
    ...notesPlanned.map((planned) => ({ kind: "dossier" as const, planned })),
    { kind: "how-to-read" as const },
  ];

  // Awaited HERE, not at prepare time: the fetch was started before the
  // site-plan render so the two bounded waits overlap rather than serialise.
  const aerialResolved = aerialContext ? await resolveFeasibilityAerial(doc, aerialContext) : null;

  const drawSheet = (sheet: FeasibilitySheet, pageNo: number): void => {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const eyebrowByKind: Record<PlannedPage["kind"], string> = {
      cover: FEASIBILITY_KICKER,
      brief: "FEASIBILITY FACTS",
      chat: FEASIBILITY_NARRATIVE_HEADING,
      notes: FEASIBILITY_NARRATIVE_HEADING,
    };
    const eyebrow =
      sheet.kind === "aerial"
        ? FEASIBILITY_AERIAL_KICKER
        : sheet.kind === "how-to-read"
          ? FEASIBILITY_HOW_TO_READ_KICKER
          : eyebrowByKind[sheet.planned.kind];
    const ruleY = drawDossierHeader(
      page,
      content,
      F,
      `${eyebrow} · SHEET ${pageNo} OF ${total}`,
      rightMeta,
    );
    marks.once(pageNo, "feasibility-header", sheet.kind === "dossier" ? sheet.planned.kind : sheet.kind);

    if (sheet.kind === "aerial") {
      drawFeasibilityAerialPage(page, pageNo, model, aerialResolved, F, marks, rhythm, ruleY);
      drawFinePrint(
        page,
        pageNo,
        [AERIAL_IMAGERY_ATTRIBUTION, AERIAL_NOT_A_SURVEY_LINE, `· Sheet ${pageNo} of ${total}`].join(" "),
        F,
        marks,
      );
      return;
    }

    if (sheet.kind === "how-to-read") {
      drawHowToReadPage(page, pageNo, F, marks, rhythm, ruleY);
      drawFinePrint(page, pageNo, `· Sheet ${pageNo} of ${total}`, F, marks);
      return;
    }

    const planned = sheet.planned;

    if (planned.kind === "cover") {
      let cursor = drawSectionHeading(page, pageNo, FEASIBILITY_VERDICT_HEADING, ruleY, F, rhythm);
      const verdictWidth = PAGE_WIDTH - MARGIN_X * 2;
      // The headline names WHAT the number measures. The model's verdict
      // string opens with a bare `buildablePdfLabel` ("8,418 sq ft under the
      // facts on file"), which is a measurement with no subject — a reader
      // has to infer that the square footage is buildable area rather than
      // lot area or floor area. Same field, same shared B3 vocabulary, so
      // this cannot disagree with the map card; only the sentence differs.
      const verdictHeadline = coverAnswers.buildable.headline;
      const verdictLines = wrapTextToWidth(verdictHeadline, F.display, TYPE.statValue, verdictWidth);
      if (verdictHeadline && verdictLines.length > 0) {
        const placed = placeRowBelowRule(cursor, LB.statValue, {
          padTop: pt(SPACE.s2),
          padBottom: pt(SPACE.s2),
          lines: verdictLines.length,
        });
        page.drawLine({ start: { x: MARGIN_X, y: cursor }, end: { x: PAGE_WIDTH - MARGIN_X, y: cursor }, thickness: STROKE.rowRule, color: TOKENS.neutral300 });
        verdictLines.forEach((line, li) => {
          page.drawText(line, { x: MARGIN_X, y: placed.baselines[li]!, size: TYPE.statValue, font: F.display, color: TOKENS.accent700 });
        });
        rhythm.row(pageNo, "verdict-line", placed, LB.statValue, pt(SPACE.s2));
        marks.once(pageNo, "verdict", "line");
        cursor = placed.nextRuleY;
        const qual = placeRowBelowRule(cursor, LB.subline, { padTop: pt(SPACE.s1), padBottom: pt(SPACE.s2) });
        // The same area a second way, so the number becomes a picture: its
        // share of the lot and the envelope's real extent on the ground.
        page.drawText(coverAnswers.buildable.picture ?? DOSSIER_VERDICT_QUALIFIER, {
          x: MARGIN_X,
          y: qual.baselines[0]!,
          size: TYPE.rowQualifier,
          font: F.body,
          color: TOKENS.neutral600,
        });
        rhythm.row(pageNo, "verdict-qualifier", qual, LB.subline, pt(SPACE.s1), { ruleDrawn: false });
        cursor = qual.nextRuleY;
      } else {
        const placed = placeRowBelowRule(cursor, LB.kvRow, { padTop: pt(SPACE.s2), padBottom: pt(SPACE.s2) });
        page.drawText("Verdict", { x: MARGIN_X, y: placed.baselines[0]!, size: TYPE.rowLabel, font: F.body, color: TOKENS.neutral600 });
        page.drawText(DOSSIER_VERDICT_ABSENT_REASON, { x: MARGIN_X + pt(120), y: placed.baselines[0]!, size: TYPE.rowValue, font: F.body, color: TOKENS.neutral700 });
        cursor = placed.nextRuleY;
      }

      // The cover answers four questions and stops. It used to carry a
      // CONTENTS block instead — a section count, a fact count, and a
      // promise of "a citation for each sentence" printed on the branch that
      // emits no citations at all. A table of contents is navigation for the
      // author; none of it helped a reader decide whether to build here, and
      // the citation line was a claim the document did not keep.
      const valueColWidth = PAGE_WIDTH - MARGIN_X - (MARGIN_X + pt(200));
      let contentsRule = cursor;

      contentsRule = drawSectionHeading(page, pageNo, "WHAT BINDS IT", contentsRule, F, rhythm);
      for (const line of coverAnswers.binds) {
        const [label, ...rest] = line.split(": ");
        contentsRule = drawBriefFactRow(
          page,
          pageNo,
          {
            label: label ?? "",
            valueLines: wrapTextToWidth(rest.join(": "), F.body, TYPE.rowValue, valueColWidth),
            greyLines: [],
            chip: false,
          },
          contentsRule,
          F,
          rhythm,
        );
      }
      contentsRule = drawBriefFactRow(
        page,
        pageNo,
        {
          label: "Governing rule",
          valueLines: [],
          greyLines: wrapTextToWidth(
            BINDING_CONSTRAINT_NOT_YET_DERIVED,
            F.body,
            TYPE.rowValue,
            valueColWidth,
          ),
          chip: true,
        },
        contentsRule,
        F,
        rhythm,
      );

      contentsRule = drawSectionHeading(page, pageNo, "WHAT IS NOT YET KNOWN", contentsRule, F, rhythm);
      contentsRule = drawBriefFactRow(
        page,
        pageNo,
        {
          label: "Unresolved",
          valueLines: wrapTextToWidth(coverAnswers.unknowns, F.body, TYPE.rowValue, valueColWidth),
          greyLines: [],
          chip: false,
        },
        contentsRule,
        F,
        rhythm,
      );

      contentsRule = drawSectionHeading(page, pageNo, "WHAT TO DO FIRST", contentsRule, F, rhythm);
      contentsRule = drawBriefFactRow(
        page,
        pageNo,
        coverAnswers.firstAction
          ? {
              label: "Next action",
              valueLines: wrapTextToWidth(coverAnswers.firstAction, F.body, TYPE.rowValue, valueColWidth),
              greyLines: [],
              chip: false,
            }
          : {
              label: "Next action",
              valueLines: ["Nothing is blocking. Proceed on the facts in this document."],
              greyLines: [],
              chip: false,
            },
        contentsRule,
        F,
        rhythm,
      );
      page.drawLine({ start: { x: MARGIN_X, y: contentsRule }, end: { x: PAGE_WIDTH - MARGIN_X, y: contentsRule }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });

      const stampLine = `${docId} · ${stamp}`;
      page.drawText(stampLine, {
        x: PAGE_WIDTH - MARGIN_X - F.body.widthOfTextAtSize(stampLine, TYPE.scaleRatioLine),
        y: contentFloorY() + pt(4),
        size: TYPE.scaleRatioLine,
        font: F.body,
        color: TOKENS.neutral600,
      });
      marks.once(pageNo, "generated-stamp", "stamp");

      if (content.liveViewUrl) {
        page.drawText(content.liveViewUrl, { x: MARGIN_X, y: contentFloorY() + pt(4), size: TYPE.scaleRatioLine, font: F.body, color: TOKENS.neutral600 });
        marks.once(pageNo, "live-view-url", "link");
      }
    }

    if (planned.kind === "brief") {
      let cursor = ruleY;
      for (const group of planned.groups) {
        let rowRule = drawSectionHeading(page, pageNo, group.heading, cursor, F, rhythm);
        for (const row of group.rows) {
          rowRule = drawBriefFactRow(page, pageNo, row, rowRule, F, rhythm);
        }
        page.drawLine({ start: { x: MARGIN_X, y: rowRule }, end: { x: PAGE_WIDTH - MARGIN_X, y: rowRule }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
        cursor = rowRule;
      }
    }

    if (planned.kind === "notes") {
      const heading = `${FEASIBILITY_NARRATIVE_HEADING}${planned.first ? "" : " · CONTINUED"}`;
      const cursor = drawSectionHeading(page, pageNo, heading, ruleY, F, rhythm);
      const textPlaced = placeRowBelowRule(cursor, LB.kvRow, { padTop: pt(SPACE.s2), padBottom: pt(SPACE.s2), lines: Math.max(1, planned.lines.length) });
      planned.lines.forEach((line, li) => {
        if (line.length === 0) return;
        page.drawText(line, { x: MARGIN_X, y: textPlaced.baselines[li]!, size: TYPE.rowValue, font: F.body, color: TOKENS.text });
      });
      rhythm.row(pageNo, "narrative-text", textPlaced, LB.kvRow, pt(SPACE.s2));
    }

    // The repeated five-sentence legal block is gone from every sheet. It
    // said the same thing on all seven pages, which is how a reader learns to
    // skip the fine print entirely — including the one line on one sheet that
    // was specific to their parcel. What stays here is per-sheet and
    // parcel-specific; the standing explanation moved to the how-to-read
    // sheet, where it is said once and can be read.
    const fineSentences: string[] = [];
    if (planned.kind === "notes") fineSentences.push(FEASIBILITY_NARRATIVE_DISCLOSURE);
    if (planned.kind === "cover" && !options.sitePlan) {
      fineSentences.push(`Site-plan sheets are not appended: ${options.sitePlanUnavailableReason ?? "site-plan authoring was unavailable for this parcel"}.`);
    }
    fineSentences.push(`· Sheet ${pageNo} of ${total}`);
    drawFinePrint(page, pageNo, fineSentences.join(" "), F, marks);
  };

  // ── Assemble, in the specified order ──────────────────────────────────
  let pageNo = 0;
  for (const sheet of sheetPlan) drawSheet(sheet, ++pageNo);

  let sitePlanResult: PdfSitePlanResult | undefined;
  if (sitePlanRender) {
    sitePlanResult = await sitePlanRender;
    const spDoc = await PDFDocument.load(sitePlanResult.bytes);
    // Copy the drawing and the summary sheets; never the site plan's own
    // aerial sheet, which this document replaces with its captioned page 2.
    const summaryLocalPages = sitePlanResult.summarySheets.map((s) => s.localPage);
    const wanted = [
      ...(includeDrawing ? [1] : []),
      ...(includeSummary ? summaryLocalPages : []),
    ].sort((a, b) => a - b);
    const indices = wanted.map((localPage) => localPage - 1).filter((i) => i >= 0 && i < spDoc.getPageCount());
    const copied = await doc.copyPages(spDoc, indices);
    for (const p of copied) {
      doc.addPage(p);
      pageNo += 1;
    }
  }

  // ── The real flood deliverable ────────────────────────────────────────
  // Not a pair of summary numbers restated in the facts table: the actual
  // Flood & Drainage sheets, catchment boundary, modeled water and traced
  // flow paths, produced by the same assembler the standalone report uses,
  // numbered into this document's own sequence.
  let floodResult: PdfFloodDrainageResult | undefined;
  if (floodRender) {
    floodResult = await floodRender;
    const fdDoc = await PDFDocument.load(floodResult.bytes);
    const indices = floodSheets.localPages
      .map((localPage) => localPage - 1)
      .filter((i) => i >= 0 && i < fdDoc.getPageCount());
    const copied = await doc.copyPages(fdDoc, indices);
    for (const p of copied) {
      doc.addPage(p);
      pageNo += 1;
    }
  }

  for (const sheet of afterSitePlan) drawSheet(sheet, ++pageNo);

  const bytes = await doc.save({ useObjectStreams: false });
  return {
    bytes,
    pageCount: total,
    feasibilityPageCount: total - sitePlanCopyCount,
    sitePlanAppended: !!options.sitePlan,
    sitePlanUnavailableReason: options.sitePlan ? undefined : options.sitePlanUnavailableReason,
    sectionCount: content.sections.length,
    openItemCount,
    narrativeGrounded: true,
    narrativeIsDeterministicSkeleton: !options.narrativeOverride,
    absentFields: absentFactFamilies(model),
    suggestedFileBaseName: feasibilityDocumentBaseName(model),
    marks: marks.marks,
    rhythm: rhythm.rows,
    sitePlan: sitePlanResult ? (({ bytes: _bytes, ...rest }) => rest)(sitePlanResult) : undefined,
  };
}

// Re-exported for tests and the author layer; avoids a second import path
// for the shared PDF page type.
export type { PDFPage };
