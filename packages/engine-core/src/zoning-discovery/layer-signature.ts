/**
 * Euclidean zoning layer identification — geometry + field shape only.
 * No /zon/ name regex gates (CP1).
 */

import type { Bbox4326, LayerFieldMeta, LayerProbeMeta } from "./types.js";

export const ZONING_IDENTIFICATION_THRESHOLDS = {
  minDistinctCodes: 2,
  maxDistinctCodes: 80,
  maxMedianCodeLength: 8,
  maxP90CodeLength: 12,
  minStrongCodeRatio: 0.6,
  minCityCoverageRatio: 0.4,
  /** Layer extent area / city bbox area. County-wide city-limits stacks fail. */
  maxExtentToCityAreaRatio: 8,
} as const;

// Compact district-code grammar. Digit-bearing codes (R-1, SF2) and a closed
// set of short digit-free families are accepted. Bare 3–4 letter city
// abbreviations (FRIS/DENT/PLAN) are not.
const SHORT_DIGIT_FREE_ZONE_RE =
  /^(AG|GB|GC|CS|OP|MP|PUD|PD|TF|HS|MH|MU|LU|VC|OS|CN|LI|HI|RS|RL|RH|RM|IND|RES|COM|SF|MF|GR|GO|LO|LR|NO|P|RR|CBD|IP|LA|AV|CH|CR|DR|MI|TND|ERC|NBG|DMU|NB)$/i;
const EUCLIDEAN_CODE_RE =
  /^(?:R-?\d+[A-Z0-9]*|C-?\d+[A-Z0-9]*|M-?\d+[A-Z0-9]*|I-?\d+[A-Z0-9]*|SF-?\d+[A-Z0-9]*|MF-?\d+[A-Z0-9]*|RE\d+[A-Z0-9]*|RLI|CS-?\d+[A-Z0-9]*|R&D|[A-Z]{1,4}[-/][A-Z0-9]{1,4}(?:[-/][A-Z0-9]{1,4})*)$/i;

const CONSTRAINT_FIELD_RE =
  /^(LOTSIZE|LOT_SIZE|MIN_LOT|BLD__LINE|BLD_LINE|BUILDING.?LINE|SETBACK|MINBL|MIN_BLD)/i;

const CONSTRAINT_NAME_RE =
  /(minimum lot size|building line|setback only|historic district overlay only)/i;

export function looksLikeDistrictCode(value: unknown): boolean {
  if (value == null) return false;
  const s = String(value).trim();
  if (s.length === 0 || s.length > 24) return false;
  if (/^\d+(\.\d+)?$/.test(s)) return false;
  if (SHORT_DIGIT_FREE_ZONE_RE.test(s)) return true;
  if (EUCLIDEAN_CODE_RE.test(s)) return true;
  return false;
}

export function hasStrongEuclideanCodeEvidence(values: unknown[]): boolean {
  const strong = values
    .map((v) => String(v ?? "").trim())
    .filter((s) => s.length > 0 && (SHORT_DIGIT_FREE_ZONE_RE.test(s) || EUCLIDEAN_CODE_RE.test(s)));
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

function bboxArea(b: Bbox4326): number {
  return Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
}

function bboxOverlap(a: Bbox4326, b: Bbox4326): boolean {
  return !(a.xmax < b.xmin || a.xmin > b.xmax || a.ymax < b.ymin || a.ymin > b.ymax);
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? null;
}

function codeDistribution(values: unknown[]): NonNullable<LayerProbeMeta["codeDistribution"]> {
  const nonBlank = values
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
  const distinct = [...new Set(nonBlank)];
  const lengths = distinct.map((value) => value.length).sort((a, b) => a - b);
  const strongCount = distinct.filter(
    (value) => SHORT_DIGIT_FREE_ZONE_RE.test(value) || EUCLIDEAN_CODE_RE.test(value),
  ).length;
  return {
    distinctCount: distinctCodeLike(distinct).length,
    medianLength: percentile(lengths, 0.5),
    p90Length: percentile(lengths, 0.9),
    strongCodeRatio: distinct.length === 0 ? 0 : strongCount / distinct.length,
    strongDistinctCount: strongCount,
  };
}

export type LayerSignatureInput = {
  layerUrl: string;
  servicePath: string;
  layerId: number;
  name: string;
  geometryType: string | null;
  featureCount: number | null;
  fields: LayerFieldMeta[];
  objectIdField: string | null;
  sampleValues: Record<string, unknown[]>;
  extent: Bbox4326 | null;
  cityBbox: Bbox4326;
  cityCoverageRatio: number | null;
};

export function classifyLayerSignature(input: LayerSignatureInput): LayerProbeMeta {
  const { fields, sampleValues, geometryType, featureCount, name } = input;

  let rejectReason: string | null = null;
  let isConstraintLayer = false;
  let isEuclideanCandidate = false;
  let euclideanScore = 0;
  let distribution: LayerProbeMeta["codeDistribution"] = null;

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
      distribution = codeDistribution(samples);
      if (
        distribution.distinctCount < ZONING_IDENTIFICATION_THRESHOLDS.minDistinctCodes ||
        distribution.distinctCount > ZONING_IDENTIFICATION_THRESHOLDS.maxDistinctCodes
      ) {
        rejectReason = `code-cardinality=${distribution.distinctCount}`;
      } else if (
        distribution.medianLength == null ||
        distribution.medianLength > ZONING_IDENTIFICATION_THRESHOLDS.maxMedianCodeLength ||
        distribution.p90Length == null ||
        distribution.p90Length > ZONING_IDENTIFICATION_THRESHOLDS.maxP90CodeLength
      ) {
        rejectReason = `code-length-distribution=median:${distribution.medianLength},p90:${distribution.p90Length}`;
      } else if (
        distribution.strongCodeRatio < ZONING_IDENTIFICATION_THRESHOLDS.minStrongCodeRatio &&
        distribution.strongDistinctCount < 8
      ) {
        rejectReason = `strong-code-ratio=${distribution.strongCodeRatio.toFixed(3)}`;
      } else if (input.extent && !bboxOverlap(input.extent, input.cityBbox)) {
        rejectReason = "extent-outside-city-bbox";
      } else if (input.extent) {
        const cityArea = bboxArea(input.cityBbox);
        const extentArea = bboxArea(input.extent);
        const extentRatio = cityArea > 0 ? extentArea / cityArea : Number.POSITIVE_INFINITY;
        if (extentRatio > ZONING_IDENTIFICATION_THRESHOLDS.maxExtentToCityAreaRatio) {
          rejectReason = `extent-to-city-area-ratio=${extentRatio.toFixed(3)}`;
        } else if (input.cityCoverageRatio == null) {
          rejectReason = "city-coverage-unverified";
        } else if (
          input.cityCoverageRatio < ZONING_IDENTIFICATION_THRESHOLDS.minCityCoverageRatio
        ) {
          rejectReason = `city-coverage-ratio=${input.cityCoverageRatio.toFixed(3)}`;
        } else {
          isEuclideanCandidate = true;
          // Prefer compact district layers (Deer Park Zoning_WGS84 ~301 / ~18 codes)
          // over basemap FeatureServers with a Zoning attribute (~11k parcels).
          const count = featureCount ?? 0;
          let score = 10 + Math.min(distinct.length, 40);
          if (distinct.length >= 5 && distinct.length <= 40) score += 15;
          // Compact district layers and parcel-joined municipal joins both land
          // under ~20k features. Only giant county basemaps are demoted.
          if (count > 0 && count <= 8000) score += 20;
          else if (count > 8000 && count <= 20000) score += 10;
          else if (count > 20000) score -= 25;
          if (count > 500) score += Math.min(10, Math.floor(count / 500));
          if (codeField && /^code$/i.test(codeField)) score += 8;
          const descField = pickDescriptionField(fields, codeField);
          if (descField) score += 2;
          if (input.cityCoverageRatio != null) {
            score += Math.round(input.cityCoverageRatio * 10);
          }
          euclideanScore = score;
        }
      } else if (input.cityCoverageRatio == null) {
        rejectReason = "city-coverage-unverified";
      } else if (
        input.cityCoverageRatio < ZONING_IDENTIFICATION_THRESHOLDS.minCityCoverageRatio
      ) {
        rejectReason = `city-coverage-ratio=${input.cityCoverageRatio.toFixed(3)}`;
      } else {
        isEuclideanCandidate = true;
        const count = featureCount ?? 0;
        let score = 10 + Math.min(distinct.length, 40);
        if (distinct.length >= 5 && distinct.length <= 40) score += 15;
        if (count > 0 && count <= 8000) score += 20;
        else if (count > 8000 && count <= 20000) score += 10;
        else if (count > 20000) score -= 25;
        if (count > 500) score += Math.min(10, Math.floor(count / 500));
        if (codeField && /^code$/i.test(codeField)) score += 8;
        const descField = pickDescriptionField(fields, codeField);
        if (descField) score += 2;
        if (input.cityCoverageRatio != null) {
          score += Math.round(input.cityCoverageRatio * 10);
        }
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
    objectIdField: input.objectIdField,
    codeField,
    descriptionField,
    extent: input.extent,
    codeDistribution: distribution,
    cityCoverageRatio: input.cityCoverageRatio,
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
