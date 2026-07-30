/**
 * Bastrop city per-parcel setback record (WDLL STEP 1 / AMENDMENT 2+3).
 *
 * Authoritative NUMBER source: AGOL Parcels_One_Click/FeatureServer/23
 * (`Parcel_OneClick_Join`). Ordinance chart (`bastrop-development-code.json`)
 * is verification + disagreement flag only — not the warm scalar author.
 *
 * Public endpoint; no privileged relationship required.
 */

import { arcgisPointQuery, arcgisWhereQuery } from "../../arcgis.js";
import { AdapterRunError } from "../../types.js";
import type {
  SetbackDisplayMeta,
  SetbackDistrict,
  SetbackSecondSourceDisclosure,
  SetbackTable,
} from "./table-types.js";
import bastropDevelopmentCode from "./bastrop-development-code.json" with { type: "json" };

/** Layer 23 — per-parcel setback numbers + Ordinance_Link. */
export const BASTROP_PARCELS_ONE_CLICK_LAYER_23 =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Parcels_One_Click/FeatureServer/23";

/** Numeric `ZoneTypeClass` on layer 23 / 83 → BDC district code (STEP 2). */
export const BASTROP_ZONE_TYPE_CLASS: Readonly<Record<number, string>> = {
  1: "P/OS",
  2: "RR",
  3: "SF-1",
  4: "SF-2",
  5: "SF-3",
  6: "MU",
  7: "GC",
  8: "PI",
  9: "IND",
  10: "PDD",
};

const ZONE_TYPE_CLASS_BY_CODE: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(BASTROP_ZONE_TYPE_CLASS).map(([n, code]) => [code, Number(n)]),
);

function zoneTypeClassNumeric(attrs: Record<string, unknown>): number | null {
  const raw = attrs.ZoneTypeClass ?? attrs.ZONETYPECLASS ?? attrs.zone_type_class;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function districtCodeFromZoneTypeClass(attrs: Record<string, unknown>): string | null {
  const n = zoneTypeClassNumeric(attrs);
  if (n == null) return null;
  return BASTROP_ZONE_TYPE_CLASS[n] ?? null;
}

function featureShapeArea(attrs: Record<string, unknown>): number {
  const raw = attrs.Shape__Area ?? attrs.SHAPE__Area ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** A split-zone sliver at/below this area (sq units) never governs the district (R26). */
export const SPLIT_ZONE_SLIVER_AREA_EPSILON = 1;

export type BastropSplitZoneMinorZone = {
  districtCode: string | null;
  shapeArea: number;
};

/**
 * R26 — split-zone dominant-area resolution.
 * When a parcel spans multiple layer-23 rows, the LARGEST-AREA row governs the
 * district (not the engine zoning stamp, which may be a sliver). Minor zones are
 * returned for honest disclosure (R25). districtCode is used only as a tiebreak
 * among rows of equal area.
 */
export function resolveBastropLayer23DominantRow(
  features: ReadonlyArray<{ attributes: Record<string, unknown> }>,
  districtCode?: string | null,
): {
  dominant: Record<string, unknown>;
  dominantDistrictCode: string | null;
  minorZones: BastropSplitZoneMinorZone[];
} | null {
  if (features.length === 0) return null;

  const byArea = [...features].sort(
    (a, b) => featureShapeArea(b.attributes) - featureShapeArea(a.attributes),
  );

  // Dominant = largest area. Tiebreak (equal top areas) toward the engine stamp.
  const topArea = featureShapeArea(byArea[0]!.attributes);
  const wanted = (districtCode ?? "").trim().toUpperCase();
  const wantedNum = wanted ? ZONE_TYPE_CLASS_BY_CODE[wanted] : undefined;
  let dominantFeature = byArea[0]!;
  if (wantedNum != null) {
    const tiedStamp = byArea.find(
      (f) =>
        featureShapeArea(f.attributes) >= topArea - SPLIT_ZONE_SLIVER_AREA_EPSILON &&
        zoneTypeClassNumeric(f.attributes) === wantedNum,
    );
    if (tiedStamp) dominantFeature = tiedStamp;
  }

  const minorZones: BastropSplitZoneMinorZone[] = byArea
    .filter((f) => f !== dominantFeature)
    .map((f) => ({
      districtCode: districtCodeFromZoneTypeClass(f.attributes),
      shapeArea: featureShapeArea(f.attributes),
    }));

  return {
    dominant: dominantFeature.attributes,
    dominantDistrictCode: districtCodeFromZoneTypeClass(dominantFeature.attributes),
    minorZones,
  };
}

/**
 * Pick the governing layer-23 row on overlap parcels (R26 dominant-area).
 * Falls back to largest Shape__Area when district is unknown or unmatched.
 */
export function selectBastropLayer23Attributes(
  features: ReadonlyArray<{ attributes: Record<string, unknown> }>,
  districtCode?: string | null,
): Record<string, unknown> | null {
  const resolved = resolveBastropLayer23DominantRow(features, districtCode);
  return resolved?.dominant ?? null;
}

const CORNER_SIDE_RE =
  /\(Corner Side Street Setback:\s*([\d.]+)\s*ft\)/i;
const NON_SCALAR_SIDE_RE =
  /(?:none\s*-\s*)?reference building code\/fire code/i;
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
  /** Interior side yard; null when city record is non-scalar AND unresolvable. */
  sideInteriorFt: number | null;
  sideCornerFt: number;
  sideNonScalar: boolean;
  sideDeclineReason?: string;
  /** R22 — side resolved from a building/fire-code deferral (5ft), not a printed scalar. */
  sideFireCodeDeferral?: boolean;
  /** City's verbatim side-yard language when deferred to building/fire code. */
  sideCityLanguage?: string;
  maxHeightFt?: number;
  maxImperviousPct?: number;
  minLotSize?: string;
  ordinanceLink: string;
  sourceUrl: string;
  /** R26 — district resolved from the DOMINANT-area layer-23 row (may differ from engine stamp). */
  resolvedDistrictCode?: string | null;
  /** R26/R25 — split-zone minor zones present on this parcel, for honest disclosure. */
  splitZoneMinorZones?: BastropSplitZoneMinorZone[];
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
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
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

/**
 * R22 — fire-code standard applied when the city record defers a side yard to
 * building/fire code ("None - Reference Building/Fire Code"). A broad, citable
 * baseline so the envelope DRAWS instead of collapsing to a whole-parcel decline.
 */
export const FIRE_CODE_SIDE_SETBACK_FT = 5;

export type ParsedSideSetback =
  | {
      ok: true;
      sideInteriorFt: number;
      sideCornerFt: number;
      nonScalar: false;
      /** R22 — resolved from a building/fire-code deferral, not a printed scalar. */
      fireCodeDeferral?: boolean;
      /** City's verbatim language for the card, when deferred. */
      cityLanguage?: string;
    }
  | {
      ok: false;
      nonScalar: true;
      reason: string;
    };

/**
 * Parse SideSetback_ text: interior feet + optional corner embed.
 * R22: "Reference Building Code/Fire Code" resolves to the 5ft fire-code
 * standard (envelope draws) with the city language surfaced — NOT a decline.
 * Genuinely-unparseable / empty side text still honest-declines.
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
    // R22 — fire-code deferral resolves to the code minimum so the envelope draws.
    return {
      ok: true,
      sideInteriorFt: FIRE_CODE_SIDE_SETBACK_FT,
      sideCornerFt: FIRE_CODE_SIDE_SETBACK_FT,
      nonScalar: false,
      fireCodeDeferral: true,
      cityLanguage: raw,
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
  propIdOverride?: string,
): BastropPerParcelSetbackParsed | BastropPerParcelHonestDecline {
  const propId = propIdOverride ?? pickPropId(attrs);
  if (!propId) {
    return {
      kind: "honest-decline",
      code: "bastrop-per-parcel-missing-prop-id",
      reason: "Layer 23 feature missing prop_id.",
      propId: "",
    };
  }

  const frontRaw = pickString(attrs, "FrontSetback_", "FrontSetback");
  const sideRaw = pickString(attrs, "SideSetback", "SideSetback_");
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
    ...(sideParsed.fireCodeDeferral
      ? {
          sideFireCodeDeferral: true,
          sideCityLanguage: sideParsed.cityLanguage,
        }
      : {}),
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

/** Layer 83 (Zoned_Parcels Revisions) — Bastrop's CONFLICTING second setback schedule (R25). */
export const BASTROP_LAYER_83_REVISIONS_URL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Parcels_One_Click/FeatureServer/83";

/** Per-district layer-83 conflict text (block-13 answer key, confirmed 2026-07-30). */
const BASTROP_LAYER_83_CONFLICT_BY_DISTRICT: Readonly<Record<string, string>> = {
  "SF-1":
    "front 30 / interior side 10 / corner side 20 / rear 30",
  MU: "max height 45",
  GC: "corner side 10",
};

/** R25 — build the layer-83 Revisions conflict disclosure for a dominant district. */
export function bastropLayer83SecondSourceDisclosure(
  districtCode: string,
): SetbackSecondSourceDisclosure | undefined {
  const code = leadingDistrictToken(districtCode);
  const conflict = BASTROP_LAYER_83_CONFLICT_BY_DISTRICT[code];
  if (!conflict) return undefined;
  return {
    source: "City of Bastrop GIS layer 83 (Zoned_Parcels Revisions)",
    note:
      `Drawn from OnClick (layer 23). The city's Revisions layer (83) specifies ${conflict} for ${code}; ` +
      "the two city schedules conflict — verify which is in effect with the city.",
    citation_url: BASTROP_LAYER_83_REVISIONS_URL,
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
  const displayMeta: SetbackDisplayMeta = {
    ...(record.minLotSize ? { min_lot_size: record.minLotSize } : {}),
    ...(record.sideFireCodeDeferral
      ? {
          side_fire_code_deferral: true,
          ...(record.sideCityLanguage
            ? { side_city_language: record.sideCityLanguage }
            : {}),
        }
      : {}),
    ...(record.resolvedDistrictCode
      ? { resolved_district_code: record.resolvedDistrictCode }
      : {}),
    ...(record.splitZoneMinorZones?.length
      ? {
          split_zone_minor_zones: record.splitZoneMinorZones.map((z) => ({
            district_code: z.districtCode,
            shape_area: z.shapeArea,
          })),
        }
      : {}),
    ...(() => {
      const second = bastropLayer83SecondSourceDisclosure(code);
      return second ? { second_source: second } : {};
    })(),
  };
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
    ...(Object.keys(displayMeta).length > 0 ? { display_meta: displayMeta } : {}),
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
  /** ENGINE zoning stamp / R26 dominant district — selects the correct layer-23 row on split-zone overlaps. */
  districtCode?: string | null;
  /** When prop_id miss on layer 23, spatial intersect at this point (R9 re-plat fallback). */
  centroidLngLat?: [number, number];
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
        "prop_id,ZoneTypeClass,FrontSetback_,FrontSetback,SideSetback_,SideSetback,RearSetback_,RearSetback,MaxBuildingHt,MinimumLotSize_,MaxImpervisionCoverage,Ordinance_Link,Shape__Area",
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

  if (result.features.length === 0 && options.centroidLngLat) {
    const [lng, lat] = options.centroidLngLat;
    try {
      result = await arcgisPointQuery({
        serviceUrl: BASTROP_PARCELS_ONE_CLICK_LAYER_23,
        longitude: lng,
        latitude: lat,
        outFields:
          "prop_id,ZoneTypeClass,FrontSetback_,FrontSetback,SideSetback_,SideSetback,RearSetback_,RearSetback,MaxBuildingHt,MinimumLotSize_,MaxImpervisionCoverage,Ordinance_Link,Shape__Area",
        returnGeometry: false,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        upstreamLabel: "Bastrop Parcels_One_Click layer 23 (spatial fallback)",
      });
    } catch {
      /* fall through to not-found */
    }
  }

  if (result.features.length === 0) {
    return {
      kind: "honest-decline",
      code: "bastrop-per-parcel-not-found",
      reason: `No layer-23 row for prop_id=${normalized}.`,
      propId: normalized,
    };
  }

  const resolved = resolveBastropLayer23DominantRow(
    result.features,
    options.districtCode,
  );
  if (!resolved) {
    return {
      kind: "honest-decline",
      code: "bastrop-per-parcel-empty-features",
      reason: `Layer 23 returned no usable attributes for prop_id=${normalized}.`,
      propId: normalized,
    };
  }
  const parsed = parseBastropPerParcelAttributes(resolved.dominant, normalized);
  if (parsed.kind === "parsed") {
    // R26 — carry the dominant-area district + minor zones for disclosure (R25).
    parsed.resolvedDistrictCode = resolved.dominantDistrictCode;
    parsed.splitZoneMinorZones =
      resolved.minorZones.length > 0 ? resolved.minorZones : undefined;
  }
  return parsed;
}
