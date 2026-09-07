import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFPage } from "pdf-lib";

import type { ParcelReportModel } from "../report-model.js";
import type { SitePlanModel } from "../site-model.js";
import { FEASIBILITY_MANIFEST, manifestIncludes, type ReportManifest } from "../report-manifest.js";
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
const FEASIBILITY_VERDICT_HEADING = "VERDICT";
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
      factOrChip("City limits", "Unresolved", { absentReason: "No city-limits or ETJ data source is wired for this county yet." }),
      factOrChip("ETJ status", "Unresolved", { absentReason: "No city-limits or ETJ data source is wired for this county yet." }),
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
            factOrChip("Base flood elevation", flood.baseFloodElevation != null ? `${flood.baseFloodElevation} ft` : undefined),
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
  sections.push({
    id: "footprint",
    title: "Existing structures",
    facts:
      fp.status === "present"
        ? fp.footprints.map((f, i) => factOrChip(`Structure ${i + 1}`, f.structureRole ?? f.footprintId, { source: f.sourceTier }))
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
        ? model.package.openItems.map((item) => factOrChip(item.section, item.actionSentence))
        : [factOrChip("Open items", "None — every section above resolved to a fact.")],
  });

  return sections;
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
  marks: ReadonlyArray<SheetMark>;
  rhythm: ReadonlyArray<RhythmRow>;
  sitePlan?: Omit<PdfSitePlanResult, "bytes">;
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

  const plannedPages: PlannedPage[] = [{ kind: "cover" }];
  plannedPages.push(...planBriefPages(content, F, FEASIBILITY_FACT_VALUE_ABSENT_REASON));
  const narrativeLines = content.notes ? wrapUserText(content.notes, F) : [];
  if (narrativeLines.length > 0) {
    plannedPages.push(...planTextPages("notes", narrativeLines));
  }
  const feasibilityPageCount = plannedPages.length;
  const sitePlanSheets = options.sitePlan ? 1 : 0;
  const total = feasibilityPageCount + sitePlanSheets;

  const sitePlanRender: Promise<PdfSitePlanResult> | null = options.sitePlan
    ? emitPdfSitePlan(options.sitePlan.model, {
        numbering: { startAt: feasibilityPageCount + 1, total },
        sheets: "drawing-only",
      })
    : null;

  const marks = new MarkRegistry();
  const rhythm = new RhythmCapture();
  const generatedAt = options.generatedAtIso ?? new Date().toISOString();
  const stamp = `generated ${generatedAt.slice(0, 16).replace("T", " ")}Z`;
  const docId = `FS-${model.parcelNodeId.replace(/:/g, "-")}`;
  const rightMeta = [docId, model.parcelNodeId];

  const briefPages = plannedPages.filter((p) => p.kind === "brief").length;

  plannedPages.forEach((planned, i) => {
    const pageNo = i + 1;
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    const eyebrowByKind: Record<PlannedPage["kind"], string> = {
      cover: FEASIBILITY_KICKER,
      brief: "FEASIBILITY FACTS",
      chat: FEASIBILITY_NARRATIVE_HEADING,
      notes: FEASIBILITY_NARRATIVE_HEADING,
    };
    const ruleY = drawDossierHeader(
      page,
      content,
      F,
      `${eyebrowByKind[planned.kind]} · SHEET ${pageNo} OF ${total}`,
      rightMeta,
    );
    marks.once(pageNo, "feasibility-header", planned.kind);

    if (planned.kind === "cover") {
      let cursor = drawSectionHeading(page, pageNo, FEASIBILITY_VERDICT_HEADING, ruleY, F, rhythm);
      const verdictWidth = PAGE_WIDTH - MARGIN_X * 2;
      const verdictLines = wrapTextToWidth(content.verdictLine ?? "", F.display, TYPE.statValue, verdictWidth);
      if (content.verdictLine && verdictLines.length > 0) {
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
        page.drawText(DOSSIER_VERDICT_QUALIFIER, { x: MARGIN_X, y: qual.baselines[0]!, size: TYPE.rowQualifier, font: F.body, color: TOKENS.neutral600 });
        rhythm.row(pageNo, "verdict-qualifier", qual, LB.subline, pt(SPACE.s1), { ruleDrawn: false });
        cursor = qual.nextRuleY;
      } else {
        const placed = placeRowBelowRule(cursor, LB.kvRow, { padTop: pt(SPACE.s2), padBottom: pt(SPACE.s2) });
        page.drawText("Verdict", { x: MARGIN_X, y: placed.baselines[0]!, size: TYPE.rowLabel, font: F.body, color: TOKENS.neutral600 });
        page.drawText(DOSSIER_VERDICT_ABSENT_REASON, { x: MARGIN_X + pt(120), y: placed.baselines[0]!, size: TYPE.rowValue, font: F.body, color: TOKENS.neutral700 });
        cursor = placed.nextRuleY;
      }

      let contentsRule = drawSectionHeading(page, pageNo, "CONTENTS", cursor, F, rhythm);
      const factCount = content.sections.reduce((n, s) => n + s.facts.length, 0);
      contentsRule = drawBriefFactRow(
        page,
        pageNo,
        {
          label: "Sections",
          valueLines: wrapTextToWidth(
            `${content.sections.length} sections, ${factCount} facts total`,
            F.body,
            TYPE.rowValue,
            PAGE_WIDTH - MARGIN_X - (MARGIN_X + pt(200)),
          ),
          greyLines: briefPages > 0 ? [briefPages === 1 ? "sheet 2" : `sheets 2–${1 + briefPages}`] : [],
          chip: false,
        },
        contentsRule,
        F,
        rhythm,
      );
      contentsRule = drawBriefFactRow(
        page,
        pageNo,
        {
          label: "Narrative",
          valueLines: [narrativeText ? "included" : "not available"],
          greyLines: [
            options.narrativeOverride
              ? `generated ${options.narrativeOverride.generatedBy}`
              : "a plain summary of the facts above, with a citation for each sentence",
          ],
          chip: false,
        },
        contentsRule,
        F,
        rhythm,
      );
      contentsRule = drawBriefFactRow(
        page,
        pageNo,
        options.sitePlan
          ? { label: "Site-plan sheet", valueLines: [`sheet ${total} appended`], greyLines: ["drawing only"], chip: false }
          : { label: "Site-plan sheet", valueLines: [], greyLines: ["Not appended; see the fine print for the reason."], chip: true },
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

    const fineSentences = [DOSSIER_COMPILATION_LINE, SITE_PLAN_HONESTY_LINE, FEASIBILITY_NOT_LEGAL_ADVICE];
    if (planned.kind === "notes") fineSentences.push(FEASIBILITY_NARRATIVE_DISCLOSURE);
    if (planned.kind === "cover" && !options.sitePlan) {
      fineSentences.push(`Site-plan sheets are not appended: ${options.sitePlanUnavailableReason ?? "site-plan authoring was unavailable for this parcel"}.`);
    }
    if (i === plannedPages.length - 1 + (options.sitePlan ? 0 : 0)) {
      // GIS-reference note rides the last feasibility (non-site-plan) sheet's fine print.
    }
    fineSentences.push(`· Sheet ${pageNo} of ${total}`);
    drawFinePrint(page, pageNo, fineSentences.join(" "), F, marks);
  });

  let sitePlanResult: PdfSitePlanResult | undefined;
  if (sitePlanRender) {
    sitePlanResult = await sitePlanRender;
    const spDoc = await PDFDocument.load(sitePlanResult.bytes);
    const copied = await doc.copyPages(spDoc, spDoc.getPageIndices());
    for (const p of copied) doc.addPage(p);
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return {
    bytes,
    pageCount: total,
    feasibilityPageCount,
    sitePlanAppended: !!options.sitePlan,
    sitePlanUnavailableReason: options.sitePlan ? undefined : options.sitePlanUnavailableReason,
    sectionCount: content.sections.length,
    openItemCount,
    narrativeGrounded: true,
    narrativeIsDeterministicSkeleton: !options.narrativeOverride,
    marks: marks.marks,
    rhythm: rhythm.rows,
    sitePlan: sitePlanResult ? (({ bytes: _bytes, ...rest }) => rest)(sitePlanResult) : undefined,
  };
}

// Re-exported for tests and the author layer; avoids a second import path
// for the shared PDF page type.
export type { PDFPage };
