export {
  generateBriefing,
  resolveBriefingLlmMode,
  type GenerateBriefingOptions,
} from "./engine.js";

export {
  type BriefingLlmMode,
  type BriefingSections,
  type BriefingSourceInput,
  type CodeSectionInput,
  type GenerateBriefingInput,
  type GenerateBriefingResult,
  type MaterializableElement,
  type MaterializableSection,
  HEAVY_SECTIONS,
  LIGHT_SECTIONS,
  MATERIALIZABLE_SECTIONS,
  SECTION_LABELS,
} from "./types.js";

export {
  extractMaterializableElements,
  splitSectionClaims,
} from "./materializableElements.js";

export {
  BRIEFING_ANTHROPIC_MODEL,
  BRIEFING_ANTHROPIC_MAX_TOKENS,
  AnthropicGeneratorError,
  callAnthropicGenerator,
  parseAnthropicResponse,
} from "./anthropicGenerator.js";

export {
  BRIEFING_GROK_DEFAULT_MODEL,
  BRIEFING_GROK_MAX_TOKENS,
  callGrokGenerator,
  resolveGrokBriefingModel,
} from "./grokGenerator.js";

export {
  validateSectionCitations,
  type CitationResolvers,
  type CitationScanResult,
} from "./citationValidator.js";

export { generateMockBriefing } from "./mockGenerator.js";

export { BRIEFING_SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

export {
  categorizeLayerKind,
  citationLabel,
  groupSourcesBySection,
  SECTIONS_WITH_NO_CITATIONS,
  SECTIONS_WITH_SOURCE_CITATIONS,
  type SourceCitingSection,
} from "./sourceCategories.js";
