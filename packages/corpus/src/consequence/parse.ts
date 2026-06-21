import type {
  Asce7RiskCategory,
  ConsequenceClassificationInputs,
  ConsequenceSourceSpan,
} from "./types.js";

const ASCE7_RISK_PATTERN =
  /risk\s+categor(?:y|ies)\s*(?:of\s*)?(I{1,3}|IV)\b/gi;

const ASCE7_CATEGORY_NEAR_STRUCTURE =
  /categor(?:y|ies)\s*(I{1,3}|IV)\b[^.\n]{0,80}\b(?:structure|building|occupanc)/gi;

const IBC_OCCUPANCY_GROUP_PATTERN =
  /occupancy\s+group[s]?\s+([A-Z](?:-\d+)?(?:\s*,\s*[A-Z](?:-\d+)?)*)/gi;

const IBC_GROUP_CLASSIFICATION_PATTERN =
  /\bgroup\s+([A-Z](?:-\d+)?)\b[^.\n]{0,60}\b(?:occupanc|classification)/gi;

const IBC_IMPORTANCE_FACTOR_PATTERN =
  /importance\s+factor[s]?\s*(?:of\s*)?(1\.0|1\.00|1\.25|1\.5|1\.50)\b/gi;

const IBC_IE_PATTERN = /\bI[eE]\s*=\s*(1\.0|1\.00|1\.25|1\.5|1\.50)\b/g;

function normalizeRiskCategory(raw: string): Asce7RiskCategory | null {
  const upper = raw.toUpperCase();
  if (upper === "I") return "I";
  if (upper === "II") return "II";
  if (upper === "III") return "III";
  if (upper === "IV") return "IV";
  return null;
}

function normalizeImportanceFactor(raw: string): string {
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return raw;
  if (n === 1) return "1.0";
  if (n === 1.25) return "1.25";
  if (n === 1.5) return "1.5";
  return String(n);
}

function excerptAround(text: string, index: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function collectMatches(
  text: string,
  pattern: RegExp,
  mapValue: (raw: string) => string | null,
): Array<{ value: string; excerpt: string }> {
  const out: Array<{ value: string; excerpt: string }> = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    for (const part of raw.split(/\s*,\s*/)) {
      const value = mapValue(part.trim());
      if (!value) continue;
      out.push({
        value,
        excerpt: excerptAround(text, match.index),
      });
    }
  }
  return out;
}

function dedupeSorted(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Parse ASCE 7 / IBC classification inputs from section body prose.
 * Returns undefined when no inputs are found.
 */
export function parseConsequenceInputsFromProse(
  bodyText: string,
): ConsequenceClassificationInputs | undefined {
  if (!bodyText.trim()) return undefined;

  const sourceSpans: ConsequenceSourceSpan[] = [];
  const asceValues: string[] = [];
  const occValues: string[] = [];
  const impValues: string[] = [];

  for (const { value, excerpt } of collectMatches(
    bodyText,
    ASCE7_RISK_PATTERN,
    (raw) => normalizeRiskCategory(raw),
  )) {
    asceValues.push(value);
    sourceSpans.push({ field: "asce7RiskCategories", excerpt });
  }

  for (const { value, excerpt } of collectMatches(
    bodyText,
    ASCE7_CATEGORY_NEAR_STRUCTURE,
    (raw) => normalizeRiskCategory(raw),
  )) {
    asceValues.push(value);
    sourceSpans.push({ field: "asce7RiskCategories", excerpt });
  }

  for (const { value, excerpt } of collectMatches(
    bodyText,
    IBC_OCCUPANCY_GROUP_PATTERN,
    (raw) => raw.toUpperCase(),
  )) {
    occValues.push(value);
    sourceSpans.push({ field: "ibcOccupancyGroups", excerpt });
  }

  for (const { value, excerpt } of collectMatches(
    bodyText,
    IBC_GROUP_CLASSIFICATION_PATTERN,
    (raw) => raw.toUpperCase(),
  )) {
    occValues.push(value);
    sourceSpans.push({ field: "ibcOccupancyGroups", excerpt });
  }

  for (const { value, excerpt } of collectMatches(
    bodyText,
    IBC_IMPORTANCE_FACTOR_PATTERN,
    (raw) => normalizeImportanceFactor(raw),
  )) {
    impValues.push(value);
    sourceSpans.push({ field: "ibcImportanceFactors", excerpt });
  }

  for (const { value, excerpt } of collectMatches(
    bodyText,
    IBC_IE_PATTERN,
    (raw) => normalizeImportanceFactor(raw),
  )) {
    impValues.push(value);
    sourceSpans.push({ field: "ibcImportanceFactors", excerpt });
  }

  const asce7RiskCategories = dedupeSorted(asceValues) as Asce7RiskCategory[];
  const ibcOccupancyGroups = dedupeSorted(occValues);
  const ibcImportanceFactors = dedupeSorted(impValues);

  if (
    asce7RiskCategories.length === 0 &&
    ibcOccupancyGroups.length === 0 &&
    ibcImportanceFactors.length === 0
  ) {
    return undefined;
  }

  return {
    ...(asce7RiskCategories.length > 0 ? { asce7RiskCategories } : {}),
    ...(ibcOccupancyGroups.length > 0 ? { ibcOccupancyGroups } : {}),
    ...(ibcImportanceFactors.length > 0 ? { ibcImportanceFactors } : {}),
    ...(sourceSpans.length > 0 ? { sourceSpans } : {}),
    parsedAt: new Date().toISOString(),
  };
}
