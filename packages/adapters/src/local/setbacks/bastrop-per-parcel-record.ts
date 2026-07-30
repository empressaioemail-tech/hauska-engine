/**
 * Bastrop city per-parcel setback record (WDLL STEP 1 / AMENDMENT 2+3).
 *
 * Authoritative NUMBER source: AGOL Parcels_One_Click/FeatureServer/23
 * (`Parcel_OneClick_Join`). Ordinance chart (`bastrop-development-code.json`)
 * is verification + disagreement flag only — not the warm scalar author.
 *
 * Public endpoint; no privileged relationship required.
 */

import { arcgisWhereQuery } from "../../arcgis.js";
import { AdapterRunError } from "../../types.js";
import type { SetbackDistrict, SetbackTable } from "./table-types.js";
import bastropDevelopmentCode from "./bastrop-development-code.json" with { type: "json" };

/** Layer 23 — per-parcel setback numbers + Ordinance_Link. */
export const BASTROP_PARCELS_ONE_CLICK_LAYER_23 =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Parcels_One_Click/FeatureServer/23";

const CORNER_SIDE_RE =
  /\(Corner Side Street Setback:\s*([\d.]+)\s*ft\)/i;
const NON_SCALAR_SIDE_RE = /Reference Building Code\/Fire Code/i;
const FEET_NUMBER_RE = /([\d.]+)\s*(?:'|ft\b)?/i;

export type BastropPerParcelHonestDecline = {
  kind: "honest-decline";
  code: string;
  reason: string;
  propId: string;
};

export type BastropPerParcelSetbackParsed = {
  kind: "parsed";
  propId: string;
  frontFt: number;
  rearFt: number;
  /** Interior side yard; null when city record is non-scalar. */
  sideInteriorFt: number | null;
  sideCornerFt: number;
  sideNonScalar: boolean;
  sideDeclineReason?: string;
  maxHeightFt?: number;
  maxImperviousPct?: number;
  minLotSize?: string;
  ordinanceLink: string;
  sourceUrl: string;
  raw: {
    frontSetback?: string;
    sideSetback?: string;
    rearSetback?: string;
  };
};

export type BastropChartDisagreement = {
  disagrees: boolean;
  districtCode: string;
  chart?: {
    frontFt: number;
    sideInteriorFt: number;
    sideCornerFt: number;
    rearFt: number;
  };
  record: {
    frontFt: number;
    sideInteriorFt: number | null;
    sideCornerFt: number;
    rearFt: number;
  };
};

function pickString(attrs: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = attrs[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function pickPropId(attrs: Record<string, unknown>): string {
  const raw = attrs.prop_id ?? attrs.PROP_ID ?? attrs.Prop_ID;
  if (raw === undefined || raw === null) return "";
  return String(raw).trim();
}

/** Parse a scalar feet field (FrontSetback_ / RearSetback_). */
export function parseScalarSetbackFeet(
  text: string | null | undefined,
): number | null {
  if (text == null) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  const m = FEET_NUMBER_RE.exec(trimmed);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export type ParsedSideSetback =
  | {
      ok: true;
      sideInteriorFt: number;
      sideCornerFt: number;
      nonScalar: false;
    }
  | {
      ok: false;
      nonScalar: true;
      reason: string;
    };

/**
 * Parse SideSetback_ text: interior feet + optional corner embed.
 * Honest-decline when non-scalar ("Reference Building Code/Fire Code").
 */
export function parseSideSetbackText(
  text: string | null | undefined,
): ParsedSideSetback {
  if (text == null || !String(text).trim()) {
    return {
      ok: false,
      nonScalar: true,
      reason: "SideSetback field empty.",
    };
  }
  const raw = String(text).trim();
  if (NON_SCALAR_SIDE_RE.test(raw)) {
    return {
      ok: false,
      nonScalar: true,
      reason:
        "Side setback is non-scalar (Reference Building Code/Fire Code).",
    };
  }

  const cornerMatch = CORNER_SIDE_RE.exec(raw);
  const cornerFt = cornerMatch ? Number(cornerMatch[1]) : null;
  const interiorSource = cornerMatch
    ? raw.slice(0, cornerMatch.index).trim()
    : raw;
  const interiorFt = parseScalarSetbackFeet(interiorSource);
  if (interiorFt == null) {
    return {
      ok: false,
      nonScalar: true,
      reason: `Could not parse interior side feet from "${raw}".`,
    };
  }
  const resolvedCorner =
    cornerFt != null && Number.isFinite(cornerFt) ? cornerFt : interiorFt;
  return {
    ok: true,
    sideInteriorFt: interiorFt,
    sideCornerFt: resolvedCorner,
    nonScalar: false,
  };
}

function parseImperviousPct(text: string | null | undefined): number | undefined {
  if (!text?.trim()) return undefined;
  const m = /([\d.]+)/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse raw layer-23 attributes into a typed per-parcel setback record. */
export function parseBastropPerParcelAttributes(
  attrs: Record<string, unknown>,
): BastropPerParcelSetbackParsed | BastropPerParcelHonestDecline {
  const propId = pickPropId(attrs);
  if (!propId) {
    return {
      kind: "honest-decline",
      code: "bastrop-per-parcel-missing-prop-id",
      reason: "Layer 23 feature missing prop_id.",
      propId: "",
    };
  }

  const frontRaw = pickString(attrs, "FrontSetback_", "FrontSetback");
  const sideRaw = pickString(attrs, "SideSetback_", "SideSetback");
  const rearRaw = pickString(attrs, "RearSetback_", "RearSetback");
  const ordinanceLink = pickString(attrs, "Ordinance_Link", "OrdinanceLink");
  const minLotSize = pickString(attrs, "MinimumLotSize_", "MinimumLotSize");

  const frontFt = parseScalarSetbackFeet(frontRaw);
  const rearFt = parseScalarSetbackFeet(rearRaw);
  if (frontFt == null || rearFt == null) {
    return {
      kind: "honest-decline",
      code: "bastrop-per-parcel-incomplete-scalars",
      reason: "Front or rear setback missing or non-numeric on layer 23.",
      propId,
    };
  }

  const sideParsed = parseSideSetbackText(sideRaw);
  const maxHeightRaw = attrs.MaxBuildingHt ?? attrs.MaxBuildingHeight;
  const maxHeightFt =
    typeof maxHeightRaw === "number"
      ? maxHeightRaw
      : parseScalarSetbackFeet(String(maxHeightRaw ?? ""));
  const maxImperviousPct = parseImperviousPct(
    pickString(attrs, "MaxImpervisionCoverage", "MaxImperviousCoverage"),
  );

  if (!sideParsed.ok) {
    return {
      kind: "parsed",
      propId,
      frontFt,
      rearFt,
      sideInteriorFt: null,
      sideCornerFt: frontFt,
      sideNonScalar: true,
      sideDeclineReason: sideParsed.reason,
      maxHeightFt: maxHeightFt ?? undefined,
      maxImperviousPct,
      minLotSize: minLotSize || undefined,
      ordinanceLink:
        ordinanceLink ||
        "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Parcels_One_Click/FeatureServer/23",
      sourceUrl: BASTROP_PARCELS_ONE_CLICK_LAYER_23,
      raw: {
        frontSetback: frontRaw || undefined,
        sideSetback: sideRaw || undefined,
        rearSetback: rearRaw || undefined,
      },
    };
  }

  return {
    kind: "parsed",
    propId,
    frontFt,
    rearFt,
    sideInteriorFt: sideParsed.sideInteriorFt,
    sideCornerFt: sideParsed.sideCornerFt,
    sideNonScalar: false,
    maxHeightFt: maxHeightFt ?? undefined,
    maxImperviousPct,
    minLotSize: minLotSize || undefined,
    ordinanceLink:
      ordinanceLink ||
      "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Parcels_One_Click/FeatureServer/23",
    sourceUrl: BASTROP_PARCELS_ONE_CLICK_LAYER_23,
    raw: {
      frontSetback: frontRaw || undefined,
      sideSetback: sideRaw || undefined,
      rearSetback: rearRaw || undefined,
    },
  };
}

function leadingDistrictToken(districtName: string): string {
  return (districtName.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

function chartDistrictRow(districtCode: string): SetbackDistrict | null {
  const table = bastropDevelopmentCode as SetbackTable;
  const wanted = leadingDistrictToken(districtCode);
  return (
    table.districts.find(
      (d) => leadingDistrictToken(d.district_name) === wanted,
    ) ?? null
  );
}

/** Flag when per-parcel record differs from ordinance-chart scalars (gate d). */
export function flagBastropChartDisagreement(
  record: BastropPerParcelSetbackParsed,
  districtCode: string,
): BastropChartDisagreement {
  const chart = chartDistrictRow(districtCode);
  const rec = {
    frontFt: record.frontFt,
    sideInteriorFt: record.sideInteriorFt,
    sideCornerFt: record.sideCornerFt,
    rearFt: record.rearFt,
  };
  if (!chart || record.sideInteriorFt == null) {
    return { disagrees: false, districtCode, record: rec };
  }
  const chartVals = {
    frontFt: chart.front_ft,
    sideInteriorFt: chart.side_ft,
    sideCornerFt: chart.side_corner_ft,
    rearFt: chart.rear_ft,
  };
  const disagrees =
    chartVals.frontFt !== rec.frontFt ||
    chartVals.sideInteriorFt !== rec.sideInteriorFt ||
    chartVals.sideCornerFt !== rec.sideCornerFt ||
    chartVals.rearFt !== rec.rearFt;
  return {
    disagrees,
    districtCode,
    chart: chartVals,
    record: {
      frontFt: rec.frontFt,
      sideInteriorFt: rec.sideInteriorFt,
      sideCornerFt: rec.sideCornerFt,
      rearFt: rec.rearFt,
    },
  };
}

/** Synthesize a one-row SetbackTable from a parsed per-parcel record. */
export function setbackTableFromBastropPerParcelRecord(
  record: BastropPerParcelSetbackParsed,
  districtCode: string,
): SetbackTable {
  const code = leadingDistrictToken(districtCode) || "UNKNOWN";
  const sideInterior = record.sideInteriorFt ?? 0;
  const sideNotSpecified = record.sideNonScalar;
  const district: SetbackDistrict = {
    district_name: `${code} (per-parcel layer 23)`,
    front_ft: record.frontFt,
    rear_ft: record.rearFt,
    side_ft: sideInterior,
    side_corner_ft: record.sideCornerFt,
    max_height_ft: record.maxHeightFt ?? 0,
    max_lot_coverage_pct: 0,
    max_impervious_pct: record.maxImperviousPct ?? 0,
    citation_url: record.ordinanceLink,
    provenance: {
      front_ft: {
        atom_did: `bastrop-per-parcel/${record.propId}/front`,
        confidence: 0.92,
        verification_state: "transcribed",
        quote: `Parcels_One_Click/23 prop_id=${record.propId} FrontSetback_`,
      },
      rear_ft: {
        atom_did: `bastrop-per-parcel/${record.propId}/rear`,
        confidence: 0.92,
        verification_state: "transcribed",
        quote: `Parcels_One_Click/23 prop_id=${record.propId} RearSetback_`,
      },
      side_ft: {
        atom_did: `bastrop-per-parcel/${record.propId}/side-interior`,
        confidence: sideNotSpecified ? 0.5 : 0.92,
        verification_state: "transcribed",
        quote: record.raw.sideSetback ?? "",
        ...(sideNotSpecified ? { not_specified: true } : {}),
      },
      side_corner_ft: {
        atom_did: `bastrop-per-parcel/${record.propId}/side-corner`,
        confidence: sideNotSpecified ? 0.5 : 0.92,
        verification_state: "transcribed",
        quote: record.raw.sideSetback ?? "",
        ...(sideNotSpecified ? { not_specified: true } : {}),
      },
      ...(record.maxHeightFt != null
        ? {
            max_height_ft: {
              atom_did: `bastrop-per-parcel/${record.propId}/height`,
              confidence: 0.9,
              verification_state: "transcribed",
            },
          }
        : {}),
    },
  };
  return {
    jurisdictionKey: "bastrop-per-parcel-record",
    jurisdictionDisplayName:
      "City of Bastrop, TX (Parcels_One_Click layer 23 per-parcel record)",
    note: `Per-parcel authoritative numbers for prop_id=${record.propId}; cites Ordinance_Link.`,
    districts: [district],
  };
}

export type FetchBastropPerParcelOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

/** Live fetch layer 23 by prop_id (numeric; leading zeros stripped for match). */
export async function fetchBastropPerParcelSetbackRecord(
  propId: string,
  options: FetchBastropPerParcelOptions = {},
): Promise<BastropPerParcelSetbackParsed | BastropPerParcelHonestDecline> {
  const normalized = String(propId).trim().replace(/^0+/, "") || "0";
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) {
    return {
      kind: "honest-decline",
      code: "bastrop-per-parcel-invalid-prop-id",
      reason: `Invalid prop_id "${propId}".`,
      propId: String(propId),
    };
  }

  let result;
  try {
    result = await arcgisWhereQuery({
      serviceUrl: BASTROP_PARCELS_ONE_CLICK_LAYER_23,
      where: `prop_id = ${numeric}`,
      outFields:
        "prop_id,FrontSetback_,SideSetback_,RearSetback_,MaxBuildingHt,MinimumLotSize_,MaxImpervisionCoverage,Ordinance_Link",
      returnGeometry: false,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      upstreamLabel: "Bastrop Parcels_One_Click layer 23",
    });
  } catch (err) {
    if (err instanceof AdapterRunError) {
      return {
        kind: "honest-decline",
        code: "bastrop-per-parcel-fetch-failed",
        reason: err.message,
        propId: normalized,
      };
    }
    throw err;
  }

  if (result.features.length === 0) {
    return {
      kind: "honest-decline",
      code: "bastrop-per-parcel-not-found",
      reason: `No layer-23 row for prop_id=${normalized}.`,
      propId: normalized,
    };
  }

  return parseBastropPerParcelAttributes(result.features[0]!.attributes);
}
