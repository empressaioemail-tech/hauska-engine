/**
 * Plan-set piece classification + orchestrated finding-engine types (WS1).
 */

import type { PlanReviewDiscipline } from "../../types/planReviewDiscipline.js";

/** One classified sheet or attached-document piece in a submission. */
export interface PlanSetPieceInput {
  pieceId: string;
  kind: "sheet" | "attached-document";
  /** Display label — sheet number + name, or document title. */
  label: string;
  /** OCR / extracted text body when available. */
  text: string | null;
  discipline: PlanReviewDiscipline;
  /** Classifier confidence on 0..1 scale. */
  confidence: number;
}

/** Raw inputs the classifier consumes (no discipline yet). */
export interface PlanSetPieceCandidate {
  pieceId: string;
  kind: PlanSetPieceInput["kind"];
  label: string;
  text: string | null;
  /** Optional sheet number prefix for rule-based routing. */
  sheetNumber?: string | null;
  /** Attached-document type when kind === attached-document. */
  documentType?: string | null;
}

/** Outcome of classifying one piece. */
export interface PlanSetPieceClassificationResult {
  pieceId: string;
  kind: PlanSetPieceInput["kind"];
  discipline: PlanReviewDiscipline;
  confidence: number;
  source: "rule" | "llm";
}

/** Aggregated orchestrated run metadata surfaced on {@link GenerateFindingsResult}. */
export interface OrchestratedRunMetadata {
  orchestrated: true;
  disciplinesRun: ReadonlyArray<PlanReviewDiscipline>;
  pieceCount: number;
  deduplicatedCount: number;
}
