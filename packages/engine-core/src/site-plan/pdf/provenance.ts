import type { SitePlanModel } from "../site-model.js";

/**
 * The honesty line, formalized verbatim per 75o spec / WDLL item 5. Any
 * consumer that asserts survey-grade accuracy off this artifact is
 * contradicting this exact string, which is drawn on every PDF sheet.
 */
export const SITE_PLAN_HONESTY_LINE =
  "Derived from public GIS records. Not a boundary survey. Not for legal record.";

export interface ProvenancePanelEntry {
  layer: string;
  source: string;
  asOf: string;
  confidence: string;
}

/**
 * Every layer on the drawing traces to its source atom/reference field here
 * — WDLL item 6 ("no bare geometry without provenance"). Built entirely
 * from fields already on the shared `SitePlanModel`; no second lookup.
 */
export function buildProvenancePanelEntries(model: SitePlanModel): ProvenancePanelEntry[] {
  const nowIso = new Date().toISOString().slice(0, 10);
  const entries: ProvenancePanelEntry[] = [
    {
      layer: "PROPERTY_LINE / DIMENSION",
      source: model.citations.propertyLine,
      asOf: "current parcel-geometry snapshot",
      confidence:
        "asserted (county GIS parcel polygon — bearing/distance tags are GIS-approximate, not a boundary survey)",
    },
    {
      layer: "SETBACK",
      source: model.citations.setback,
      asOf: "current zoning-code snapshot",
      confidence: model.setback.degenerate
        ? `asserted — degenerate: ${model.setback.degenerateReason ?? "setback consumes lot"}`
        : `asserted (front/side/rear basis: ${model.setback.basis})`,
    },
    {
      layer: "CONTOUR / ELEVATION_LABEL",
      source: model.citations.contour,
      asOf: "USGS 3DEP DEM snapshot",
      confidence: model.verticalDatum.summary,
    },
    model.streets.honestAbsence
      ? {
          layer: "STREET",
          source: "unavailable",
          asOf: nowIso,
          confidence: `honest absence — ${model.streets.reason ?? "no road-anchor atom available"}`,
        }
      : {
          layer: "STREET",
          source: model.streets.anchors.map((a) => a.sourceRef ?? a.name).join("; "),
          asOf: nowIso,
          confidence: "asserted (road-anchor data)",
        },
    model.summary.zoningDistrict
      ? {
          layer: "ZONING (summary block)",
          source: model.citations.zoning ?? "zoning-fact atom",
          asOf: "current zoning-fact snapshot",
          confidence: "asserted",
        }
      : {
          layer: "ZONING (summary block)",
          source: "unavailable",
          asOf: nowIso,
          confidence: `honest absence — ${model.summary.zoningHonestAbsenceReason ?? "no zoning-fact atom on file"}`,
        },
    "zone" in model.summary.floodZone
      ? {
          layer: "FLOOD ZONE (summary block)",
          source: model.summary.floodZone.sourceCitation,
          asOf: model.summary.floodZone.asOfIso.slice(0, 10),
          confidence: model.summary.floodZone.zone
            ? `asserted (FEMA zone ${model.summary.floodZone.zone})`
            : "asserted (outside mapped FEMA special flood hazard area)",
        }
      : {
          layer: "FLOOD ZONE (summary block)",
          source: "unavailable",
          asOf: nowIso,
          confidence: `honest unavailable — ${model.summary.floodZone.reason}`,
        },
  ];
  return entries;
}
