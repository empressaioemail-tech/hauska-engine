/**
 * Rule-based plan-set piece classifier (WS1).
 *
 * Maps each ingested sheet (by number/name + OCR text) and attached
 * document (by type/title/text) onto the closed `PlanReviewDiscipline`
 * set. Deterministic — no LLM call — so mock/orchestrated paths behave
 * identically in dev/CI.
 */

import {
  type PlanReviewDiscipline,
  isPlanReviewDiscipline,
} from "../../types/planReviewDiscipline.js";
import type {
  PlanSetPieceCandidate,
  PlanSetPieceClassificationResult,
} from "./types";

/** Normalize sheet numbers for prefix matching (`A-101` → `A101`). */
export function normalizeSheetNumber(raw: string): string {
  return raw.replace(/[\s._-]/g, "").toUpperCase();
}

/** Extract the discipline letter-prefix from a normalized sheet number. */
export function sheetNumberPrefix(normalized: string): string {
  const m = /^([A-Z]+)/.exec(normalized);
  return m?.[1] ?? "";
}

const PREFIX_TO_DISCIPLINE: ReadonlyArray<{
  prefixes: readonly string[];
  discipline: PlanReviewDiscipline;
  confidence: number;
}> = [
  { prefixes: ["FP", "FS", "FA"], discipline: "fire-life-safety", confidence: 0.9 },
  { prefixes: ["EE", "E"], discipline: "electrical", confidence: 0.88 },
  { prefixes: ["ME", "MH", "M"], discipline: "mechanical", confidence: 0.88 },
  { prefixes: ["P", "PL"], discipline: "plumbing", confidence: 0.85 },
  { prefixes: ["A", "AD", "AR", "AI"], discipline: "building", confidence: 0.82 },
  { prefixes: ["S", "SD", "ST"], discipline: "building", confidence: 0.8 },
  { prefixes: ["C", "L", "LS", "Z"], discipline: "building", confidence: 0.75 },
  { prefixes: ["R"], discipline: "residential", confidence: 0.78 },
];

const KEYWORD_DISCIPLINE: ReadonlyArray<{
  pattern: RegExp;
  discipline: PlanReviewDiscipline;
  confidence: number;
}> = [
  {
    pattern: /\b(ada|a117|accessibility|accessible route|grab bar)\b/i,
    discipline: "accessibility",
    confidence: 0.86,
  },
  {
    pattern: /\b(fire|sprinkler|alarm|egress|nfpa|ifc)\b/i,
    discipline: "fire-life-safety",
    confidence: 0.84,
  },
  {
    pattern: /\b(electrical|panel|lighting|power plan|nec)\b/i,
    discipline: "electrical",
    confidence: 0.83,
  },
  {
    pattern: /\b(mechanical|hvac|ventilation|duct)\b/i,
    discipline: "mechanical",
    confidence: 0.83,
  },
  {
    pattern: /\b(plumbing|sanitary|domestic water|sewer)\b/i,
    discipline: "plumbing",
    confidence: 0.83,
  },
  {
    pattern: /\b(structural|foundation|framing|beam|column)\b/i,
    discipline: "building",
    confidence: 0.8,
  },
  {
    pattern: /\b(zoning|setback|site plan|civil|grading)\b/i,
    discipline: "building",
    confidence: 0.78,
  },
];

const ATTACHED_DOC_TYPE_DISCIPLINE: Readonly<
  Record<string, { discipline: PlanReviewDiscipline; confidence: number }>
> = {
  calculation: { discipline: "building", confidence: 0.7 },
  specification: { discipline: "building", confidence: 0.65 },
  "product-data": { discipline: "mechanical", confidence: 0.6 },
  narrative: { discipline: "building", confidence: 0.6 },
};

function classifyFromKeywords(
  haystack: string,
): PlanSetPieceClassificationResult["discipline"] | null {
  for (const rule of KEYWORD_DISCIPLINE) {
    if (rule.pattern.test(haystack)) return rule.discipline;
  }
  return null;
}

function keywordConfidence(discipline: PlanReviewDiscipline): number {
  return (
    KEYWORD_DISCIPLINE.find((r) => r.discipline === discipline)?.confidence ??
    0.7
  );
}

/**
 * Classify one plan-set piece onto a `PlanReviewDiscipline`. Falls back
 * to `building` at low confidence when no signal matches.
 */
export function classifyPlanSetPiece(
  candidate: PlanSetPieceCandidate,
): PlanSetPieceClassificationResult {
  const textParts = [candidate.label, candidate.text ?? ""].filter(Boolean);
  const haystack = textParts.join("\n");

  if (candidate.kind === "sheet" && candidate.sheetNumber) {
    const normalized = normalizeSheetNumber(candidate.sheetNumber);
    const prefix = sheetNumberPrefix(normalized);
    for (const rule of PREFIX_TO_DISCIPLINE) {
      for (const p of rule.prefixes) {
        if (prefix.startsWith(p) || normalized.startsWith(p)) {
          const keywordHit = classifyFromKeywords(haystack);
          if (keywordHit && keywordHit !== rule.discipline) {
            return {
              pieceId: candidate.pieceId,
              kind: candidate.kind,
              discipline: keywordHit,
              confidence: keywordConfidence(keywordHit),
              source: "rule",
            };
          }
          return {
            pieceId: candidate.pieceId,
            kind: candidate.kind,
            discipline: rule.discipline,
            confidence: rule.confidence,
            source: "rule",
          };
        }
      }
    }
  }

  if (candidate.kind === "attached-document" && candidate.documentType) {
    const mapped = ATTACHED_DOC_TYPE_DISCIPLINE[candidate.documentType];
    if (mapped) {
      const keywordHit = classifyFromKeywords(haystack);
      if (keywordHit) {
        return {
          pieceId: candidate.pieceId,
          kind: candidate.kind,
          discipline: keywordHit,
          confidence: keywordConfidence(keywordHit),
          source: "rule",
        };
      }
      return {
        pieceId: candidate.pieceId,
        kind: candidate.kind,
        discipline: mapped.discipline,
        confidence: mapped.confidence,
        source: "rule",
      };
    }
  }

  const keywordHit = classifyFromKeywords(haystack);
  if (keywordHit) {
    return {
      pieceId: candidate.pieceId,
      kind: candidate.kind,
      discipline: keywordHit,
      confidence: keywordConfidence(keywordHit),
      source: "rule",
    };
  }

  return {
    pieceId: candidate.pieceId,
    kind: candidate.kind,
    discipline: "building",
    confidence: 0.5,
    source: "rule",
  };
}

/** Classify a batch of pieces; de-duplicates by pieceId (last wins). */
export function classifyPlanSetPieces(
  candidates: ReadonlyArray<PlanSetPieceCandidate>,
): PlanSetPieceClassificationResult[] {
  const out: PlanSetPieceClassificationResult[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.pieceId)) continue;
    seen.add(c.pieceId);
    const result = classifyPlanSetPiece(c);
    if (!isPlanReviewDiscipline(result.discipline)) continue;
    out.push(result);
  }
  return out;
}

/** Merge classification results onto candidate metadata. */
export function toPlanSetPieceInputs(
  candidates: ReadonlyArray<PlanSetPieceCandidate>,
  classifications: ReadonlyArray<PlanSetPieceClassificationResult>,
): import("./types").PlanSetPieceInput[] {
  const byId = new Map(classifications.map((c) => [c.pieceId, c]));
  const inputs: import("./types").PlanSetPieceInput[] = [];
  for (const candidate of candidates) {
    const hit = byId.get(candidate.pieceId);
    if (!hit) continue;
    inputs.push({
      pieceId: candidate.pieceId,
      kind: candidate.kind,
      label: candidate.label,
      text: candidate.text,
      discipline: hit.discipline,
      confidence: hit.confidence,
    });
  }
  return inputs;
}

/** Group classified pieces by discipline (stable insertion order). */
export function groupPiecesByDiscipline(
  pieces: ReadonlyArray<import("./types").PlanSetPieceInput>,
): Map<PlanReviewDiscipline, import("./types").PlanSetPieceInput[]> {
  const map = new Map<PlanReviewDiscipline, import("./types").PlanSetPieceInput[]>();
  for (const piece of pieces) {
    const list = map.get(piece.discipline) ?? [];
    list.push(piece);
    map.set(piece.discipline, list);
  }
  return map;
}
