/**
 * Euclidean zoning layer identification — geometry + field shape only.
 * No /zon/ name regex gates (CP1).
 */

import type { Bbox4326, LayerFieldMeta, LayerProbeMeta } from "./types.js";

// Strong Euclidean tokens only. Bare C1/A1 (map-grid page names) are NOT enough.
const EUCLIDEAN_CODE_RE =
  /^(R-\d+|SF\d+|MF\d+|C-\d+|M\d+|GC|HS|CS|OP|MP|PUD|TF|I-\d+|PD|LU|MU|RM|RS|RL|RH|CN|LI|HI|OS|AG|RES|COM|IND)/i;

const CONSTRAINT_FIELD_RE =
  /^(LOTSIZE|LOT_SIZE|MIN_LOT|BLD__LINE|BLD_LINE|BUILDING.?LINE|SETBACK|MINBL|MIN_BLD)/i;

const CONSTRAINT_NAME_RE =
  /(minimum lot size|building line|setback only|historic district overlay only)/i;

export function looksLikeDistrictCode(value: unknown): boolean {
  if (value == null) return false;
  const s = String(value).trim();
  if (s.length === 0 || s.length > 24) return false;
  if (/^\d+(\.\d+)?$/.test(s)) return false;
  if (EUCLIDEAN_CODE_RE.test(s)) return true;
  // Loose letter/digit tokens alone are not enough (map-grid PageName "A1"
  // false-positived over Deer Park Zoning_WGS84). Keep as secondary only when
  // paired with strong Euclidean evidence at the layer level.
  if (/^(PUD|PD|MU|MF|SF|GC|CS|M\d|TF|OP|MP|HS)$/i.test(s)) return true;
  return false;
}

export function hasStrongEuclideanCodeEvidence(values: unknown[]): boolean {
  const strong = values
    .map((v) => String(v ?? "").trim())
    .filter((s) => s.length > 0 && EUCLIDEAN_CODE_RE.test(s));
  return new Set(strong).size >= 2;
}

export function isConstraintFieldName(fieldName: string): boolean {
  return CONSTRAINT_FIELD_RE.test(fieldName);
}

export function isLotSizeOnlyLayer(
  fields: LayerFieldMeta[],
  sampleValues: Record<string, unknown[]>,
): boolean {
  const codeLike = fields.filter((f) => {
    const samples = sampleValues[f.name] ?? [];
    return samples.some(looksLikeDistrictCode);
  });
  if (codeLike.length > 0) return false;

  const lotFields = fields.filter((f) => /LOTSIZE|LOT_SIZE|MIN_LOT/i.test(f.name));
  if (lotFields.length === 0) return false;

  const hasOnlyNumeric = lotFields.every((f) => {
    const samples = sampleValues[f.name] ?? [];
    return samples.length > 0 && samples.every((v) => /^\d+(\.\d+)?$/.test(String(v)));
  });
  return hasOnlyNumeric && fields.every((f) => !/BLD/i.test(f.name) || isConstraintFieldName(f.name));
}

export function isBuildingLineOnlyLayer(
  fields: LayerFieldMeta[],
  sampleValues: Record<string, unknown[]>,
): boolean {
  const codeLike = fields.filter((f) => {
    const samples = sampleValues[f.name] ?? [];
    return samples.some(looksLikeDistrictCode);
  });
  if (codeLike.length > 0) return false;

  const bldFields = fields.filter((f) => /BLD__LINE|BLD_LINE|BUILDING.?LINE|MIN_BLD/i.test(f.name));
  if (bldFields.length === 0) return false;

  return bldFields.some((f) => (sampleValues[f.name] ?? []).length > 0);
}

function pickCodeField(
  fields: LayerFieldMeta[],
  sampleValues: Record<string, unknown[]>,
): string | null {
  const hints = ["CODE", "ZONE", "ZONING", "DISTRICT", "ZONE_CODE", "ZONING_CODE", "ZONECLASS"];
  for (const hint of hints) {
    const match = fields.find((f) => f.name.toUpperCase() === hint || f.name.toUpperCase().includes(hint));
    if (match && (sampleValues[match.name] ?? []).some(looksLikeDistrictCode)) {
      return match.name;
    }
  }
  for (const f of fields) {
    const samples = sampleValues[f.name] ?? [];
    const distinct = distinctCodeLike(samples);
    if (distinct.length >= 2 && distinct.length <= 200) return f.name;
  }
  return null;
}

function pickDescriptionField(fields: LayerFieldMeta[], codeField: string | null): string | null {
  const hints = ["ZONING", "DESC", "DESCRIPTION", "DISTRICT_NAME", "ZONE_NAME", "CLASS"];
  for (const hint of hints) {
    const match = fields.find(
      (f) =>
        f.name !== codeField &&
        (f.name.toUpperCase() === hint || f.name.toUpperCase().includes(hint)),
    );
    if (match) return match.name;
  }
  return null;
}

function distinctCodeLike(values: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (looksLikeDistrictCode(v)) out.add(String(v).trim());
  }
  return [...out];
}

function bboxOverlap(a: Bbox4326, b: Bbox4326): boolean {
  return !(a.xmax < b.xmin || a.xmin > b.xmax || a.ymax < b.ymin || a.ymin > b.ymax);
}

export type LayerSignatureInput = {
  layerUrl: string;
  servicePath: string;
  layerId: number;
  name: string;
  geometryType: string | null;
  featureCount: number | null;
  fields: LayerFieldMeta[];
  sampleValues: Record<string, unknown[]>;
  extent: Bbox4326 | null;
  cityBbox: Bbox4326;
};

export function classifyLayerSignature(input: LayerSignatureInput): LayerProbeMeta {
  const { fields, sampleValues, geometryType, featureCount, name } = input;

  let rejectReason: string | null = null;
  let isConstraintLayer = false;
  let isEuclideanCandidate = false;
  let euclideanScore = 0;

  if (geometryType !== "esriGeometryPolygon") {
    rejectReason = `geometryType=${geometryType ?? "null"}`;
  } else if ((featureCount ?? 0) < 1) {
    rejectReason = "featureCount<1";
  } else if (isLotSizeOnlyLayer(fields, sampleValues)) {
    rejectReason = "lot-size-only";
    isConstraintLayer = true;
  } else if (isBuildingLineOnlyLayer(fields, sampleValues)) {
    rejectReason = "building-line-only";
    isConstraintLayer = true;
  } else if (CONSTRAINT_NAME_RE.test(name)) {
    isConstraintLayer = true;
    rejectReason = "constraint-layer-name";
  } else {
    const codeField = pickCodeField(fields, sampleValues);
    if (!codeField) {
      rejectReason = "no-code-field-shape";
    } else {
      const samples = sampleValues[codeField] ?? [];
      const distinct = distinctCodeLike(samples);
      if (distinct.length < 2 || distinct.length > 200) {
        rejectReason = `code-cardinality=${distinct.length}`;
      } else if (!hasStrongEuclideanCodeEvidence(samples)) {
        rejectReason = "no-strong-euclidean-code-evidence";
      } else if (input.extent && !bboxOverlap(input.extent, input.cityBbox)) {
        rejectReason = "extent-outside-city-bbox";
      } else {
        isEuclideanCandidate = true;
        // Prefer compact district layers (Deer Park Zoning_WGS84 ~301 / ~18 codes)
        // over basemap FeatureServers with a Zoning attribute (~11k parcels).
        const count = featureCount ?? 0;
        let score = 10 + Math.min(distinct.length, 40);
        if (distinct.length >= 5 && distinct.length <= 40) score += 15;
        if (count > 0 && count <= 2000) score += 20;
        if (count > 2000 && count <= 8000) score += 5;
        if (count > 8000) score -= 25;
        if (codeField && /^code$/i.test(codeField)) score += 8;
        const descField = pickDescriptionField(fields, codeField);
        if (descField) score += 2;
        euclideanScore = score;
      }
    }
  }

  const codeField = pickCodeField(fields, sampleValues);
  const descriptionField = pickDescriptionField(fields, codeField);

  return {
    layerUrl: input.layerUrl,
    servicePath: input.servicePath,
    layerId: input.layerId,
    name: input.name,
    geometryType,
    featureCount,
    fields,
    codeField,
    descriptionField,
    extent: input.extent,
    euclideanScore,
    isConstraintLayer,
    isEuclideanCandidate,
    rejectReason,
  };
}

export function rankEuclideanCandidates(layers: LayerProbeMeta[]): LayerProbeMeta | null {
  const candidates = layers.filter((l) => l.isEuclideanCandidate);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.euclideanScore - a.euclideanScore)[0] ?? null;
}
