/**
 * @hauska-engine/engine-core — reasoning engines (ADR-008 step 4 / GTM A2).
 */

export * as briefing from "./briefing/index.js";
export * as finding from "./finding/index.js";

export { MIN_DENSE_SIGNAL, CALIBRATION_PRIOR_WEIGHT } from "./calibration/constants.js";
export type {
  CalibrationStamp,
  CalibrationSignal,
  OverlayCalibrationRow,
  AttributionCoverageHealth,
} from "./calibration/types.js";
export {
  assertedBaselineFromSourceType,
  atomClassFromCodeRef,
} from "./calibration/corpusBaseline.js";
export {
  partitionForSignal,
  isPublicPoolEligible,
  tenantMayReadOverlay,
  type OverlayAccessPolicy,
} from "./calibration/partition.js";
export { stampsMatch, stampFromFields } from "./calibration/stamp.js";
export {
  computePartitionCalibration,
  type AggregatedCalibration,
} from "./calibration/compute.js";
export { FINDING_OUTCOME_RECORDED_EVENT_TYPE } from "./calibration/findingOutcomeEventType.js";
export {
  canonicalOverlayAtomKey,
  canonicalOverlayKeyFromCodeToken,
  isReasoningOverlayAtomId,
  overlayAtomLookupKey,
  HAUSKA_CODE_SECTION_DID_PREFIX,
} from "./calibration/overlayAtomKey.js";
export type {
  CalibrationRepositoryPort,
  OverlayRowRecord,
  JurisdictionTenantResolver,
} from "./calibration/ports.js";
export { InMemoryCalibrationRepository } from "./calibration/inMemoryPorts.js";
export {
  effectiveConfidence,
  recomputeCalibrationOverlay,
  ensureCorpusOverlayRow,
  resolveOverlayCalibration,
  listOverlayRows,
  resolveOverlayKeyFromStructuredRef,
  seedReasoningOverlayFromAtom,
  invalidateStaleCalibrationForAtom,
} from "./calibration/overlay.js";
export {
  computeSectionDependentsClosure,
  invalidateStaleCalibrationForSectionChange,
  type SectionInvalidationResult,
} from "./calibration/sectionInvalidation.js";
export {
  AMENDMENT_HAZARD_COLD_START_PRIOR,
  computeAmendmentHazardRate,
  validityDecayFromHazard,
  type AmendmentHazardRate,
  type HazardRateSource,
} from "./calibration/hazard.js";
export {
  collectCalibrationSignals,
  loadAtomAccessContexts,
} from "./calibration/signals.js";
export { computeAttributionCoverage } from "./calibration/attribution.js";

export * as siteTopography from "./site-topography/index.js";
export * as registry from "./registry/index.js";
export * as envelope from "./envelope/index.js";
export {
  sealEnvelope,
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
  engineEnvelopeSchema,
  type EngineEnvelope,
  type SealEnvelopeMeta,
  type EnvelopeConfidence,
  type EnvelopeCoverage,
  type EnvelopeSource,
  type ConfidenceKind,
} from "./envelope/index.js";

export {
  createGrokClient,
  GrokApiError,
  type GrokClient,
  type GrokChatCompletionParams,
} from "./llm/grok.js";

export {
  PLAN_REVIEW_DISCIPLINE_VALUES,
  isPlanReviewDiscipline,
  type PlanReviewDiscipline,
} from "./types/planReviewDiscipline.js";

export * as mapLayers from "./map-layers/index.js";
export * as propertyReasoning from "./property-reasoning/index.js";
export {
  MAP_LAYER_KEYS,
  MAP_LAYERS_PACKAGE_ID,
  mapLayersAssembleRequestSchema,
  assembleMapLayers,
  aggregateMapLayersCoverage,
  vintageFromMapLayers,
  type MapLayerKey,
  type MapLayerSlot,
  type MapLayersAssembleRequest,
  type MapLayersAssemblePayload,
} from "./map-layers/index.js";
