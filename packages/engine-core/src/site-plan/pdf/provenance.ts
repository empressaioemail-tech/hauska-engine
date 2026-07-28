import type { SitePlanModel } from "../site-model.js";
import { CONFIDENCE, confidenceCell } from "./format.js";

/**
 * The honesty line, formalized verbatim per 75o spec / WDLL item 5. Any
 * consumer that asserts survey-grade accuracy off this artifact is
 * contradicting this exact string, which is drawn on every PDF sheet.
 */
export const SITE_PLAN_HONESTY_LINE =
  "Derived from public GIS records. Not a boundary survey. Not for legal record.";

/**
 * SHEET STANDARD v1.0 §7 + §13: provenance is a THREE-column table — layer,
 * source, confidence — one row per layer. Confidence is the fixed short enum
 * (asserted · rule · sample · centerline accurate · honest absence · honest
 * unavailable) plus at most one qualifier. Machine identifiers appear ONLY in
 * the source column (§11).
 */
export interface ProvenancePanelEntry {
  layer: string;
  source: string;
  confidence: string;
}

/**
 * Every layer on the drawing traces to its source atom/reference field here
 * — WDLL item 6 ("no bare geometry without provenance"). Built entirely
 * from fields already on the shared `SitePlanModel`; no second lookup.
 */
export function buildProvenancePanelEntries(model: SitePlanModel): ProvenancePanelEntry[] {
  const contourIsSample = /synthetic|sample|fixture/i.test(model.citations.contour);
  const streetHasAssumedEdges = model.streets.anchors.some(
    (a) => a.leftEdgeLocal || a.rightEdgeLocal,
  );

  const setbackConfidence = model.setback.honestAbsence
    ? CONFIDENCE.honestAbsence
    : model.setback.degenerate
      ? confidenceCell(CONFIDENCE.rule, "degenerate")
      : CONFIDENCE.rule;

  const entries: ProvenancePanelEntry[] = [
    {
      layer: "Property / dimension",
      source: model.citations.propertyLine,
      confidence: confidenceCell(CONFIDENCE.asserted, "GIS-approx"),
    },
    {
      layer: "Setback",
      source: model.citations.setback,
      confidence: setbackConfidence,
    },
    {
      layer: "Contour / elevation",
      source: model.citations.contour,
      confidence: contourIsSample
        ? confidenceCell(CONFIDENCE.sample, "not live 3DEP")
        : CONFIDENCE.asserted,
    },
    model.streets.honestAbsence
      ? {
          layer: "Street",
          source: "unavailable",
          confidence: CONFIDENCE.honestAbsence,
        }
      : {
          layer: "Street",
          source: model.streets.anchors.map((a) => a.sourceRef ?? a.name).join("; "),
          confidence: streetHasAssumedEdges
            ? confidenceCell(CONFIDENCE.centerlineAccurate, "ROW assumed")
            : CONFIDENCE.centerlineAccurate,
        },
    model.summary.zoningDistrict
      ? {
          layer: "Zoning",
          source: model.citations.zoning ?? "zoning-fact atom",
          confidence: model.summary.zoningFixture
            ? confidenceCell(CONFIDENCE.asserted, "fixture")
            : CONFIDENCE.asserted,
        }
      : {
          layer: "Zoning",
          source: "unavailable",
          confidence: CONFIDENCE.honestAbsence,
        },
    "zone" in model.summary.floodZone
      ? {
          layer: "Flood zone",
          source: model.summary.floodZone.sourceCitation,
          confidence: model.summary.floodZone.zone
            ? confidenceCell(CONFIDENCE.asserted, `zone ${model.summary.floodZone.zone}`)
            : confidenceCell(CONFIDENCE.asserted, "outside mapped SFHA"),
        }
      : {
          layer: "Flood zone",
          source: "unavailable",
          confidence: CONFIDENCE.honestUnavailable,
        },
  ];
  return entries;
}
