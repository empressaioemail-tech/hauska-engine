/**
 * Factory 1.5 L2 — catalogue-driven zoning layer discovery.
 */

export {
  OUTCOME_STATUSES,
  LANDED_OUTCOME_STATUSES,
  NON_LANDED_REENTER_STATUSES,
  isOutcomeStatus,
  isLandedOutcome,
  isReenterOutcome,
  assertOutcomeStatus,
  type OutcomeStatus,
} from "./outcomes.js";

export {
  RUNNER_VERSION,
  type Bbox4326,
  type ClassifiedVerdict,
  type DiscoveryProbeEvidence,
  type HostCatalogue,
  type HostCatalogueEntry,
  type JurisdictionKind,
  type LayerFieldMeta,
  type LayerProbeMeta,
  type QueueItem,
  type SearchPathAttempt,
  type SearchPathSource,
} from "./types.js";

export {
  loadHostCatalogue,
  catalogueBaseUrls,
  findCatalogueHost,
  looksLikeSlugSynthesizedHost,
  resolveSeedHostUrls,
  resolveCatalogueHostUrls,
  resolveHostUrlsForQueueItem,
  searchArcGisHubForCity,
  searchTxGioCkanForCity,
  type ResolvedHost,
} from "./catalogue.js";

export {
  recurseArcGisRestFolders,
  recurseArcGisRestFoldersFromFixtures,
  mapLayerFields,
  type ArcGisFolderJson,
  type ArcGisLayerJson,
  type FolderRecurseOptions,
  type FolderRecurseResult,
  type ServiceLayerRef,
} from "./folder-recurse.js";

export {
  classifyLayerSignature,
  isBuildingLineOnlyLayer,
  isConstraintFieldName,
  isLotSizeOnlyLayer,
  looksLikeDistrictCode,
  rankEuclideanCandidates,
  type LayerSignatureInput,
} from "./layer-signature.js";

export { classifyDiscoveryEvidence, statusFromString } from "./classify.js";

export { discoverZoningForCity, type DiscoverOptions } from "./discover.js";

export {
  buildRegistryEntryFromDiscovery,
  stageDiscoveredLayer,
  type StageDiscoveredOptions,
  type StageDiscoveredReport,
} from "./stage-discovered.js";
