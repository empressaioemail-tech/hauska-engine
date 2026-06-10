/**
 * Orchestrated plan-set decomposition conductor (WS1).
 *
 * Classifies ingested pieces by discipline, runs a specialist finding
 * pass per discipline present, then re-aggregates + deduplicates while
 * preserving citation/confidence/atomId lineage from each pass.
 */

import type { PlanReviewDiscipline } from "../../types/planReviewDiscipline.js";
import { generateFindings, type GenerateFindingsOptions } from "../engine";
import type {
  GenerateFindingsInput,
  GenerateFindingsResult,
} from "../types";
import {
  enrichPiecesWithVisionObservations,
  runDisciplineVisionRead,
} from "../visionSheetRead";
import {
  classifyPlanSetPieces,
  groupPiecesByDiscipline,
  toPlanSetPieceInputs,
} from "./classifier";
import { deduplicateFindings } from "./dedupe";
import { filterCodeSectionsForDiscipline } from "./disciplineScope";
import type {
  OrchestratedRunMetadata,
  PlanSetPieceCandidate,
  PlanSetPieceInput,
} from "./types";

export interface GenerateOrchestratedFindingsInput {
  baseInput: GenerateFindingsInput;
  pieceCandidates: ReadonlyArray<PlanSetPieceCandidate>;
}

export interface GenerateOrchestratedFindingsResult extends GenerateFindingsResult {
  orchestration: OrchestratedRunMetadata;
}

/** Feature flag: orchestrated per-discipline path vs legacy single-pass. */
export function resolveFindingOrchestratedMode(): boolean {
  const raw = (process.env.AIR_FINDING_ORCHESTRATED ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function buildSpecialistInput(
  base: GenerateFindingsInput,
  discipline: PlanReviewDiscipline,
  pieces: ReadonlyArray<PlanSetPieceInput>,
): GenerateFindingsInput {
  return {
    ...base,
    codeSections: filterCodeSectionsForDiscipline(
      discipline,
      base.codeSections,
    ),
    planSetPieces: pieces,
    disciplineScope: discipline,
  };
}

/**
 * Run the orchestrated conductor: classify → per-discipline specialist
 * passes → re-aggregate. Returns an empty findings list when no pieces
 * are supplied — callers should fall back to the legacy single-pass path.
 */
export async function generateOrchestratedFindings(
  input: GenerateOrchestratedFindingsInput,
  options: GenerateFindingsOptions = {},
): Promise<GenerateOrchestratedFindingsResult> {
  const classifications = classifyPlanSetPieces(input.pieceCandidates);
  const pieces = toPlanSetPieceInputs(input.pieceCandidates, classifications);
  const byDiscipline = groupPiecesByDiscipline(pieces);
  const disciplinesRun = [...byDiscipline.keys()];

  const allFindings: GenerateFindingsResult["findings"] = [];
  const invalidCitations: string[] = [];
  const discardedFindings: GenerateFindingsResult["discardedFindings"][number][] = [];
  let producer: GenerateFindingsResult["producer"] = "mock";
  const generatedAt = options.now?.() ?? new Date();

  for (const [discipline, disciplinePieces] of byDiscipline) {
    let piecesForPass = disciplinePieces;
    const scopedCodeSections = filterCodeSectionsForDiscipline(
      discipline,
      input.baseInput.codeSections,
    );
    const sheetImages = input.baseInput.attachedSheetImages ?? [];
    if (options.visionAnthropicClient && sheetImages.length > 0) {
      const vision = await runDisciplineVisionRead(options.visionAnthropicClient, {
        discipline,
        pieces: disciplinePieces,
        images: sheetImages,
        codeSections: scopedCodeSections,
        log: options.visionLog,
      });
      if (vision?.observations) {
        piecesForPass = enrichPiecesWithVisionObservations(
          disciplinePieces,
          vision.observations,
        );
      }
    }

    const specialistInput = buildSpecialistInput(
      input.baseInput,
      discipline,
      piecesForPass,
    );
    const pass = await generateFindings(specialistInput, options);
    producer = pass.producer;
    for (const f of pass.findings) {
      allFindings.push({ ...f, discipline });
    }
    invalidCitations.push(...pass.invalidCitations);
    discardedFindings.push(...pass.discardedFindings);
  }

  const { findings, deduplicatedCount } = deduplicateFindings(allFindings);

  return {
    findings,
    invalidCitations,
    discardedFindings,
    generatedAt,
    producer,
    orchestration: {
      orchestrated: true,
      disciplinesRun,
      pieceCount: pieces.length,
      deduplicatedCount,
    },
  };
}

export {
  classifyPlanSetPiece,
  classifyPlanSetPieces,
  groupPiecesByDiscipline,
  normalizeSheetNumber,
  sheetNumberPrefix,
  toPlanSetPieceInputs,
} from "./classifier";
export {
  deduplicateFindings,
  normalizeFindingText,
} from "./dedupe";
export {
  DISCIPLINE_RETRIEVAL_QUERY,
  disciplineRetrievalQuery,
  filterCodeSectionsForDiscipline,
} from "./disciplineScope";
export type {
  OrchestratedRunMetadata,
  PlanSetPieceCandidate,
  PlanSetPieceClassificationResult,
  PlanSetPieceInput,
} from "./types";
