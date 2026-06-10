export {
  generateFindings,
  resolveFindingLlmMode,
  type GenerateFindingsOptions,
} from "./engine.js";

export {
  type BimElementInput,
  type BriefingSourceInput,
  type CodeSectionInput,
  type CodeSectionWebProvenance,
  type ReasoningSourceLink,
  type EngineFinding,
  type FindingCategory,
  type FindingCitation,
  type FindingCodeCitation,
  type FindingLlmMode,
  type FindingSeverity,
  type FindingSourceCitation,
  type FindingStatus,
  type GenerateFindingsInput,
  type GenerateFindingsResult,
  type SubmissionInput,
  FINDING_CATEGORY_VALUES,
  FINDING_SEVERITY_VALUES,
  FINDING_STATUS_VALUES,
  FINDING_MIN_TEXT_LENGTH,
} from "./types.js";

export {
  FINDING_ANTHROPIC_MODEL,
  FINDING_ANTHROPIC_MAX_TOKENS,
  FindingGeneratorError,
  callAnthropicGenerator,
  parseAnthropicResponse,
  type RawFindingDraft,
} from "./anthropicGenerator.js";

export {
  FINDING_GROK_DEFAULT_MODEL,
  FINDING_GROK_MAX_TOKENS,
  callGrokGenerator,
  resolveGrokFindingModel,
} from "./grokGenerator.js";

export {
  validateInlineCitations,
  type CitationResolvers,
  type CitationScanResult,
} from "./citationAdapter.js";

export { generateMockFindings } from "./mockGenerator.js";

export {
  FINDING_SYSTEM_PROMPT,
  buildUserPrompt,
  PROMPT_NARRATIVE_MAX_CHARS,
  PROMPT_CODE_SNIPPET_MAX_CHARS,
} from "./prompt.js";

export {
  FINDING_VISION_ANTHROPIC_MODEL,
  FINDING_VISION_MAX_SHEETS_PER_PASS,
  runDisciplineVisionRead,
  enrichPiecesWithVisionObservations,
  type AttachedSheetImage,
  type VisionSheetReadResult,
} from "./visionSheetRead.js";

export {
  generateOrchestratedFindings,
  resolveFindingOrchestratedMode,
  classifyPlanSetPiece,
  classifyPlanSetPieces,
  filterCodeSectionsForDiscipline,
  disciplineRetrievalQuery,
  type GenerateOrchestratedFindingsInput,
  type GenerateOrchestratedFindingsResult,
  type PlanSetPieceCandidate,
  type PlanSetPieceInput,
} from "./planSet/orchestrator.js";

export {
  reconcileStandardPrecedence,
  reconcileRequirementsByTopic,
  formatPrecedenceFindingText,
  compareStringency,
  pickMostStringent,
  allAlign,
  detectStandardDescriptor,
  codeSectionToRequirementShell,
  buildAdaFhaA117DoorClearanceRequirements,
  buildLocalAmendmentOverlayRequirement,
  buildFederalPreemptPair,
  ADA_DOOR_CLEARANCE_ATOM_ID,
  FHA_DOOR_CLEARANCE_ATOM_ID,
  A1171_DOOR_CLEARANCE_ATOM_ID,
  type ApplicableRequirement,
  type PrecedenceConflict,
  type PrecedenceDomain,
  type PrecedenceReconciliationResult,
  type PrecedenceRuleApplied,
  type ReconcileRequirementsByTopicInput,
  type ReconcileRequirementsByTopicResult,
  type ReconcileStandardPrecedenceOptions,
  type RequirementKind,
  type StandardAuthority,
  type StandardDescriptor,
} from "./precedence/index.js";
